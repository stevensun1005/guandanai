import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGE,
  compareRows,
  displayOrder,
  loadConfig,
  parseStagesLog,
  pathInCommands,
  shortOfPlan,
  snapshot,
  verdict,
} from '../../research/tools/window-dashboard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('window dashboard page script parses (a syntax error leaves the page stuck on 读取中)', () => {
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test('verdict follows only the preregistered rule type', () => {
  const heldout = { type: 'heldout' };
  assert.equal(verdict(heldout, [0.06, 0.09]).text, '正向证据');
  assert.equal(verdict(heldout, [-0.001, 0.007]).text, '零结果/不确定');
  assert.equal(verdict(heldout, [-0.2, -0.01]).text, '负');
  assert.equal(verdict(heldout, null).text, '—');
  // Development checks never become evidence, whatever the interval says.
  assert.match(verdict({ type: 'dev' }, [0.15, 0.26]).text, /^开发检查/);
  assert.match(verdict({ type: 'dev' }, [-0.3, -0.1]).text, /^开发检查/);
  assert.equal(verdict({ type: 'dev' }, null).text, '开发检查');
  assert.equal(verdict({ type: 'gate', pass: '过关' }, [0.17, 0.19]).text, '过关（开发检查）');
  assert.equal(verdict({ type: 'gate' }, [-0.1, 0.2]).text, '未过关（开发检查）');
  assert.equal(verdict({ type: 'descriptive' }, [1, 2]).text, '描述性（不判定）');
  assert.equal(verdict(undefined, [1, 2]).text, '描述性（不判定）');
  // A held-out run short of its preregistered size says so; complete runs and dev checks do not.
  const v = verdict(heldout, [0.06, 0.09]);
  assert.equal(shortOfPlan(v, heldout, 2800, 3000).text, '正向证据（仅 2,800 / 预登记 3,000 副）');
  assert.equal(shortOfPlan(v, heldout, 3000, 3000), v);
  const d = verdict({ type: 'dev' }, [0.1, 0.2]);
  assert.equal(shortOfPlan(d, { type: 'dev' }, 10, 1200), d);
});

test('stages.log parsing keeps START notes, END rc (or none) and SKIP reasons', () => {
  const log = parseStagesLog(
    [
      '2026-11-09T04:39:45Z window1 start pid 1',
      '2026-11-09T04:39:45Z START A-train',
      '2026-11-09T04:43:32Z END A-train rc=0',
      '2026-11-09T05:38:00Z START H-P2 (minutes cap 607)',
      '2026-11-09T05:56:13Z END H-P2',
      '2026-11-09T06:00:00Z SKIP H-band41 (only 12 min)',
      'garbage line',
      '',
    ].join('\n'),
  );
  assert.equal(log.ids.get('A-train').rc, 0);
  assert.equal(log.ids.get('H-P2').startNote, '(minutes cap 607)');
  assert.equal(log.ids.get('H-P2').rc, null);
  assert.ok(log.ids.get('H-P2').end);
  assert.equal(log.ids.get('H-band41').skip.reason, 'only 12 min');
  assert.deepEqual(
    log.markers.map((m) => m.text),
    ['window1 start pid 1'],
  );
});

test('paired comparison and process path matching', () => {
  const a = [1, 2, 3].map((seed, i) => ({ seed, mean: [0, 1, -1][i] }));
  const b = [1, 2, 3, 4].map((seed, i) => ({ seed, mean: [1, 1, 0, 5][i] }));
  const c = compareRows(a, b);
  assert.equal(c.commonPairs, 3);
  assert.ok(Math.abs(c.meanDifference - 2 / 3) < 1e-12);
  assert.deepEqual([c.pairsBBetter, c.pairsABetter, c.pairsIdentical], [2, 0, 1]);
  const ps = 'node x.mjs --out=/r/H/data-v2 --workers=2\npython t.py --out /r/A/train --steps 1';
  assert.ok(pathInCommands(ps, '/r/H/data-v2'));
  assert.ok(!pathInCommands(ps, '/r/H/data'));
  assert.ok(pathInCommands(ps, '/r/A/train'));
  assert.ok(!pathInCommands(ps, '/r/A'));
});

