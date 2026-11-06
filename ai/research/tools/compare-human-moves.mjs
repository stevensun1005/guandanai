#!/usr/bin/env node
/**
 * Compare a player's real moves in exported public match records with a danMCai model.
 *
 *   node ai/research/tools/compare-human-moves.mjs <record.txt> [more.txt ...]
 *     --player <name>     whose moves to compare (default: the one name that is not 下家/对家/上家)
 *     --exporter <name>   who exported the record, if not the player and no bot labels show it
 *     --model <id>        catalog model id (default: the current danMCai champion)
 *     --model-file <path> ONNX file (default: web/dist/models/<file>; run `npm run build` first)
 *     --clear <gap>       value gap counted as a clear disagreement (default 0.5)
 *     --out <dir>         output folder (default: web/artifacts/analysis/human-moves, git-ignored)
 *
 * The model is scored exactly as the in-game coach in a normal game: own hand, public history,
 * counts and match context; no other hands and no full-information search. Values are relative
 * action scores, not probabilities or win rates. Records may contain personal play: outputs stay
 * in an ignored folder and are not uploaded or used for training.
 */
import * as ort from 'onnxruntime-web';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '../../../web/src/ai/model-catalog.json' with { type: 'json' };
import { botModel, botModelName } from '../../../web/src/ai/model-catalog.mjs';
import { inferPolicy } from '../../../web/src/ai/policy-inference.mjs';
import { coachObservation, prepareCoachPolicy } from '../../../web/src/coach/evaluation.mjs';
import { makeDeck, cardText, TYPE_NAME } from '../../../web/src/core/cards.js';
import { analyze, beats, strength } from '../../../web/src/core/combinations.js';
import { BOMB_TYPES, parseMatchRecord, planKey, replayDecisions } from './human-moves.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LABELS = new Set(['下家', '对家', '上家']);

function options(argv) {
  const opts = { files: [], clear: 0.5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--player') opts.player = value();
    else if (arg === '--exporter') opts.exporter = value();
    else if (arg === '--model') opts.model = value();
    else if (arg === '--model-file') opts.modelFile = value();
    else if (arg === '--clear') opts.clear = Number(value());
    else if (arg === '--out') opts.out = value();
    else if (arg.startsWith('--')) throw Error(`Unknown option ${arg}`);
    else opts.files.push(arg);
  }
  if (!opts.files.length) throw Error('Give at least one exported record');
  if (!(opts.clear > 0.2)) throw Error('--clear must be above 0.2');
  return opts;
}

function guessPlayer(rounds) {
  const names = new Set(rounds.flatMap((round) => round.entries.map((e) => e.name)));
  const people = [...names].filter((name) => !LABELS.has(name) && !/^座位\d$/.test(name));
  if (people.length !== 1) throw Error(`Use --player: names found ${[...names].join(', ')}`);
  return people[0];
}

