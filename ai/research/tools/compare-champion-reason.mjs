/** Evaluation only: frozen raw or champion/endgame-student policy versus reason9001. */
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { constants, freemem, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import {
  createReasonBot,
  emptyTally,
  closeTally,
  searchSeedOf,
} from '../../danMCai/belief/reason-match-eval.mjs';
import { championValues } from '../../../web/src/ai/search/inference.mjs';
import { SEARCH_BUDGETS } from '../../../web/src/ai/search/constants.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import {
  argmax,
  option,
  readJSON,
  sha256,
  writeJSON,
} from '../../danMCai/training/continuous/lib.mjs';
import { windowPlan } from '../../danMCai/training/continuous/windows-window.mjs';
import { clusterInterval } from './window-dashboard.mjs';

const SELF = fileURLToPath(import.meta.url);
const stopped = (root) =>
  existsSync(join(root, 'STOP')) ||
  Date.now() >= Date.parse(readJSON(join(root, 'registration.json')).deadlineUTC);
const stop = (root, reason) => {
  if (!existsSync(join(root, 'STOP')))
    writeJSON(join(root, 'STOP'), { reason, atUTC: new Date().toISOString() });
};
const log = (root, text) =>
  appendFileSync(join(root, 'stages.log'), `${new Date().toISOString()} ${text}\n`);

/** Matches endgame/evaluate.mjs student mode; scorers see only the public policy state. */
export function studentChallenger(champion, student, threshold = 32) {
  if (threshold !== 32) throw Error('This comparison freezes the trained32-card policy');
  return async (game, p) => {
    const plays = candidates(game.hands[p], game.L, game.trick?.play);
    if (!plays.length) throw Error('No candidates');
    const finish = plays.find((play) => play && play.cards.length === game.hands[p].length);
    if (finish) return finish;
    if (plays.length === 1) return plays[0];
    const state = policyState(game, p, 0, plays);
    const scorer = game.hands.reduce((n, h) => n + h.length, 0) <= threshold ? student : champion;
    return plays[argmax(await scorer(state))];
  };
}

export async function comparisonRound({ seed, team, raw, reason, checkpoint = async () => {} }) {
  if (![0, 1].includes(team)) throw Error('Invalid team');
  const game = createRound(seed),
    tally = emptyTally();
  game.tok = `raw-reason:${seed}:${team}`;
  const initial = {
    dealSHA256: createHash('sha256')
      .update(JSON.stringify(game.hands.map((h) => h.map((c) => c.id))))
      .digest('hex'),
    level: game.L,
    leader: game.turn,
  };
  const seats = [0, 1, 2, 3].map((p) => (p % 2 === team ? 'challenger' : 'reason'));
  let rawMs = 0,
    reasonMs = 0,
    rawDecisions = 0;
  for (let turn = 0; turn < 1000; turn++) {
    await checkpoint();
    const p = game.turn,
      start = performance.now();
    let play;
    if (p % 2 === team) {
      play = await raw(game, p);
      rawMs += performance.now() - start;
      rawDecisions++;
    } else {
      play = await reason.decide(game, p, { searchSeed: searchSeedOf(seed) }, tally);
      reasonMs += performance.now() - start;
    }
    await checkpoint();
    const result = advanceRound(game, play);
    if (result)
      return {
        team,
        seats,
        ...initial,
        ...result,
        turns: turn + 1,
        signedPoints: result.points * (result.winner === team ? 1 : -1),
        reason: closeTally(tally),
        timing: { rawMs, reasonMs, rawDecisions },
      };
  }
  throw Error('Round truncated; never count as draw');
}