function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function syntheticRun() {
  const run = mkdtempSync(join(tmpdir(), 'window-dashboard-'));
  const t = (min) => new Date(Date.parse('2026-11-09T10:00:00Z') + min * 60_000).toISOString();
  writeFileSync(
    join(run, 'stages.log'),
    [
      `${t(0)} q1 start pid 1`,
      `${t(0)} START E-done`,
      `${t(5)} END E-done rc=0`,
      `${t(5)} START E-fail`,
      `${t(6)} END E-fail rc=1`,
      `${t(6)} SKIP E-skip (stop/deadline)`,
      `${t(10)} START M-run`,
      `${t(10)} START G-run`,
      `${t(10)} START T-run`,
      `${t(10)} START E-run`,
      `${t(10)} START H3`,
      `${t(11)} q2 start pid 2`,
      `${t(12)} q2 end`,
      '',
    ].join('\n'),
  );
  const evalSummary = {
    pairs: 100,
    rounds: 200,
    focalWins: 104,
    focalLosses: 96,
    meanSignedPoints: 0.05,
    ci95: [0.01, 0.09],
  };
  writeJSON(join(run, 'E/done/run.json'), { workers: 2 });
  writeJSON(join(run, 'E/done/summary.json'), evalSummary);
  writeJSON(join(run, 'E/run/run.json'), { workers: 3 });
  // Midgame: 2 workers, 30 + 20 completed pairs out of 200.
  writeJSON(join(run, 'M/run.json'), { start: 1000, pairs: 200, workers: 2 });
  const line = (seed, mean) => JSON.stringify({ seed, mean, a: {}, b: {} });
  writeFileSync(
    join(run, 'M/part-0.jsonl'),
    Array.from({ length: 30 }, (_, i) => line(1000 + 2 * i, 0)).join('\n') + '\n',
  );
  writeFileSync(
    join(run, 'M/part-1.jsonl'),
    Array.from({ length: 20 }, (_, i) => line(1001 + 2 * i, 1)).join('\n') + '\n{"seed":',
  );
  // Generate: 3 of 8 blocks.
  writeJSON(join(run, 'G/run.json'), { seeds: [5000, 5799], block: 100 });
  for (const s of [5000, 5100, 5200]) writeJSON(join(run, `G/b${s}.json`), { rows: 10 });
  // Train log.
  mkdirSync(join(run, 'logs'), { recursive: true });
  writeFileSync(
    join(run, 'logs/T-run.log'),
    '{"step": 1000, "seconds": 20}\nwarning: x\n{"step": 2500, "seconds": 50}\n',
  );
  // H3-like: both sides finished (summary.json) without END line or compare file.
  for (const [side, mean] of [
    ['uniform', 0],
    ['belief', 1],
  ]) {
    const dir = join(run, `H3/${side}`);
    writeJSON(join(dir, 'run.json'), { start: 1, pairs: 4, workers: 1 });
    writeFileSync(
      join(dir, 'part-0.jsonl'),
      [1, 2, 3, 4].map((s) => line(s, s === 4 ? 0 : mean)).join('\n') + '\n',
    );
    writeJSON(join(dir, 'summary.json'), {
      ...evalSummary,
      pairs: 4,
      ci95: side === 'belief' ? [0.2, 1.3] : [-0.1, 0.1],
      finishedAt: t(30),
    });
  }
  return { run, now: Date.parse(t(20)) };
}

