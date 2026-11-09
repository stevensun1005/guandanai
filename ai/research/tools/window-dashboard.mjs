import { guanzeroCards } from './guanzero-stages.mjs';
/**
 * Read-only live dashboard for a research window run by stage scripts (window1.sh and friends).
 * It reads stages.log ("<ISO> START <id>[ ...]", "<ISO> END <id> rc=<n>", "<ISO> SKIP <id> (why)"
 * and free-text marker lines), the per-stage logs and the result files named in a config JSON.
 * Listens on 127.0.0.1 only and never writes, signals or controls anything.
 *
 *   node ai/research/tools/window-dashboard.mjs --run=<run dir> --config=<json> [--port=8768]
 *
 * Verdicts come only from the preregistered rule type in the config: heldout (lower bound > 0 is
 * positive evidence), gate (lower bound > 0 passes a development gate), dev (always 开发检查) or
 * descriptive. Nothing here is a win rate or a strength claim.
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

/** Owner is in Toronto: every time shown on the page is America/Toronto (美东). */
const TZ = 'America/Toronto';
export const eastern = (ms, { seconds = false, date = false } = {}) =>
  ms == null || !Number.isFinite(ms)
    ? '—'
    : new Date(ms).toLocaleString('zh-CN', {
        timeZone: TZ,
        hour12: false,
        ...(date ? { month: 'numeric', day: 'numeric' } : {}),
        hour: '2-digit',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
      }) + ' 美东';

export const duration = (seconds) => {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分 ${s % 60} 秒`;
};

const num = (x, digits = 0) =>
  x == null || !Number.isFinite(Number(x))
    ? '—'
    : Number(x).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const signed = (x, digits = 3) =>
  x == null || !Number.isFinite(x)
    ? '—'
    : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}`;
const plain = (x, digits = 3) =>
  x == null || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(digits)}`;
const interval = (ci, digits = 3) =>
  Array.isArray(ci) && ci.length === 2 && ci.every(Number.isFinite)
    ? `[${plain(ci[0], digits)}, ${plain(ci[1], digits)}]`
    : '';
const pct = (x, digits = 1) =>
  x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`;
const short = (sha) => (typeof sha === 'string' && sha ? `${sha.slice(0, 8)}…` : '—');

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Parses stages.log. Each id keeps its latest START and the END/SKIP after it; any other line is a
 * free-text marker (orchestrator start/end, stop notices).
 */
export function parseStagesLog(text) {
  const ids = new Map(),
    markers = [];
  const get = (id) => {
    if (!ids.has(id))
      ids.set(id, { start: null, startNote: null, end: null, rc: null, skip: null });
    return ids.get(id);
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    const rest = m[2];
    let x;
    if ((x = /^START (\S+)(?:\s+(.*))?$/.exec(rest))) {
      Object.assign(get(x[1]), { start: at, startNote: x[2] || null, end: null, rc: null });
    } else if ((x = /^END (\S+)(?:\s+rc=(-?\d+))?/.exec(rest))) {
      Object.assign(get(x[1]), { end: at, rc: x[2] == null ? null : Number(x[2]) });
    } else if ((x = /^SKIP (\S+)(?:\s+\((.*)\))?/.exec(rest))) {
      get(x[1]).skip = { at, reason: x[2] || null };
    } else markers.push({ at, text: rest });
  }
  return { ids, markers };
}

/** Normal-approximation 95% interval of a mean over clusters (same formula as midgame-search). */
export function clusterInterval(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, sd: null, ci95: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const half = (1.96 * sd) / Math.sqrt(n);
  return { n, mean, sd, ci95: [mean - half, mean + half] };
}

/** Per-pair rows of a midgame-search out dir: line count and the contiguous completed prefix. */
export function midgameRows(dir) {
  const run = readJSON(join(dir, 'run.json'));
  const all = [];
  let lines = 0;
  for (const f of listDir(dir).filter((f) => /^part-\d+\.jsonl$/.test(f)))
    for (const line of readText(join(dir, f)).split('\n')) {
      if (!line.trim()) continue;
      try {
        all.push(JSON.parse(line)); // a half-written last line is not a completed pair
        lines++;
      } catch {}
    }
  let prefix = [];
  if (run && Number.isFinite(run.start)) {
    const done = new Set(all.map((r) => r.seed));
    let last = run.start - 1;
    while (done.has(last + 1)) last++;
    prefix = all.filter((r) => r.seed <= last).sort((a, b) => a.seed - b.seed);
  }
  return { run, lines, prefix };
}

/** Paired difference B − A on common prefix seeds (mirrors midgame-search --compare). */
export function compareRows(rowsA, rowsB) {
  const byA = new Map(rowsA.map((r) => [r.seed, r]));
  const common = rowsB.filter((r) => byA.has(r.seed));
  const diffs = common.map((r) => r.mean - byA.get(r.seed).mean);
  const d = clusterInterval(diffs);
  return {
    commonPairs: common.length,
    meanA: clusterInterval(common.map((r) => byA.get(r.seed).mean)).mean,
    meanB: clusterInterval(common.map((r) => r.mean)).mean,
    meanDifference: d.mean,
    ci95: d.ci95,
    pairsIdentical: diffs.filter((x) => x === 0).length,
    pairsBBetter: diffs.filter((x) => x > 0).length,
    pairsABetter: diffs.filter((x) => x < 0).length,
  };
}

