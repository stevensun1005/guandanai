/** Offline self-simulation review only: archived Q order, no inference or human input. */
import {
  createReadStream,
  appendFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDeck } from '../../../web/src/core/cards.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import { advanceRound } from '../../shared/simulation/simulation.mjs';
import { option, readJSON, writeJSON, sha256 } from '../../danMCai/training/continuous/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const deck = makeDeck();
const ids = (cards) =>
  (cards || [])
    .map((c) => (typeof c === 'number' ? c : c.id))
    .sort((a, b) => a - b)
    .join(',');
const action = (play) =>
  play && { cards: play.cards.map((c) => c.id), type: play.type, value: play.value, n: play.n };

export async function reviewSimulatedRound(record, focus, checkpoint = () => {}) {
  if (
    record.kind ||
    record.appVersion ||
    record.schema ||
    !record.seats?.every((s) => s === 'champion') ||
    record.seats.length !== 4
  )
    throw Error('Only archived self-simulation games; D1/human/practice input is unsupported');
  const initial = record.initial;
  if (
    !Number.isInteger(focus) ||
    focus < 0 ||
    focus > 3 ||
    !Array.isArray(initial?.hands) ||
    initial.hands.length !== 4 ||
    initial.hands.some((h) => !Array.isArray(h) || h.length !== 27) ||
    initial.hands.flat().some((i) => !Number.isInteger(i) || i < 0 || i > 107) ||
    ids(initial.hands.flat()) !== ids(deck) ||
    !Number.isInteger(initial.level) ||
    initial.level < 2 ||
    initial.level > 14 ||
    !Number.isInteger(initial.leader) ||
    initial.leader < 0 ||
    initial.leader > 3
  )
    throw Error('Invalid complete simulated deal');
  const game = {
    hands: initial.hands.map((h) => h.map((i) => deck[i])),
    L: initial.level,
    levels: [initial.level, initial.level],
    turn: initial.leader,
    log: [],
    trick: null,
    passes: 0,
    out: [],
  };
  const frames = [];
  let terminal = null;
  if (!record.moves?.length || record.moves.length > 1000)
    throw Error('Incomplete simulated trace');
  for (const [turn, move] of record.moves.entries()) {
    await checkpoint();
    if (terminal || move.p !== game.turn || move.model !== 'champion')
      throw Error('Invalid simulated turn/model');
    const plays = candidates(game.hands[move.p], game.L, game.trick?.play);
    const chosen = plays.findIndex(
      (p) =>
        ids(p?.cards) === ids(move.cards) &&
        (!p || (p.type === move.type && p.value === move.value && p.n === move.n)),
    );
    const top = move.top5;
    if (chosen < 0 || plays.length !== move.candidateCount || !Array.isArray(top))
      throw Error('Archived candidate set changed');
    if (!top.length) {
      if (plays.length !== 1 || chosen !== 0) throw Error('Missing archived Q choices');
    } else {
      if (
        top.length !== Math.min(5, plays.length) ||
        top[0].index !== chosen ||
        new Set(top.map((x) => x.index)).size !== top.length ||
        top.some(
          (x, i) =>
            !Number.isFinite(x.q) ||
            !Number.isInteger(x.index) ||
            x.index < 0 ||
            x.index >= plays.length ||
            (i && (top[i - 1].q < x.q || (top[i - 1].q === x.q && top[i - 1].index > x.index))),
        )
      )
        throw Error('Archived Q order/argmax changed');
    }
    if (move.p === focus) {
      const play = plays[chosen],
        partner = (focus + 2) % 4;
      const descriptions = [game.trick ? '跟牌局面' : '领出局面', play ? '出牌' : '过牌'];
      if (play && game.trick?.player === partner) descriptions.push('压过队友牌面');
      if (!game.hands[partner].length) descriptions.push('队友已出完');
      frames.push({
        turn,
        ownHand: game.hands[focus].map((c) => c.id),
        chosenIndex: chosen,
        chosen: action(play),
        archivedTop5: top.map((x, i) => ({
          rank: i + 1,
          index: x.index,
          rawRelativeQ: x.q,
          action: action(plays[x.index]),
        })),
        forced: !top.length,
        descriptions,
        calibratedDelta: null,
        beliefDelta: null,
      });
    }
    terminal = advanceRound(game, plays[chosen]);
  }
  if (
    !terminal ||
    terminal.winner !== record.winner ||
    terminal.points !== record.points ||
    JSON.stringify(terminal.order) !== JSON.stringify(record.order) ||
    record.turns !== record.moves.length
  )
    throw Error('Incomplete or changed terminal outcome');
  return {
    schema: 1,
    source: 'archived-self-simulation',
    focus,
    frames,
    finalOwnTeamSignedUpgrade: (terminal.winner === focus % 2 ? 1 : -1) * terminal.points,
    finalOrder: terminal.order,
    scope:
      'Raw Q is relative, not calibrated upgrade/probability. Descriptions do not explain, rank, recommend or train. No inferred counterfactual benefit.',
  };
}