const syntheticConfig = {
  title: 'synthetic',
  deadline: '2026-11-09T15:45:00Z',
  orchestrators: [{ name: 'q2.sh', startMarker: 'q2 start', endMarker: 'q2 end' }],
  stages: [
    {
      key: 'E-done',
      kind: 'evaluate',
      paths: { out: 'E/done' },
      total: 100,
      rule: { type: 'heldout', text: '下界 >0' },
    },
    { key: 'E-fail', kind: 'evaluate', paths: { out: 'E/fail' }, rule: { type: 'dev' } },
    { key: 'E-skip', kind: 'evaluate', paths: { out: 'E/skip' } },
    { key: 'E-queued', kind: 'evaluate', paths: { out: 'E/q' }, after: '等前一项' },
    { key: 'Q2-never', kind: 'metrics', queue: 'q2.sh', paths: { result: 'x.json' } },
    { key: 'M-run', kind: 'midgame', paths: { out: 'M' }, total: 200 },
    { key: 'G-run', kind: 'generate', paths: { out: 'G' } },
    {
      key: 'T-run',
      kind: 'train',
      paths: { log: 'logs/T-run.log', out: 'T' },
      total: 10000,
      capMinutes: 30,
    },
    { key: 'E-run', kind: 'evaluate', paths: { out: 'E/run' } },
    {
      key: 'H3',
      kind: 'compare',
      doneWhen: ['H3/belief/summary.json', 'H3/uniform/summary.json'],
      paths: { compare: 'H3/compare.json' },
      sides: [
        { label: '均匀', out: 'H3/uniform' },
        { label: '猜牌', out: 'H3/belief', primary: true },
      ],
      total: 4,
      rule: { type: 'heldout', text: '主' },
      compareRule: { type: 'descriptive', text: '次要' },
    },
    { key: 'Missing', kind: 'review', paths: { result: 'nope.json' } },
  ],
};