/**
 * Verdict from the preregistered rule type only. heldout: lower > 0 正向证据, upper < 0 负, else
 * 零结果/不确定. gate: lower > 0 passes. dev: always 开发检查 (interval side shown as a description).
 */
export function verdict(rule, ci) {
  const type = rule?.type || 'descriptive';
  if (type === 'descriptive') return { text: '描述性（不判定）', tone: 'mute' };
  const ok = Array.isArray(ci) && ci.length === 2 && ci.every(Number.isFinite);
  if (type === 'dev') {
    const side = !ok
      ? ''
      : ci[0] > 0
        ? '（区间高于 0）'
        : ci[1] < 0
          ? '（区间低于 0）'
          : '（区间跨 0）';
    return { text: `开发检查${side}`, tone: 'mute' };
  }
  if (!ok) return { text: '—', tone: 'mute' };
  if (type === 'gate')
    return ci[0] > 0
      ? { text: `${rule.pass || '过关'}（开发检查）`, tone: 'ok' }
      : { text: `未过关（开发检查）`, tone: ci[1] < 0 ? 'bad' : 'warn' };
  if (ci[0] > 0) return { text: '正向证据', tone: 'ok' };
  if (ci[1] < 0) return { text: '负', tone: 'bad' };
  return { text: '零结果/不确定', tone: 'warn' };
}

const RULE_LABEL = {
  heldout: '预登记留出',
  gate: '开发检查',
  dev: '开发检查',
  descriptive: '描述性',
};

const STATE_TEXT = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  skipped: '未运行',
};

/* ---------- result extraction, one per kind ---------- */

function matchResult(s, planned) {
  const rows = [
    ['每副焦点队平均升级分', `${signed(s.meanSignedPoints)} ${interval(s.ci95)}`],
    [
      '完成副数／局数',
      `${num(s.pairs ?? s.completedPairsTotal)}${planned ? ` / 计划 ${num(planned)}` : ''} 副 · ${num(s.rounds)} 局`,
    ],
    ['焦点队 胜／负（局）', `${num(s.focalWins)} / ${num(s.focalLosses)}`],
  ];
  if (Number.isFinite(s.completedPairsTotal) && s.completedPairsTotal > (s.pairs ?? 0))
    rows.push(['连续前缀外未计入（副）', num(s.completedPairsTotal - (s.pairs ?? 0))]);
  if (s.pairsPositive != null)
    rows.push([
      '副：正／负／零',
      `${num(s.pairsPositive)} / ${num(s.pairsNegative)} / ${num(s.pairsZero)}`,
    ]);
  if (s.decisionsDifferentFromChampion != null) {
    const base = s.searchedDecisions ?? s.studentEndgameDecisions;
    rows.push([
      '与冠军不同的决策',
      `${num(s.decisionsDifferentFromChampion)}${base != null ? ` / ${num(base)}` : ''}`,
    ]);
  }
  return rows;
}

/**
 * A preregistered held-out size that was not reached (stopped by its time cap or the deadline) keeps
 * the rule's verdict but says so; the planned size is part of the preregistration.
 */
export function shortOfPlan(v, rule, pairs, planned) {
  if (!v || rule?.type !== 'heldout' || !planned || !Number.isFinite(pairs) || pairs >= planned)
    return v;
  return { text: `${v.text}（仅 ${num(pairs)} / 预登记 ${num(planned)} 副）`, tone: 'warn' };
}

function block(heading, rows, rule, ci, extra = {}) {
  const { pairs, planned, ...rest } = extra;
  return {
    heading,
    rows,
    rule: rule?.text || null,
    verdict: rule ? shortOfPlan(verdict(rule, ci), rule, pairs, planned) : null,
    ...rest,
  };
}