const show = (cards) => (cards?.length ? cards.map(cardText).join(' ') : '过');
const deck = makeDeck();
const median = (list) => {
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function scoreDecision(session, model, decision) {
  const { game, actual, reading } = decision;
  const input = prepareCoachPolicy(coachObservation(game));
  const level = game.L,
    current = game.trick?.play;
  const shapeOf = (cards) =>
    cards.length
      ? analyze(cards, level)
          .filter((shape) => beats(shape, current))
          .sort((a, b) => strength(b) - strength(a))[0]
      : null;
  const actualKey = planKey(reading, actual, level);
  const keys = input.actions.map((ids) => {
    const cards = ids.map((id) => deck[id]);
    return planKey(shapeOf(cards), cards, level);
  });
  const inCandidates = keys.includes(actualKey);
  if (!inCandidates) {
    input.actions.push(actual.map((card) => card.id));
    input.actionShapes.push(reading && { ...reading, wu: 0 });
    keys.push(actualKey);
  }
  const { values } = await inferPolicy(ort, session, input, model.config);
  // best value per plan, as the coach's Top 5 groups them
  const plans = new Map();
  keys.forEach((key, index) => {
    if (!plans.has(key) || values[index] > plans.get(key).value)
      plans.set(key, { key, value: values[index], ids: input.actions[index] });
  });
  const ranked = [...plans.values()].sort((a, b) => b.value - a.value);
  const rank = ranked.findIndex((plan) => plan.key === actualKey) + 1;
  const top = ranked[0],
    low = ranked.at(-1).value,
    own = ranked[rank - 1].value;
  const topCards = top.ids.map((id) => deck[id]);
  const topShape = shapeOf(topCards);
  return {
    round: decision.round,
    step: decision.step,
    lead: decision.lead,
    handSize: decision.handSize,
    trick: decision.trickCards ? show(decision.trickCards) : null,
    trickByPartner: decision.trickSeat === 2,
    plans: ranked.length,
    actual: show(actual),
    actualType: reading?.type || 'pass',
    rank,
    inCandidates,
    percent: top.value - low < 1e-6 ? 100 : Math.round((100 * (own - low)) / (top.value - low)),
    gap: +(top.value - own).toFixed(4),
    modelType: topShape?.type || 'pass',
    top: ranked.slice(0, 3).map((plan) => ({
      play: show(plan.ids.map((id) => deck[id])),
      value: +plan.value.toFixed(4),
    })),
  };
}

function summarize(rows, clear) {
  const choice = rows.filter((row) => row.plans > 1);
  const differ = choice.filter((row) => row.rank > 1);
  const count = (list, test) => list.filter(test).length;
  const follow = choice.filter((row) => !row.lead),
    lead = choice.filter((row) => row.lead);
  const phase = (low, high) => {
    const part = choice.filter((row) => row.handSize >= low && row.handSize <= high);
    return { n: part.length, top1: count(part, (row) => row.rank === 1) };
  };
  const leadTypes = {};
  for (const row of lead) {
    leadTypes[row.actualType] ??= { player: 0, model: 0 };
    leadTypes[row.modelType] ??= { player: 0, model: 0 };
    leadTypes[row.actualType].player++;
    leadTypes[row.modelType].model++;
  }
  return {
    decisions: rows.length,
    withChoice: choice.length,
    top1: count(choice, (row) => row.rank === 1),
    top3: count(choice, (row) => row.rank <= 3),
    notInCandidates: count(choice, (row) => !row.inCandidates),
    medianPercent: median(choice.map((row) => row.percent)),
    disagreements: {
      total: differ.length,
      nearTie: count(differ, (row) => row.gap < 0.05),
      small: count(differ, (row) => row.gap >= 0.05 && row.gap < 0.2),
      moderate: count(differ, (row) => row.gap >= 0.2 && row.gap < clear),
      clear: count(differ, (row) => row.gap >= clear),
    },
    lead: { n: lead.length, top1: count(lead, (row) => row.rank === 1), types: leadTypes },
    follow: {
      n: follow.length,
      top1: count(follow, (row) => row.rank === 1),
      playerPassModelPlays: count(
        follow,
        (row) => row.actualType === 'pass' && row.modelType !== 'pass',
      ),
      playerPassModelBombs: count(
        follow,
        (row) => row.actualType === 'pass' && BOMB_TYPES.has(row.modelType),
      ),
      playerPlaysModelPasses: count(
        follow,
        (row) => row.actualType !== 'pass' && row.modelType === 'pass',
      ),
      playerBombsModelPasses: count(
        follow,
        (row) => BOMB_TYPES.has(row.actualType) && row.modelType === 'pass',
      ),
      overPartner: {
        n: count(follow, (row) => row.trickByPartner),
        playerPlays: count(follow, (row) => row.trickByPartner && row.actualType !== 'pass'),
        modelPlays: count(follow, (row) => row.trickByPartner && row.modelType !== 'pass'),
      },
    },
    phases: { early: phase(20, 27), middle: phase(10, 19), late: phase(1, 9) },
  };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const typeName = (type) => (type === 'pass' ? '过' : TYPE_NAME[type] || type);

function report({ meta, summary: s, clearRows }) {
  const lines = [
    `# 真人出牌与模型对比`,
    '',
    `- 玩家：${meta.player}；记录：${meta.files.join('、')}`,
    `- 模型：${meta.model}（${meta.modelId}，SHA-256 ${meta.modelSHA256.slice(0, 12)}…）`,
    `- 使用局：${meta.rounds.map((x) => `${meta.rounds.length > 1 ? x.file + ' ' : ''}第 ${x.rounds.join('、') || '—'} 局`).join('；')}；跳过：${meta.skipped.map((x) => `${meta.rounds.length > 1 ? x.file + ' ' : ''}第 ${x.round} 局（只出了 ${x.played} 张，起手牌无法还原）`).join('、') || '无'}`,
    `- 口径：模型只看本人手牌、公开出牌、各家张数与级数，与普通局的推荐相同；数值是候选之间的相对分，不是胜率。`,
    '',
    `## 总体`,
    '',
    `| 指标 | 结果 |`,
    `| --- | --- |`,
    `| 有选择的决策 | ${s.withChoice}（共 ${s.decisions}） |`,
    `| 与模型第一选择相同 | ${s.top1}（${pct(s.top1, s.withChoice)}） |`,
    `| 在模型前三 | ${s.top3}（${pct(s.top3, s.withChoice)}） |`,
    `| 不同的手：几乎打平（<0.05）/ 小差（<0.2）/ 中等（<${meta.clear}）/ 明显 | ${s.disagreements.nearTie} / ${s.disagreements.small} / ${s.disagreements.moderate} / ${s.disagreements.clear} |`,
    `| 领出时相同 | ${s.lead.top1} / ${s.lead.n} |`,
    `| 跟牌时相同 | ${s.follow.top1} / ${s.follow.n} |`,
    `| 你过、模型要出（其中炸弹） | ${s.follow.playerPassModelPlays}（${s.follow.playerPassModelBombs}） |`,
    `| 你出、模型要过（其中你用炸弹） | ${s.follow.playerPlaysModelPasses}（${s.follow.playerBombsModelPasses}） |`,
    `| 队友的牌上：你压 / 模型要压 | ${s.follow.overPartner.playerPlays} / ${s.follow.overPartner.modelPlays}（共 ${s.follow.overPartner.n}） |`,
    `| 前段（20–27 张）相同 | ${s.phases.early.top1} / ${s.phases.early.n} |`,
    `| 中段（10–19 张）相同 | ${s.phases.middle.top1} / ${s.phases.middle.n} |`,
    `| 残局（1–9 张）相同 | ${s.phases.late.top1} / ${s.phases.late.n} |`,
    '',
    `## 领出牌型`,
    '',
    `| 牌型 | 你 | 模型第一选择 |`,
    `| --- | --- | --- |`,
    ...Object.entries(s.lead.types)
      .sort((a, b) => b[1].player + b[1].model - (a[1].player + a[1].model))
      .map(([type, n]) => `| ${typeName(type)} | ${n.player} | ${n.model} |`),
    '',
    `## 明显分歧（差距 ≥ ${meta.clear}）`,
    '',
    `| 局 | 手 | 张数 | 局面 | 你 | 名次 | 模型第一 | 差距 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...clearRows.map(
      (row) =>
        `| ${row.round} | ${row.step} | ${row.handSize} | ${row.lead ? '领出' : `跟 ${row.trick}${row.trickByPartner ? '（队友）' : ''}`} | ${row.actual} | ${row.rank}/${row.plans} | ${row.top[0].play} | ${row.gap} |`,
    ),
    '',
    `单场或少数几场只能看出习惯差异，不能说明哪一方对：模型的分数没有和真实结果校准。出牌前如果看过 Top 5 数字，那些手不算完全独立的真人判断。`,
  ];
  return lines.join('\n') + '\n';
}

async function main() {
  const opts = options(process.argv.slice(2));
  const modelId = opts.model || catalog.selection.danMCaiChampions[0];
  const model = botModel(modelId);
  if (!model) throw Error(`Unknown model ${modelId}`);
  const modelFile = resolve(opts.modelFile || join(ROOT, 'web/dist/models', model.file));
  if (!existsSync(modelFile))
    throw Error(`Model file missing: ${modelFile}. Run \`npm run build\` or pass --model-file`);
  const bytes = readFileSync(modelFile);
  const { createHash } = await import('node:crypto');
  const modelSHA256 = createHash('sha256').update(bytes).digest('hex');
  if (model.sha256 && model.sha256 !== modelSHA256)
    throw Error(`SHA-256 of ${modelFile} does not match the catalog entry for ${model.id}`);
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const rows = [],
    rounds = [],
    skipped = [],
    warnings = [];
  let player = opts.player;
  for (const file of opts.files) {
    const parsed = parseMatchRecord(readFileSync(file, 'utf8'));
    player ??= guessPlayer(parsed);
    const replay = replayDecisions(parsed, player, { exporter: opts.exporter });
    for (const decision of replay.decisions)
      rows.push({ file: basename(file), ...(await scoreDecision(session, model, decision)) });
    rounds.push({
      file: basename(file),
      rounds: [...new Set(replay.decisions.map((d) => d.round))],
    });
    skipped.push(...replay.skipped.map((x) => ({ file: basename(file), ...x })));
    warnings.push(...replay.warnings.map((w) => `${basename(file)}: ${w}`));
  }
  await session.release();
  const summary = summarize(rows, opts.clear);
  const clearRows = rows
    .filter((row) => row.plans > 1 && row.rank > 1 && row.gap >= opts.clear)
    .sort((a, b) => b.gap - a.gap);
  const meta = {
    player,
    files: opts.files.map((file) => basename(file)),
    modelId: model.id,
    model: botModelName(model.id),
    modelSHA256,
    rounds,
    skipped,
    warnings,
    clear: opts.clear,
    createdAt: new Date().toISOString(),
  };
  const out = resolve(opts.out || join(ROOT, 'web/artifacts/analysis/human-moves'));
  mkdirSync(out, { recursive: true });
  const stem = `${player}-${model.id}`.replace(/[^\p{L}\p{N}_-]+/gu, '_');
  writeFileSync(join(out, `${stem}.json`), JSON.stringify({ meta, summary, rows }, null, 1));
  writeFileSync(join(out, `${stem}.md`), report({ meta, summary, clearRows }));
  console.log(
    JSON.stringify(
      {
        player,
        model: meta.model,
        withChoice: summary.withChoice,
        top1: summary.top1,
        top3: summary.top3,
        clear: summary.disagreements.clear,
        skipped,
        warnings,
        report: join(out, `${stem}.md`),
      },
      null,
      1,
    ),
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