export function pairedRows(rows, protocolSHA256, seeds) {
  const seen = new Set(),
    allowed = new Set(seeds);
  for (const r of rows) {
    if (
      r.protocolSHA256 !== protocolSHA256 ||
      !allowed.has(r.seed) ||
      seen.has(r.seed) ||
      r.games?.length !== 2
    )
      throw Error('Invalid/repeated pair');
    seen.add(r.seed);
    if (
      r.games[0].team !== 0 ||
      r.games[1].team !== 1 ||
      new Set(r.games.map((g) => `${g.dealSHA256}:${g.level}:${g.leader}`)).size !== 1
    )
      throw Error('Pairing changed');
  }
  return rows;
}
function verify(root) {
  const p = readJSON(join(root, 'protocol.json'));
  for (const [f, h] of Object.entries(p.sourceSHA256))
    if (sha256(join(p.sourceRoot, f)) !== h) throw Error('Frozen source changed:' + f);
  for (const m of Object.values(p.models))
    if (sha256(m.localFile) !== m.sha256) throw Error('Frozen weights changed');
  return p;
}
async function watch(root) {
  const reg = readJSON(join(root, 'registration.json'));
  while (!existsSync(join(root, 'FINISHED'))) {
    const changed = sha256(join(root, 'protocol.json')) !== reg.protocolSHA256;
    if (changed || stopped(root))
      stop(root, changed ? 'protocol-changed' : 'fixed-evaluation-deadline');
    writeJSON(join(root, 'guardian-status.json'), {
      pid: process.pid,
      updatedAtUTC: new Date().toISOString(),
      deadlineUTC: reg.deadlineUTC,
      stopped: existsSync(join(root, 'STOP')),
    });
    if (existsSync(join(root, 'STOP'))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function worker(root, slot) {
  const plan = verify(root),
    reg = readJSON(join(root, 'registration.json'));
  if (reg.protocolSHA256 !== sha256(join(root, 'protocol.json')))
    throw Error('Unregistered evaluation');
  if (!Number.isInteger(slot) || slot < 0 || slot >= plan.workers)
    throw Error('Invalid worker slot');
  const output = join(root, `worker-${slot}.jsonl`),
    lock = join(root, `worker-${slot}.lock`);
  if (existsSync(output)) throw Error('Never replay existing output');
  closeSync(openSync(lock, 'wx'));
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  const status = {
    pid: process.pid,
    phase: 'initializing',
    completedPairs: 0,
    protocolSHA256: reg.protocolSHA256,
  };
  const save = () =>
    writeJSON(join(root, `worker-${slot}.json`), {
      ...status,
      updatedAtUTC: new Date().toISOString(),
    });
  const sessions = [];
  const checkpoint = async () => {
    if (freemem() < 4 * 1024 ** 3)
      while (freemem() < 5 * 1024 ** 3 && !stopped(root)) {
        status.phase = 'memory-paused';
        save();
        await new Promise((r) => setTimeout(r, 1000));
      }
    if (stopped(root)) throw Error('STOP');
  };
  try {
    save();
    const hybrid = plan.challengerPolicy?.kind === 'endgame-student';
    if (plan.challengerPolicy && !hybrid) throw Error('Unknown challenger policy');
    for (const key of ['challenger', 'reason', 'belief', ...(hybrid ? ['student'] : [])])
      sessions.push(
        await ort.InferenceSession.create(plan.models[key].localFile, {
          executionProviders: ['cpu'],
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
          enableCpuMemArena: false,
          enableMemPattern: false,
        }),
      );
    const values = championValues(ort, sessions[0]);
    const raw = hybrid
      ? studentChallenger(values, championValues(ort, sessions[3]), plan.challengerPolicy.threshold)
      : async (game, p) => {
          const plays = candidates(game.hands[p], game.L, game.trick?.play);
          if (!plays.length) throw Error('No candidates');
          if (plays.length === 1) return plays[0];
          const q = await values(policyState(game, p, 0, plays));
          return plays[argmax(q)];
        };
    const budget = { ...SEARCH_BUDGETS.desktop };
    const check = async () => {
      await checkpoint();
      budget.midgameMs = budget.endgameMs = Math.min(
        50000,
        Date.parse(reg.deadlineUTC) - Date.now(),
      );
    };
    for (let i = slot; i < plan.tasks[0].seeds.length; i += plan.workers) {
      await check();
      status.phase = 'running';
      save();
      const seed = plan.tasks[0].seeds[i],
        games = [];
      for (const team of [0, 1]) {
        const reason = createReasonBot({
          ort,
          championSession: sessions[1],
          beliefSession: sessions[2],
          budget,
        });
        games.push(await comparisonRound({ seed, team, raw, reason, checkpoint: check }));
        // Each independent round starts cold. Drop solver/legality caches before the next deal.
        reason.engine.solver = null;
        global.gc?.();
      }
      const row = { task: 'head-to-head', seed, protocolSHA256: reg.protocolSHA256, games };
      pairedRows([row], reg.protocolSHA256, [seed]);
      appendFileSync(output, JSON.stringify(row) + '\n');
      appendFileSync(join(root, 'panel', `part-${slot}.jsonl`), JSON.stringify(row) + '\n');
      status.completedPairs++;
      save();
    }
    status.phase = 'complete';
  } catch (e) {
    status.phase = stopped(root) ? 'stopped' : 'failed';
    status.error = String(e.stack || e);
    if (status.phase === 'failed') stop(root, 'worker-failed');
  } finally {
    save();
    for (const s of sessions) await s.release();
    unlinkSync(lock);
  }
}

async function main(root) {
  const plan = verify(root),
    protocolSHA256 = sha256(join(root, 'protocol.json'));
  if (existsSync(join(root, 'STOP')) || existsSync(join(root, 'FINISHED')))
    throw Error('Evaluation stopped or already finished');
  const file = join(root, 'registration.json'),
    previous = readJSON(file);
  if (previous && previous.protocolSHA256 !== protocolSHA256) throw Error('Protocol changed');
  const { schedule } = windowPlan(previous, 3);
  if (!previous)
    writeJSON(file, {
      ...schedule,
      protocolSHA256,
      purpose: 'New owner-authorized evaluation only; not reopening expired training',
    });
  const lock = join(root, 'controller.lock');
  closeSync(openSync(lock, 'wx'));
  const state = {
    pid: process.pid,
    phase: 'evaluation',
    plannedRounds: plan.plannedRounds,
    completedRounds: 0,
    workers: [],
    deadlineUTC: schedule.deadlineUTC,
  };
  const tick = () => {
    state.workers = Array.from({ length: plan.workers }, (_, i) =>
      readJSON(join(root, `worker-${i}.json`)),
    ).filter(Boolean);
    state.completedRounds = state.workers.reduce((n, w) => n + w.completedPairs * 2, 0);
    writeJSON(join(root, 'status.json'), { ...state, updatedAtUTC: new Date().toISOString() });
    writeJSON(join(root, 'progress.json'), {
      phase: state.phase,
      displayName: plan.displayName || '新研究冠军 vs 当前reason',
      currentTask: '独立交换阵营单局评测',
      analysis: `实际完成${state.completedRounds}/${plan.plannedRounds}局；未完成不下全量结论`,
      nextTask: '汇总升级分、95%牌副簇区间与reason回退/耗时',
      deadlineUTC: schedule.deadlineUTC,
    });
  };
  const fd = openSync(join(root, 'controller.log'), 'a');
  const children = [];
  let timer, guardian;
  try {
    mkdirSync(join(root, 'panel'), { recursive: true });
    while (freemem() < 5 * 1024 ** 3 && !stopped(root)) {
      state.phase = 'memory-paused';
      tick();
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (stopped(root)) throw Error('Stopped before worker launch');
    state.phase = 'evaluation';
    log(root, 'START evaluate');
    tick();
    timer = setInterval(tick, 3000);
    guardian = fork(SELF, [`--run=${root}`, '--watch'], {
      windowsHide: true,
      stdio: ['ignore', fd, fd, 'ipc'],
    });
    writeJSON(join(root, 'guardian-launch.json'), { pid: guardian.pid });
    const results = await Promise.allSettled(
      Array.from(
        { length: plan.workers },
        (_, i) =>
          new Promise((ok, fail) => {
            const child = fork(SELF, [`--run=${root}`, `--worker=${i}`], {
              execArgv: ['--expose-gc', '--max-old-space-size=1024'],
              windowsHide: true,
              stdio: ['ignore', fd, fd, 'ipc'],
            });
            children.push(child);
            child.once('error', (e) => {
              stop(root, 'worker-spawn-failed');
              fail(e);
            });
            child.once('exit', (code) => {
              if (code !== 0) {
                stop(root, 'worker-exited');
                fail(Error('Worker exited ' + code));
              } else ok();
            });
          }),
      ),
    );
    if (results.some((r) => r.status === 'rejected')) throw Error('Worker process failed');
    tick();
    log(root, `END evaluate rc=${state.workers.every((w) => w.phase === 'complete') ? 0 : 1}`);
    const rows = [];
    for (let i = 0; i < plan.workers; i++) {
      const f = join(root, `worker-${i}.jsonl`);
      if (existsSync(f))
        for (const line of readFileSync(f, 'utf8').split('\n'))
          if (line.trim()) rows.push(JSON.parse(line));
    }
    pairedRows(rows, protocolSHA256, plan.tasks[0].seeds);
    if (
      state.workers.length === plan.workers &&
      state.workers.every((w) => w.phase === 'complete')
    ) {
      log(root, 'START summarize');
      await new Promise((ok, fail) => {
        const child = spawn(
          plan.python,
          [
            '-B',
            '-X',
            'utf8',
            join(plan.sourceRoot, 'ai/danMCai/evaluation/summarize-round-pairs.py'),
            '--protocol',
            join(root, 'protocol.json'),
            '--results',
            root,
            '--output',
            join(root, 'summary.json'),
          ],
          { windowsHide: true, stdio: ['ignore', fd, fd] },
        );
        child.once('error', fail);
        child.once('exit', (c) => (c === 0 ? ok() : fail(Error('Summary failed'))));
      });
      state.phase = 'complete';
      const result = readJSON(join(root, 'summary.json')).reports['head-to-head'];
      writeJSON(join(root, 'panel/summary.json'), {
        meanSignedPoints: result.signedUpgradePoints.mean,
        ci95: result.signedUpgradePoints.ci,
        pairs: result.pairs,
        rounds: result.rounds,
        focalWins: result.wins,
        focalLosses: result.losses,
      });
      log(root, 'END summarize rc=0');
    } else {
      state.phase = state.workers.some((w) => w.phase === 'failed') ? 'failed' : 'stopped';
      const interval =
        rows.length > 1
          ? clusterInterval(rows.map((r) => r.games.reduce((n, g) => n + g.signedPoints, 0) / 2))
          : null;
      writeJSON(join(root, 'partial-summary.json'), {
        complete: false,
        plannedPairs: plan.tasks[0].seeds.length,
        completedPairs: rows.length,
        interval,
        scope:
          'Partial timed sample; not the full preregistered conclusion. Runtime may depend on game difficulty.',
      });
    }
    const bands = {};
    for (const band of ['midgame', 'endgame']) {
      const ts = rows.flatMap((r) => r.games.map((g) => g.reason[band]));
      bands[band] = {
        requests: ts.reduce((n, t) => n + t.requests, 0),
        completed: ts.reduce((n, t) => n + t.completed, 0),
        deviated: ts.reduce((n, t) => n + t.deviated, 0),
        fallbackCount: ts.reduce((n, t) => n + t.fallbackCount, 0),
        minWorldsFallbacks: ts.reduce((n, t) => n + t.minWorlds, 0),
        fallbackReasons: ts.reduce((out, t) => {
          for (const [k, v] of Object.entries(t.fallbacks)) out[k] = (out[k] || 0) + v;
          return out;
        }, {}),
        timedSearches: ts.reduce((n, t) => n + t.searchMs.n, 0),
        totalMs: ts.reduce((n, t) => n + t.searchMs.totalMs, 0),
        maxMs: Math.max(0, ...ts.map((t) => t.searchMs.max || 0)),
      };
    }
    writeJSON(join(root, 'search-stats.json'), {
      bands,
      rawMs: rows.flatMap((r) => r.games).reduce((n, g) => n + g.timing.rawMs, 0),
      reasonMs: rows.flatMap((r) => r.games).reduce((n, g) => n + g.timing.reasonMs, 0),
      pairedGames: rows.length * 2,
      optimizerUpdates: 0,
    });
  } catch (e) {
    stop(root, 'evaluation-failed');
    state.phase = 'failed';
    state.error = String(e.stack || e);
    throw e;
  } finally {
    clearInterval(timer);
    writeJSON(join(root, 'FINISHED'), { phase: state.phase, atUTC: new Date().toISOString() });
    tick();
    closeSync(fd);
    unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(resolve(process.argv[1])) === SELF
) {
  const root = resolve(option('run', ''));
  if (process.argv.includes('--watch')) await watch(root);
  else if (option('worker', '') !== '') await worker(root, Number(option('worker', '')));
  else await main(root);
}