function resultsFor(stage, run, state) {
  const p = (rel) => (rel ? join(run, rel) : null);
  const paths = stage.paths || {};
  const out = [];
  switch (stage.kind) {
    case 'evaluate':
    case 'midgame': {
      const s = readJSON(join(p(paths.out), 'summary.json'));
      if (s)
        out.push(
          block('结果', matchResult(s, stage.total), stage.rule, s.ci95, {
            pairs: s.pairs,
            planned: stage.total,
          }),
        );
      break;
    }
    case 'compare': {
      const sides = stage.sides || [];
      for (const side of sides) {
        const s = readJSON(join(p(side.out), 'summary.json'));
        if (!s) continue;
        // Non-primary sides of a development comparison are still development checks.
        const rule = side.primary
          ? stage.rule
          : { type: stage.rule?.type === 'dev' ? 'dev' : 'descriptive', text: null };
        out.push(
          block(side.label, matchResult(s, stage.total), rule, s.ci95, {
            primary: !!side.primary,
            pairs: s.pairs,
            planned: stage.total,
          }),
        );
      }
      const [ia, ib] = stage.compareSides || [0, 1];
      const labelA = sides[ia]?.label || 'A',
        labelB = sides[ib]?.label || 'B';
      let c = paths.compare ? readJSON(p(paths.compare)) : null,
        source = paths.compare;
      // Fallback only once both sides have finished, so no interim peeking at partial runs.
      if (
        !c?.ci95 &&
        sides[ia] &&
        sides[ib] &&
        existsSync(join(p(sides[ia].out), 'summary.json')) &&
        existsSync(join(p(sides[ib].out), 'summary.json'))
      ) {
        c = compareRows(midgameRows(p(sides[ia].out)).prefix, midgameRows(p(sides[ib].out)).prefix);
        source = '面板按两边 part-*.jsonl 的连续完成前缀现算；正式数字以 compare 文件为准';
      }
      if (c && Array.isArray(c.ci95)) {
        const rule = stage.sides?.some((s) => s.primary) ? stage.compareRule : stage.rule;
        out.push(
          block(
            `配对差（${labelB} − ${labelA}）`,
            [
              ['每副配对差', `${signed(c.meanDifference)} ${interval(c.ci95)}`],
              [`${labelA}／${labelB} 平均`, `${signed(c.meanA)} / ${signed(c.meanB)}`],
              [
                `${labelB} 更好／更差／相同（副）`,
                `${num(c.pairsBBetter)} / ${num(c.pairsABetter)} / ${num(c.pairsIdentical)}`,
              ],
              ['共同副数', num(c.commonPairs)],
            ],
            rule || { type: 'descriptive' },
            c.ci95,
            { source },
          ),
        );
      }
      break;
    }
    case 'metrics': {
      const m = readJSON(p(paths.result));
      if (!m) break;
      const g = m.logLikelihoodGainPerCopy || {};
      const rows = [
        [
          '每张对数损失 推断／均匀',
          `${plain(m.beliefModel?.logLossPerCopy)} / ${plain(m.uniform?.logLossPerCopy)}`,
        ],
        ['相对均匀的增益（每张）', `${signed(g.mean)} ${interval(g.ci95)}（${num(g.n)} 局）`],
        [
          '首选座位命中 推断／均匀',
          `${plain(m.beliefModel?.top1PerCopy)} / ${plain(m.uniform?.top1PerCopy)}`,
        ],
      ];
      for (const [band, v] of Object.entries(m.byTableCards || {}))
        rows.push([
          `桌面 ${band} 张 推断／均匀`,
          `${plain(v.beliefLogLossPerCopy)} / ${plain(v.uniformLogLossPerCopy)}`,
        ]);
      const ref = paths.reference ? readJSON(p(paths.reference)) : null;
      if (ref)
        rows.push([
          '对照：v1 同种子对数损失',
          `${plain(ref.beliefModel?.logLossPerCopy)}（增益 ${signed(ref.logLikelihoodGainPerCopy?.mean)}）`,
        ]);
      rows.push(['推断网络 SHA', short(m.beliefSHA256)]);
      out.push(block('推断质量（P1）', rows, stage.rule, g.ci95));
      break;
    }
    case 'train': {
      const r = readJSON(p(paths.result));
      if (!r) break;
      const v = r.finalValidation || {};
      out.push(
        block(
          '训练报告（只导出最终一步）',
          [
            ['步数', `${num(r.steps)}（${duration(r.trainSeconds)}）`],
            [
              '验证对数损失 模型／均匀',
              `${plain(v.modelLogLossPerCopy)} / ${plain(v.uniformLogLossPerCopy)}`,
            ],
            ['验证首选命中 模型／均匀', `${plain(v.modelTop1)} / ${plain(v.uniformTop1)}`],
            ['训练行／验证局', `${num(r.trainRows)} / ${num(r.valSeeds)}`],
            ['ONNX SHA', short(r.onnxSHA256)],
          ],
          stage.rule,
          null,
        ),
      );
      break;
    }
    case 'generate': {
      const s = readJSON(join(p(paths.out), 'summary.json'));
      if (!s) break;
      out.push(
        block(
          '生成汇总',
          [
            ['块／局', `${num(s.blocks)} / ${num(s.rounds)}`],
            ['样本行', num(s.rows)],
            ['用时', duration(s.wallSeconds)],
          ],
          stage.rule,
          null,
        ),
      );
      break;
    }
    case 'residual': {
      const s = readJSON(p(paths.result));
      const f = s?.validation?.final;
      if (!f) break;
      out.push(
        block(
          '第 6 槽验证标签',
          [
            [
              '平均标签遗憾 学生／冠军',
              `${plain(f.meanLabelRegret?.student, 4)} / ${plain(f.meanLabelRegret?.champion, 4)}`,
            ],
            [
              '信息决策命中保留集 学生／冠军',
              `${plain(f.informativeArgmaxInKeep?.student)} / ${plain(f.informativeArgmaxInKeep?.champion)}`,
            ],
            ['与冠军不同的决策', pct(f.differsFromChampion, 2)],
          ],
          stage.rule,
          null,
        ),
      );
      break;
    }
    case 'audit': {
      const s = readJSON(p(paths.result));
      const c = s?.decisionAudit?.critical;
      if (!c) break;
      const who = { human: '真人', champion: '冠军', student: '修正学生' };
      out.push(
        block(
          `关键尾盘决策命中明牌最优（${num(s.rounds)} 局）`,
          Object.entries(who)
            .filter(([k]) => c[k])
            .map(([k, label]) => [
              label,
              `${plain(c[k].optimalRate)} ${interval(c[k].ci95)}（${num(c[k].decisions)} 个决策）`,
            ]),
          stage.rule,
          null,
        ),
      );
      break;
    }
    case 'review': {
      const r = readJSON(p(paths.result));
      if (!r) break;
      const players = (r.players || []).slice().sort((a, b) => b.lostPoints - a.lostPoints);
      out.push(
        block(
          `每位玩家明牌事后丢分（${num(r.rounds?.length ?? r.rounds)} 局）`,
          players.map((x) => [
            x.player,
            `${num(x.lostPoints)} 分 · ${num(x.rounds)} 局 · 标记 ${num(x.flagged)}${x.assisted ? ` · 辅助 ${num(x.assisted)}` : ''}`,
          ]),
          stage.rule,
          null,
        ),
      );
      break;
    }
    default:
  }
  if (!out.length && (state === 'done' || state === 'failed'))
    out.push({ heading: '结果', rows: [['结果文件', '未找到（—）']], rule: stage.rule?.text });
  return out;
}