test('synthetic run covers every state and progress kind without crashing', () => {
  const { run, now } = syntheticRun();
  try {
    const psText = `node e.mjs --out=${join(run, 'E/run')}\nnode m.mjs --out=${join(run, 'M')}`;
    const s = snapshot(run, syntheticConfig, { now, psText, machine: false });
    const by = Object.fromEntries(s.stages.map((x) => [x.key, x]));
    assert.equal(by['E-done'].state, 'done');
    assert.equal(by['E-done'].results[0].verdict.text, '正向证据');
    assert.equal(by['E-done'].progress.text, '100 / 100 副');
    assert.equal(by['E-fail'].state, 'failed');
    assert.equal(by['E-fail'].reason, '退出码 1');
    assert.equal(by['E-fail'].results[0].rows[0][1], '未找到（—）');
    assert.equal(by['E-skip'].state, 'skipped');
    assert.equal(by['E-skip'].reason, 'stop/deadline');
    assert.equal(by['E-queued'].state, 'queued');
    assert.equal(by['Q2-never'].state, 'skipped');
    assert.equal(by['Q2-never'].reason, '队列已结束，未启动');
    assert.equal(by['M-run'].state, 'running');
    assert.equal(by['M-run'].progress.text, '50 / 200 副');
    assert.equal(by['M-run'].progress.fraction, 0.25);
    assert.ok(by['M-run'].progress.etaText.endsWith('美东'));
    assert.equal(by['M-run'].processAlive, true);
    assert.equal(by['M-run'].results.length, 0, 'no interim numbers while running');
    assert.equal(by['G-run'].progress.text, '3 / 8 块（约 300 / 800 局）');
    assert.equal(by['T-run'].progress.text, '第 2,500 / 10,000 步（上限 30 分钟）');
    assert.equal(by['T-run'].processAlive, false);
    assert.ok(by['T-run'].warning);
    assert.match(by['E-run'].progress.text, /分片 0\/3/);
    assert.equal(by['E-run'].progress.fraction, null);
    // H3: done by result files; primary verdict from the heldout rule, compare computed and descriptive.
    assert.equal(by.H3.state, 'done');
    const primary = by.H3.results.find((r) => r.primary);
    assert.equal(primary.verdict.text, '正向证据');
    const paired = by.H3.results.find((r) => r.heading.startsWith('配对差'));
    assert.equal(paired.verdict.text, '描述性（不判定）');
    assert.match(paired.rows[0][1], /^\+0\.750/);
    assert.match(paired.source, /现算/);
    assert.equal(by.Missing.state, 'queued');
    assert.deepEqual(s.counts, {
      queued: 2,
      running: 4,
      done: 2,
      failed: 1,
      skipped: 2,
      stopped: 0,
    });
    assert.equal(s.now.running.length, 4);
    assert.deepEqual(
      s.now.next.map((x) => x.after),
      ['等前一项', null],
    );
    assert.equal(s.window.stop, false);
    assert.doesNotThrow(() => JSON.stringify(s));
    // STOP file flips the header; an empty run dir never throws.
    writeFileSync(join(run, 'STOP'), '');
    assert.equal(snapshot(run, syntheticConfig, { now, psText, machine: false }).window.stop, true);
    const empty = mkdtempSync(join(tmpdir(), 'window-dashboard-empty-'));
    const e = snapshot(empty, syntheticConfig, { now, psText: '', machine: false });
    assert.ok(e.stages.every((x) => x.state === 'queued' || x.state === 'skipped'));
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('stop by signal, failed prerequisites, dead queue, dev sides and slowest-side estimate', () => {
  const run = mkdtempSync(join(tmpdir(), 'window-dashboard-stop-'));
  const t = (min) => new Date(Date.parse('2026-11-09T10:00:00Z') + min * 60_000).toISOString();
  try {
    writeFileSync(
      join(run, 'stages.log'),
      [
        `${t(0)} q start pid 1`,
        `${t(0)} START Gen`,
        `${t(5)} END Gen rc=1`,
        `${t(0)} START Killed`,
        `${t(9)} q STOP/deadline: terminating`,
        `${t(9)} END Killed rc=143`,
        `${t(0)} START Crash`,
        `${t(3)} END Crash rc=139`,
        `${t(10)} START P-a`,
        `${t(10)} START P-b`,
        '',
      ].join('\n'),
    );
    const line = (seed) => JSON.stringify({ seed, mean: 0 });
    for (const [side, n] of [
      ['a', 90],
      ['b', 10],
    ]) {
      writeJSON(join(run, `P/${side}/run.json`), { start: 1, pairs: 100, workers: 1 });
      writeFileSync(
        join(run, `P/${side}/part-0.jsonl`),
        Array.from({ length: n }, (_, i) => line(1 + i)).join('\n') + '\n',
      );
    }
    writeJSON(join(run, 'P/a/summary.json'), {
      pairs: 90,
      meanSignedPoints: -0.1,
      ci95: [-0.2, -0.05],
    });
    const config = {
      deadline: '2026-11-09T15:45:00Z',
      orchestrators: [{ name: 'q.sh', startMarker: 'q start', endMarker: 'q end' }],
      stages: [
        { key: 'Gen', kind: 'generate', queue: 'q.sh', paths: { out: 'G' } },
        { key: 'Train', kind: 'train', queue: 'q.sh', requires: ['Gen'], paths: {} },
        { key: 'Later', kind: 'metrics', queue: 'q.sh', paths: { result: 'x.json' } },
        { key: 'Killed', kind: 'midgame', paths: { out: 'K' }, total: 10 },
        { key: 'Crash', kind: 'midgame', paths: { out: 'C' }, total: 10 },
        {
          key: 'P',
          ids: ['P-a', 'P-b'],
          kind: 'compare',
          sides: [
            { label: 'a', out: 'P/a' },
            { label: 'b', out: 'P/b' },
          ],
          total: 100,
          rule: { type: 'dev', text: '开发检查' },
        },
      ],
    };
    const now = Date.parse(t(20));
    const psText = `node x --out=${join(run, 'P/a')}`; // q.sh itself is gone
    const s = snapshot(run, config, { now, psText, machine: false });
    const by = Object.fromEntries(s.stages.map((x) => [x.key, x]));
    assert.equal(by.Gen.state, 'failed');
    assert.equal(by.Train.state, 'skipped');
    assert.match(by.Train.reason, /前置阶段 Gen 失败/);
    assert.equal(by.Later.state, 'queued');
    assert.match(by.Later.warning, /q\.sh 不在进程列表/);
    assert.equal(by.Killed.state, 'skipped');
    assert.equal(by.Killed.stateText, '已停止');
    assert.match(by.Killed.reason, /143/);
    assert.equal(by.Crash.state, 'failed', 'a signal exit with no stop evidence is a failure');
    // Sides of a development comparison are labelled 开发检查, never 描述性 or evidence.
    assert.equal(by.P.state, 'running');
    // A side that wrote its final summary shows it; the paired difference waits for both sides.
    assert.deepEqual(
      by.P.results.map((r) => [r.heading, r.verdict.text]),
      [['a', '开发检查（区间低于 0）']],
    );
    // Estimate follows the slower side (10%), not the pooled 50%: 10 min elapsed -> 100 min.
    assert.equal(by.P.progress.eta, Date.parse(t(10)) + 100 * 60_000);
    const done = snapshot(run, config, { now, psText: '', machine: false });
    assert.ok(done.stages.every((x) => !x.error));
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

const REAL_RUN = '/Users/stevensun/guandan-runtime.noindex/window1-20261109';
const REAL_CONFIG = join(ROOT, 'ai/danMCai/workspace/window1-dashboard.json');

test(
  'smoke: real window-1 run directory (read-only)',
  { skip: !(existsSync(REAL_RUN) && existsSync(REAL_CONFIG)) && 'real run or config absent' },
  () => {
    const s = snapshot(REAL_RUN, loadConfig(REAL_CONFIG));
    assert.ok(s.stages.length >= 17);
    assert.ok(s.stages.every((x) => !x.error));
    const rows = s.stages.map((x) => ({
      stage: x.key,
      state: x.state,
      start: x.startText,
      end: x.endText,
      took: x.durationText,
      progress:
        (x.progress?.text || '') + (x.progress?.etaText ? ` · 预计 ${x.progress.etaText}` : ''),
      verdict: x.results
        .filter((r) => r.verdict)
        .map((r) => r.verdict.text)
        .join(' / '),
    }));
    console.log(`${s.now.headline}; 剩 ${s.window.remainingText}; STOP ${s.window.stop}`);
    console.table(rows);
  },
);

test('stages logged with free-text markers (backfill loops) show running, then done', () => {
  const run = mkdtempSync(join(tmpdir(), 'window-dashboard-markers-'));
  try {
    const config = {
      title: 't',
      deadline: '2030-01-01T00:00:00Z',
      orchestrators: [{ name: 'q.sh', startMarker: 'q start', endMarker: 'q end' }],
      stages: [
        {
          key: 'BF',
          ids: ['BF'],
          title: 'bf',
          kind: 'generate',
          queue: 'q.sh',
          markers: { start: 'BACKFILL chunk', end: 'BACKFILL end' },
          paths: { out: 'D' },
          rule: { type: 'descriptive', text: '' },
        },
      ],
    };
    const lines = [
      '2029-01-01T00:00:00Z q start pid 1',
      '2029-01-01T00:01:00Z BACKFILL chunk workers=3',
    ];
    writeFileSync(join(run, 'stages.log'), lines.join('\n') + '\n');
    const now = Date.parse('2029-01-01T00:10:00Z');
    let s = snapshot(run, config, { now, psText: '', machine: false });
    assert.equal(s.stages[0].error, undefined);
    assert.equal(s.stages[0].state, 'running');
    writeFileSync(
      join(run, 'stages.log'),
      [...lines, '2029-01-01T00:20:00Z BACKFILL end'].join('\n') + '\n',
    );
    s = snapshot(run, config, { now: now + 3_600_000, psText: '', machine: false });
    assert.equal(s.stages[0].state, 'done');
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('whole-match evaluation tally counts complete pair lines only', async () => {
  const { matchEvalTally } = await import('../../research/tools/window-dashboard.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'window-dashboard-match-'));
  try {
    const m = (focalTeam, focalResult) => ({
      focalTeam,
      focalResult,
      history: [{ team: focalTeam }, { team: 1 - focalTeam }],
    });
    writeFileSync(
      join(dir, 'pairs.jsonl'),
      JSON.stringify({ matches: [m(0, 'win'), m(1, 'loss')] }) +
        '\n' +
        JSON.stringify({ matches: [m(0, 'draw'), m(1, 'win')] }) +
        '\n{"matches":[{"focalTe',
    );
    const t = matchEvalTally(dir);
    assert.equal(t.matches, 4);
    assert.deepEqual([t.wins, t.losses, t.draws], [2, 1, 1]);
    assert.equal(t.matchScore, 2.5 / 4);
    assert.equal(t.roundWinRate, 0.5);
    assert.deepEqual(t.side1, { n: 2, wins: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stopped whole-match evaluation shows its partial result and says it is short of plan', () => {
  const run = mkdtempSync(join(tmpdir(), 'window-dashboard-stopped-'));
  try {
    mkdirSync(join(run, 'eval'));
    writeFileSync(
      join(run, 'eval', 'report.json'),
      JSON.stringify({
        status: 'stopped',
        summary: {
          pairs: 60,
          matches: 120,
          wins: 89,
          losses: 19,
          draws: 12,
          matchWinRate: 89 / 120,
          matchScore: 95 / 120,
          roundWinRate: 0.593,
          confidence95: { matchScore: [0.721, 0.854] },
        },
      }),
    );
    writeFileSync(
      join(run, 'stages.log'),
      '2029-01-01T00:00:00Z ownertasks start\n2029-01-01T00:00:00Z START T\n2029-01-01T01:00:00Z END T rc=0\n',
    );
    const config = {
      title: 't',
      deadline: '2029-01-02T00:00:00Z',
      orchestrators: [{ name: 'q', startMarker: 'ownertasks start', endMarker: 'ownertasks end' }],
      stages: [
        {
          key: 'T',
          ids: ['T'],
          title: 't',
          desc: 'd',
          kind: 'match-eval',
          queue: 'q',
          paths: { out: 'eval' },
          rule: { type: 'heldout', text: 'r' },
          total: 500,
        },
      ],
    };
    const s = snapshot(run, config, {
      now: Date.parse('2029-01-01T02:00:00Z'),
      psText: '',
      machine: false,
    });
    const [r] = s.stages[0].results;
    assert.match(r.heading, /部分结果/);
    assert.deepEqual(r.rows[0], ['场数', '120 / 计划 500']);
    assert.deepEqual(r.rows[1], ['推理队 胜／负／平', '89 / 19 / 12']);
    assert.match(r.rows[2][1], /79\.2% \[72\.1%, 85\.4%\]/);
    assert.match(r.verdict.text, /仅 60 \/ 预登记 250 副/);
    assert.equal(r.verdict.tone, 'warn');
    // Resumed: the stale stopped report gives way to the live tally from pairs.jsonl.
    writeFileSync(join(run, 'eval', 'progress.json'), JSON.stringify({ status: 'running' }));
    const match = { focalTeam: 0, focalResult: 'win', history: [{ team: 0 }] };
    writeFileSync(join(run, 'eval', 'pairs.jsonl'), JSON.stringify({ matches: [match] }) + '\n');
    const live = snapshot(run, config, {
      now: Date.parse('2029-01-01T02:00:00Z'),
      psText: '',
      machine: false,
    }).stages[0].results[0];
    assert.match(live.heading, /实时/);
    assert.deepEqual(live.rows[0], ['已完成场数', '1 / 500']);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('cards: running (latest start first), then queued in run order, then ended (latest end first), then never ran', () => {
  const st = (key, state, start = null, end = null) => ({ key, state, start, end });
  const order = displayOrder([
    st('done-early', 'done', 1, 10),
    st('queued-1', 'queued'),
    st('run-old', 'running', 5),
    st('failed-mid', 'failed', 2, 20),
    st('never', 'skipped'),
    st('queued-2', 'queued'),
    st('done-late', 'done', 3, 30),
    st('stopped', 'skipped', 4, 25),
    st('run-new', 'running', 8),
    st('never-later', 'skipped'),
  ]).map((s) => s.key);
  assert.deepEqual(order, [
    'run-new',
    'run-old',
    'queued-1',
    'queued-2',
    'done-late',
    'stopped',
    'failed-mid',
    'done-early',
    'never-later',
    'never',
  ]);
});