export async function runReviewExport(run) {
  const stopped = () => existsSync(join(run, 'STOP')) || existsSync(join(run, '../../STOP'));
  if (stopped()) return { phase: 'stopped-before-read' };
  const protocol = join(run, 'protocol.json'),
    plan = readJSON(protocol),
    task = readJSON(join(run, 'campaign-task.json'));
  if (!task || sha256(protocol) !== task.protocolSHA256)
    throw Error('Unregistered/changed review protocol');
  const deadline = Math.min(
    Date.parse(plan.evaluationDeadlineUTC),
    Date.parse(task.window.deadlineUTC),
  );
  if (Date.now() >= deadline) return { phase: 'stopped-before-read' };
  if (existsSync(join(run, 'status.json')) || existsSync(join(run, 'reviews.jsonl')))
    throw Error('Existing export; no repeated selection');
  const lock = join(run, 'review-export.lock');
  closeSync(openSync(lock, 'wx'));
  const state = {
    pid: process.pid,
    phase: 'analysis',
    displayName: plan.displayName,
    startedAtUTC: new Date().toISOString(),
    completedPositions: 0,
    plannedPositions: plan.seeds.length,
    positionUnit: '个已有self牌副（离线复盘转换）',
    archivedRoundsReplayed: 0,
    framesExported: 0,
    optimizerUpdates: 0,
    networkForwards: 0,
    newGames: 0,
    minimumAvailableGiB: freemem() / 1024 ** 3,
  };
  let paused = false;
  const check = async () => {
    if (stopped() || Date.now() >= deadline) throw Error('STOP or fixed review deadline');
    let available = freemem() / 1024 ** 3;
    state.minimumAvailableGiB = Math.min(state.minimumAvailableGiB, available);
    while (available < (paused ? 5 : 4)) {
      paused = true;
      await new Promise((r) => setTimeout(r, 1000));
      if (stopped() || Date.now() >= deadline) throw Error('STOP or fixed review deadline');
      available = freemem() / 1024 ** 3;
      state.minimumAvailableGiB = Math.min(state.minimumAvailableGiB, available);
    }
    paused = false;
  };
  const save = () =>
    writeJSON(join(run, 'status.json'), { ...state, updatedAtUTC: new Date().toISOString() });
  try {
    await check();
    save();
    if (
      execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !==
      plan.sourceSHA
    )
      throw Error('Frozen HEAD changed');
    for (const [name, digest] of Object.entries(plan.sourceSHA256)) {
      await check();
      if (sha256(join(ROOT, name)) !== digest) throw Error('Frozen source changed');
    }
    if (
      sha256(plan.inputProtocol) !== plan.inputProtocolSHA256 ||
      sha256(plan.teacher.file) !== plan.teacher.sha256
    )
      throw Error('Trace/teacher lineage changed');
    const inputPlan = readJSON(plan.inputProtocol);
    if (
      inputPlan.evaluationKind !== 'decision-trace' ||
      inputPlan.models.champion.sha256 !== plan.teacher.sha256
    )
      throw Error('Unsupported input protocol');
    const seen = new Set(),
      wanted = new Set(plan.seeds);
    if (wanted.size !== plan.seeds.length) throw Error('Duplicate selected roots');
    for (const [name, digest] of Object.entries(plan.inputFiles)) {
      await check();
      const file = join(plan.inputRun, name);
      if (sha256(file) !== digest) throw Error('Archived data changed');
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        await check();
        const row = JSON.parse(line);
        if (row.task !== 'trajectory-self' || !wanted.has(row.seed)) continue;
        if (
          row.stage !== 'trajectory' ||
          row.protocolSHA256 !== plan.inputProtocolSHA256 ||
          seen.has(row.seed) ||
          row.games.length !== 2
        )
          throw Error('Wrong archived self row');
        const reviews = [await reviewSimulatedRound(row.games[0], row.seed % 4, check)];
        appendFileSync(
          join(run, 'reviews.jsonl'),
          JSON.stringify({
            seed: row.seed,
            protocolSHA256: task.protocolSHA256,
            teacherSHA256: plan.teacher.sha256,
            reviews,
          }) + '\n',
        );
        seen.add(row.seed);
        state.completedPositions++;
        state.archivedRoundsReplayed += reviews.length;
        state.framesExported += reviews.reduce((n, r) => n + r.frames.length, 0);
        save();
      }
    }
    if (seen.size !== wanted.size) throw Error('Missing preregistered archived roots');
    state.phase = 'complete';
    state.stoppedAtUTC = new Date().toISOString();
    writeJSON(join(run, 'summary.json'), {
      ...state,
      reviewsSHA256: sha256(join(run, 'reviews.jsonl')),
      scope:
        'Functional export of old self-simulation records only, not independent strength, predictive validity, new data, live UI or human review. D1/Clint/mixed/P0, belief searches and calibrated maps are unsupported.',
    });
  } catch (error) {
    state.phase = 'needs-attention';
    state.failure = error.message;
    throw error;
  } finally {
    save();
    unlinkSync(lock);
  }
  return state;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await runReviewExport(resolve(option('run', '')));