/* ---------- live progress, one per kind ---------- */

function lastStep(log) {
  let step = null;
  for (const m of readText(log).matchAll(/"step":\s*(\d+)/g)) step = Number(m[1]);
  return step;
}

function progressFor(stage, run, state, startMs, now) {
  const p = (rel) => (rel ? join(run, rel) : null);
  const paths = stage.paths || {};
  const elapsed = startMs ? (now - startMs) / 1000 : null;
  const res = { fraction: null, text: null, eta: null, cap: null };
  if (state === 'queued' || state === 'skipped') return res;
  switch (stage.kind) {
    case 'compare':
    case 'midgame': {
      const sides = stage.kind === 'compare' ? stage.sides || [] : [{ label: '', out: paths.out }];
      let done = 0,
        total = 0;
      const sideFractions = [];
      const parts = sides.map((side) => {
        const { run: r, lines } = midgameRows(p(side.out));
        const planned = Number(r?.pairs) || stage.total || 0;
        done += Math.min(lines, planned || lines);
        total += planned;
        if (planned) sideFractions.push(Math.min(1, lines / planned));
        if (Number.isFinite(r?.deadline)) res.cap = Math.max(res.cap ?? -Infinity, r.deadline);
        return `${side.label ? side.label + ' ' : ''}${num(lines)} / ${planned ? num(planned) : '—'} 副`;
      });
      res.fraction = total ? done / total : null;
      // Both sides must finish: the estimate follows the slowest side, not the pooled count.
      if (sideFractions.length) res.slowest = Math.min(...sideFractions);
      res.text = parts.join(' · ');
      break;
    }
    case 'generate': {
      const dir = p(paths.out);
      const r = readJSON(join(dir, 'run.json'));
      const names = listDir(dir).filter((f) => /^b\d+\.json$/.test(f));
      let total = stage.total || null,
        size = r?.block || null;
      if (Array.isArray(r?.seeds) && size) total = Math.ceil((r.seeds[1] - r.seeds[0] + 1) / size);
      const rounds = Array.isArray(r?.seeds) ? r.seeds[1] - r.seeds[0] + 1 : null;
      res.fraction = total ? Math.min(1, names.length / total) : null;
      res.text = `${num(names.length)} / ${total ? num(total) : '—'} 块${size ? `（约 ${num(Math.min(names.length * size, rounds ?? Infinity))} / ${num(rounds)} 局）` : ''}`;
      break;
    }
    case 'train':
    case 'residual': {
      const step = lastStep(p(paths.log));
      const total = stage.total || null;
      res.fraction = step != null && total ? Math.min(1, step / total) : null;
      res.text = `第 ${step == null ? '—' : num(step)} / ${total ? num(total) : '—'} 步${stage.capMinutes ? `（上限 ${stage.capMinutes} 分钟）` : ''}`;
      if (stage.capMinutes && startMs) res.cap = startMs + stage.capMinutes * 60_000;
      break;
    }
    case 'evaluate': {
      const r = readJSON(join(p(paths.out), 'run.json'));
      const workers = Number(r?.workers) || 0;
      const parts = listDir(p(paths.out)).filter((f) => /^part-\d+\.json$/.test(f)).length;
      if (state === 'running')
        res.text = `已运行 ${duration(elapsed)}；分片 ${parts}/${workers || '—'}（分片只在结束时写出，中途无更细进度）`;
      break;
    }
    default:
      if (state === 'running') res.text = `已运行 ${duration(elapsed)}（没有中间进度信号）`;
  }
  const etaFraction = res.slowest ?? res.fraction;
  delete res.slowest;
  if (state === 'running' && etaFraction > 0.02 && startMs) {
    const eta = startMs + (now - startMs) / etaFraction;
    res.eta = res.cap ? Math.min(eta, res.cap) : eta;
  } else if (state === 'running' && res.cap) res.eta = res.cap;
  if (state === 'done' && res.fraction == null && stage.kind !== 'evaluate') res.fraction = 1;
  if (state === 'done' && stage.kind === 'evaluate') {
    const s = readJSON(join(p(paths.out), 'summary.json'));
    if (s) {
      res.fraction = stage.total ? Math.min(1, s.pairs / stage.total) : 1;
      res.text = `${num(s.pairs)} / ${num(stage.total || s.pairs)} 副`;
    }
  }
  return res;
}

/* ---------- processes and machine ---------- */

/** Every process command line (ps); empty on failure. */
function processList() {
  try {
    return execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    return '';
  }
}

/** True when some command line names `path` as a whole argument (after "=" or a space). */
export function pathInCommands(psText, path) {
  if (!path) return false;
  for (const line of psText.split('\n')) {
    let at = line.indexOf(path);
    while (at >= 0) {
      const before = line[at - 1],
        after = line[at + path.length];
      if ((before === '=' || before === ' ') && (after === undefined || /[\s,]/.test(after)))
        return true;
      at = line.indexOf(path, at + 1);
    }
  }
  return false;
}

/** macOS keeps most memory as reclaimable cache; os.freemem() alone looks near zero. */
function availableMemoryGiB() {
  try {
    const text = execFileSync('vm_stat', { encoding: 'utf8' });
    const page = Number(/page size of (\d+)/.exec(text)?.[1] || 16384);
    const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1] || 0);
    return (
      ((pages('Pages free') +
        pages('Pages inactive') +
        pages('Pages speculative') +
        pages('Pages purgeable')) *
        page) /
      2 ** 30
    );
  } catch {
    return freemem() / 2 ** 30;
  }
}

function machine(run) {
  return {
    cpus: cpus().length,
    load1: loadavg()[0],
    freeMemoryGiB: availableMemoryGiB(),
    totalMemoryGiB: totalmem() / 2 ** 30,
    diskFreeGiB: (() => {
      try {
        const fs = statfsSync(run);
        return (fs.bavail * fs.bsize) / 2 ** 30;
      } catch {
        return null;
      }
    })(),
  };
}

/* ---------- snapshot ---------- */

function stageState(stage, log, ctx) {
  const ids = stage.ids || [stage.key];
  const ev = ids.map((id) => log.ids.get(id)).filter(Boolean);
  const starts = ev.map((e) => e.start).filter(Number.isFinite);
  const ends = ev.map((e) => e.end).filter(Number.isFinite);
  const failedEv = ev.find((e) => e.end != null && e.rc != null && e.rc !== 0);
  let allEnded = ids.every((id) => log.ids.get(id)?.end != null);
  // Stages logged with free-text markers instead of START/END lines (for example a backfill loop
  // writing "BACKFILL chunk ..." and "BACKFILL end"): config `markers: {start, end}` prefixes.
  if (stage.markers?.start && !starts.length) {
    const first = log.markers.find((m) => m.text.startsWith(stage.markers.start));
    if (first) {
      starts.push(first.at);
      const last = stage.markers.end
        ? log.markers.filter((m) => m.text.startsWith(stage.markers.end) && m.at >= first.at)
        : [];
      allEnded = last.length > 0;
      if (allEnded) ends.push(Math.max(...last.map((m) => m.at)));
    }
  }
  const doneWhen = (stage.doneWhen || []).map((rel) => join(ctx.run, rel));
  const doneByFiles = doneWhen.length > 0 && doneWhen.every((f) => existsSync(f));
  const skipEv = [...ids, ...(stage.skipIds || [])]
    .map((id) => log.ids.get(id))
    .find((e) => e?.skip);
  const queue = (ctx.config.orchestrators || []).find((o) => o.name === stage.queue);
  const lastMarker = (prefix) =>
    prefix
      ? Math.max(
          -Infinity,
          ...log.markers.filter((m) => m.text.startsWith(prefix)).map((m) => m.at),
        )
      : -Infinity;
  const queueEnded = queue ? lastMarker(queue.endMarker) > lastMarker(queue.startMarker) : false;
  let state,
    reason = null,
    start = starts.length ? Math.min(...starts) : null,
    end = ends.length ? Math.max(...ends) : null;
  // A signal exit (rc >= 128) at a STOP file, the deadline or a stop marker is the preregistered
  // stop, not a crash: the stage did not finish and counts as 未运行 for its unfinished part.
  const stopMarker = (e) =>
    log.markers.some(
      (m) => /STOP|deadline/i.test(m.text) && m.at >= e.start && m.at <= e.end + 60_000,
    );
  const stoppedBySignal =
    failedEv &&
    failedEv.rc >= 128 &&
    (ctx.stop || failedEv.end >= ctx.deadline - 60_000 || stopMarker(failedEv));
  const blocker = (stage.requires || [])
    .map((key) => ctx.states?.get(key))
    .find((x) => x && (x.state === 'failed' || x.state === 'skipped'));
  let stateText = null;
  if (stoppedBySignal) {
    state = 'skipped';
    stateText = '已停止';
    reason = `截止／STOP 时被停止（退出码 ${failedEv.rc}），未跑完`;
  } else if (failedEv) {
    state = 'failed';
    reason = `退出码 ${failedEv.rc}`;
  } else if (starts.length && allEnded) state = 'done';
  else if (doneByFiles) {
    state = 'done';
    const finished = doneWhen
      .map((f) => Date.parse(readJSON(f)?.finishedAt))
      .filter(Number.isFinite);
    end = finished.length ? Math.max(...finished) : end;
  } else if (starts.length) {
    state = 'running';
    if (queueEnded) {
      state = 'failed';
      reason = '队列已结束，但没有 END 记录';
    }
  } else if (skipEv) {
    state = 'skipped';
    reason = skipEv.skip.reason || 'SKIP';
  } else if (blocker) {
    state = 'skipped';
    reason = `前置阶段 ${blocker.key} ${blocker.state === 'failed' ? '失败' : '未运行'}，不会启动`;
  } else if (queueEnded) {
    state = 'skipped';
    reason = '队列已结束，未启动';
  } else if (ctx.now >= ctx.deadline) {
    state = 'skipped';
    reason = '已过截止，未运行';
  } else state = 'queued';
  if (state !== 'done' && state !== 'failed' && !stoppedBySignal) end = null;
  // A queued stage whose queue script logged its start but is no longer in the process list will
  // probably never start; say so without guessing a state (ps may be unavailable).
  let warning = null;
  if (state === 'queued' && queue?.startMarker && ctx.psText) {
    const started = lastMarker(queue.startMarker) > -Infinity;
    const name = isAbsolute(queue.name) ? queue.name : join(ctx.run, queue.name);
    if (started && !queueEnded && !pathInCommands(ctx.psText, name))
      warning = `队列脚本 ${queue.name} 不在进程列表里，可能不会再启动`;
  }
  return { state, stateText, reason, start, end, rc: failedEv?.rc ?? null, warning };
}

/**
 * Whole-window status from real files only. `options.now` and `options.psText` make it testable;
 * `options.machine === false` skips the vm_stat / statfs probe.
 */
export function snapshot(run, config, options = {}) {
  const now = options.now ?? Date.now();
  const psText = options.psText ?? processList();
  const deadline = Date.parse(config.deadline);
  const log = parseStagesLog(readText(join(run, 'stages.log')));
  const stop =
    existsSync(join(run, 'STOP')) ||
    (!!config.guanzeroRun && existsSync(join(config.guanzeroRun, 'STOP')));
  const ctx = { run, config, now, deadline, psText, stop, states: new Map() };
  const stages = (config.stages || []).map((stage) => {
    const base = {
      key: stage.key,
      ids: stage.ids || [stage.key],
      title: stage.title,
      desc: stage.desc || '',
      kind: stage.kind,
      after: stage.after || null,
      rule: stage.rule?.text || null,
      dev: stage.rule?.type !== 'heldout',
      ruleLabel: RULE_LABEL[stage.rule?.type] || RULE_LABEL.descriptive,
    };
    try {
      const s = stageState(stage, log, ctx);
      ctx.states.set(stage.key, { key: stage.key, state: s.state });
      const progress = progressFor(stage, run, s.state, s.start, now);
      const paths = [
        stage.paths?.out,
        stage.paths?.result,
        ...(stage.sides || []).map((x) => x.out),
      ].filter(Boolean);
      const processAlive =
        s.state === 'running' ? paths.some((rel) => pathInCommands(psText, join(run, rel))) : null;
      const results = resultsFor(stage, run, s.state);
      return {
        ...base,
        ...s,
        stateText: s.stateText || STATE_TEXT[s.state],
        startText: s.start ? eastern(s.start) : '—',
        endText: s.end ? eastern(s.end) : '—',
        seconds: s.start ? ((s.end ?? now) - s.start) / 1000 : null,
        durationText: s.start ? duration(((s.end ?? now) - s.start) / 1000) : '—',
        progress: { ...progress, etaText: progress.eta ? eastern(progress.eta) : null },
        processAlive,
        warning:
          s.state === 'running' && processAlive === false && now - s.start > 60_000
            ? '未在进程列表里找到对应的输出路径'
            : s.warning,
        results,
      };
    } catch (error) {
      return { ...base, state: 'queued', stateText: '读取出错', error: error.message, results: [] };
    }
  });
  if (config.guanzeroRun) {
    for (const card of guanzeroCards(config.guanzeroRun, now))
      stages.push({
        ...card,
        stateText: STATE_TEXT[card.state],
        startText: card.start ? eastern(card.start) : '—',
        endText: card.end ? eastern(card.end) : '—',
        durationText: card.start ? duration(((card.end ?? now) - card.start) / 1000) : '—',
        progress: {
          ...card.progress,
          etaText: card.progress.eta ? eastern(card.progress.eta) : null,
        },
      });
  }
  const running = stages.filter((s) => s.state === 'running');
  const queued = stages.filter((s) => s.state === 'queued');
  const orchestrators = (config.orchestrators || []).map((o) => ({
    name: o.name,
    alive: pathInCommands(psText, isAbsolute(o.name) ? o.name : join(run, o.name)),
  }));
  let headline, tone;
  if (stop)
    [headline, tone] = [
      config.guanzeroRun ? '训练已请求停止，评测查看各阶段状态' : '已放 STOP 文件：所有阶段会停下',
      'bad',
    ];
  else if (now >= deadline) [headline, tone] = ['已过截止', 'warn'];
  else if (running.length) [headline, tone] = [`正在跑 ${running.length} 项`, 'ok'];
  else if (queued.length) [headline, tone] = ['没有阶段在运行，有排队项', 'warn'];
  else [headline, tone] = ['全部阶段已结束', 'mute'];
  return {
    window: {
      title: config.title || '研究窗口',
      deadline: config.deadline,
      deadlineText: eastern(deadline, { date: true }),
      remainingSeconds: Math.max(0, (deadline - now) / 1000),
      remainingText: duration(Math.max(0, (deadline - now) / 1000)),
      startedText: log.markers.length ? eastern(log.markers[0].at, { date: true }) : '—',
      timeProgress: log.markers.length
        ? Math.min(1, Math.max(0, (now - log.markers[0].at) / (deadline - log.markers[0].at)))
        : null,
      stop,
      note: config.note || null,
    },
    now: {
      headline,
      tone,
      running: running.map((s) => ({
        title: s.title,
        text: s.progress?.text || `已运行 ${s.durationText}`,
        fraction: s.progress?.fraction ?? null,
        etaText: s.progress?.etaText || null,
        warning: s.warning,
      })),
      next: queued.map((s) => ({ title: s.title, after: s.after })),
    },
    counts: Object.fromEntries(
      Object.keys(STATE_TEXT).map((k) => [k, stages.filter((s) => s.state === k).length]),
    ),
    stages,
    orchestrators,
    markers: log.markers.slice(-6).map((m) => ({ at: eastern(m.at), text: m.text })),
    machine: options.machine === false ? null : machine(run),
    readAt: new Date(now).toISOString(),
  };
}

export function loadConfig(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.stages) || !config.deadline)
    throw Error('Config needs "deadline" and "stages"');
  return config;
}

export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>研究窗口面板</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#667085;--line:#e3e6ec;--accent:#2f6fde;--ok:#15803d;--bad:#b42318;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--ink:#e6e9ef;--muted:#98a2b3;--line:#2a313b;--accent:#6ea0ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:1080px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
.card h2{font-size:13px;color:var(--muted);margin:0 0 8px;font-weight:600}
.big{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}.row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
.row span:first-child{color:var(--muted)}.row span:last-child{text-align:right;overflow-wrap:anywhere}.num{font-variant-numeric:tabular-nums}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:6px 0}.bar>div{height:100%;background:var(--accent)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.mute{background:color-mix(in srgb,var(--muted) 15%,transparent);color:var(--muted)}.run{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent)}
.note{color:var(--muted);font-size:12px;margin-top:12px}
.now{margin-bottom:12px}.now .big{font-size:22px;margin:4px 0}.now p{margin:4px 0}.item{margin:8px 0}.item b{font-weight:650}
.stages{display:flex;flex-direction:column;gap:10px}.stage{border-left:4px solid var(--line)}
.stage.running{border-left-color:var(--accent)}.stage.done{border-left-color:var(--ok)}.stage.failed{border-left-color:var(--bad)}.stage.skipped{border-left-color:var(--warn)}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.head h3{font-size:15px;margin:0}.ids{color:var(--muted);font-size:12px}
.desc{margin:4px 0 6px;color:var(--ink)}.meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--muted);font-size:12px}
.res{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}.res h4{font-size:13px;margin:0 0 4px}
.rule{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:12px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.warnline{color:var(--warn);font-size:12px}
.marks .row span:first-child{white-space:nowrap}
</style></head><body><main>
<h1 id="title">研究窗口面板</h1><div class="sub" id="sub">读取中…</div>
<div class="card now" id="now"></div>
<div class="grid" id="grid"></div>
<div class="stages" id="stages"></div>
<p class="note">只读面板：每 3 秒读取运行目录里的 stages.log、各阶段日志和结果文件，不控制任何进程。所有时间为美东（多伦多）。“开发检查”只是开发牌局上的诊断，不是验收；只有预登记的留出评测按“95% 区间下界 &gt;0 为正向证据”判定。面板上的分数是每副焦点队平均升级分、配对差或推断质量，不是胜率，也不代表整体棋力。</p>
</main><script>
const f=(n,d=0)=>n==null||!isFinite(n)?'—':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d});
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pill=(t,c)=>'<span class="pill '+c+'">'+esc(t)+'</span>';
const stateTone={queued:'mute',running:'run',done:'ok',failed:'bad',skipped:'warn'};
const bar=x=>x==null?'':'<div class="bar"><div style="width:'+(Math.max(0,Math.min(1,x))*100).toFixed(1)+'%"></div></div>';
function stageCard(s){
let h='<div class="card stage '+s.state+'"><div class="head">'+pill(s.stateText||s.state,stateTone[s.state]||'mute')+'<h3>'+esc(s.title)+'</h3><span class="ids">'+esc(s.ids.join(' · '))+'</span>'+pill(s.ruleLabel||(s.dev?'开发检查':'预登记留出'),s.dev?'mute':'run')+'</div>';
h+='<div class="desc">'+esc(s.desc)+'</div><div class="meta"><span>开始 '+esc(s.startText||'—')+'</span><span>结束 '+esc(s.endText||'—')+'</span><span>用时 '+esc(s.durationText||'—')+'</span>'+(s.reason?'<span>'+esc(s.reason)+'</span>':'')+(s.state==='queued'&&s.after?'<span>'+esc(s.after)+'</span>':'')+'</div>';
const p=s.progress||{};if((s.state==='running'||s.state==='done'||s.state==='failed')&&(p.text||p.fraction!=null)){h+=bar(p.fraction)+'<div class="row"><span>进度</span><span class="num">'+esc(p.text||(p.fraction!=null?f(p.fraction*100,1)+'%':'—'))+(s.state==='running'&&p.etaText?' · 预计 '+esc(p.etaText):'')+'</span></div>'}
if(s.warning)h+='<div class="warnline">'+esc(s.warning)+'</div>';if(s.error)h+='<div class="warnline">读取出错：'+esc(s.error)+'</div>';
for(const r of s.results||[]){h+='<div class="res"><h4>'+esc(r.heading)+'</h4>'+(r.rows||[]).map(x=>'<div class="row"><span>'+esc(x[0])+'</span><span class="num">'+esc(x[1])+'</span></div>').join('');
if(r.source)h+='<div class="note" style="margin-top:4px">来源：'+esc(r.source)+'</div>';
if(r.rule||r.verdict)h+='<div class="rule">'+(r.rule?'<span>规则：'+esc(r.rule)+'</span>':'')+(r.verdict?pill(r.verdict.text,r.verdict.tone):'')+'</div>';h+='</div>'}
if(!(s.results||[]).length&&s.rule)h+='<div class="rule"><span>规则：'+esc(s.rule)+'</span>'+pill(s.state==='running'||s.state==='queued'?'等待中':'—','mute')+'</div>';
return h+'</div>'}
async function tick(){let s;try{s=await (await fetch('api/status',{cache:'no-store'})).json()}catch(e){document.getElementById('sub').innerHTML=pill('面板连接中断','bad');return}
if(s.error){document.getElementById('sub').textContent=s.error;return}
const W=s.window,N=s.now,M=s.machine||{};document.getElementById('title').textContent=W.title;document.title=W.title;
document.getElementById('sub').innerHTML=(W.stop?pill('已放 STOP','bad'):pill('剩 '+W.remainingText,'ok'))+' &nbsp;截止 '+esc(W.deadlineText)+' · 读取于 '+new Date(s.readAt).toLocaleTimeString('zh-CN',{timeZone:'America/Toronto',hour12:false})+' 美东';
document.getElementById('now').innerHTML='<h2>现在在做什么</h2>'+pill(N.headline,N.tone)+(N.running.length?N.running.map(r=>'<div class="item"><b>'+esc(r.title)+'</b>'+bar(r.fraction)+'<div class="row"><span class="num">'+esc(r.text)+'</span><span>'+(r.etaText?'预计 '+esc(r.etaText):'')+'</span></div>'+(r.warning?'<div class="warnline">'+esc(r.warning)+'</div>':'')+'</div>').join(''):'<p>没有阶段在运行。</p>')+'<p><span style="color:var(--muted)">接下来：</span>'+(N.next.length?N.next.map(x=>esc(x.title)+(x.after?'（'+esc(x.after)+'）':'')).join('；'):'—')+'</p>';
const c=s.counts||{};
document.getElementById('grid').innerHTML='<div class="card"><h2>固定窗口</h2><div class="big">'+esc(W.remainingText)+'</div>'+bar(W.timeProgress)+'<div class="row"><span>开始</span><span>'+esc(W.startedText)+'</span></div><div class="row"><span>截止</span><span>'+esc(W.deadlineText)+'</span></div><div class="row"><span>STOP 文件</span><span>'+(W.stop?pill('存在','bad'):'没有')+'</span></div>'+(W.note?'<div class="note">'+esc(W.note)+'</div>':'')+'</div>'+
'<div class="card"><h2>阶段</h2><div class="chips">'+pill('已完成 '+(c.done||0),'ok')+pill('运行中 '+(c.running||0),'run')+pill('排队 '+(c.queued||0),'mute')+pill('失败 '+(c.failed||0),'bad')+pill('未运行 '+(c.skipped||0),'warn')+'</div>'+(s.orchestrators||[]).map(o=>'<div class="row"><span>'+esc(o.name)+'</span><span>'+(o.alive?pill('运行中','ok'):pill('未运行','mute'))+'</span></div>').join('')+'</div>'+
'<div class="card"><h2>本机</h2><div class="row"><span>负载（1 分钟，全机）</span><span class="num">'+f(M.load1,2)+' / '+(M.cpus||'—')+' 核</span></div><div class="row"><span>可用内存（含可回收）</span><span class="num">'+f(M.freeMemoryGiB,1)+' / '+f(M.totalMemoryGiB,0)+' GiB</span></div><div class="row"><span>磁盘剩余</span><span class="num">'+f(M.diskFreeGiB,0)+' GiB</span></div></div>'+
'<div class="card marks"><h2>stages.log 最近标记</h2>'+((s.markers||[]).map(m=>'<div class="row"><span>'+esc(m.at)+'</span><span>'+esc(m.text)+'</span></div>').join('')||'—')+'</div>';
document.getElementById('stages').innerHTML=(s.stages||[]).map(stageCard).join('')}
tick();setInterval(tick,3000);
</script></body></html>`;

function main() {
  const runOption = option('run'),
    configOption = option('config');
  if (!runOption || !configOption) throw Error('Usage: --run=<dir> --config=<json> [--port=8768]');
  const run = resolve(runOption);
  const configFile = isAbsolute(configOption) ? configOption : resolve(configOption);
  const port = Number(option('port', 8768));
  createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url.startsWith('/api/status')) {
      let body;
      try {
        body = snapshot(run, loadConfig(configFile));
      } catch (error) {
        body = { error: error.message };
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.url === '/' || request.url.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    response.writeHead(404).end();
  }).listen(port, '127.0.0.1', () => console.log(`Window dashboard: http://127.0.0.1:${port}/`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
