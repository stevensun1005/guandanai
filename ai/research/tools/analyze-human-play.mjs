/** Read-only D1 census and same-observation policy comparison; no training or continuation games. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';
import * as ort from 'onnxruntime-node';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { isWild } from '../../../web/src/core/cards.js';
import { validateRecord } from '../../../web/src/collection/validate.mjs';
import { replay, modelChoice } from '../../danMCai/endgame/human-endgames.mjs';
import { isMain } from '../../danMCai/endgame/platform.mjs';
import { createModelPool } from '../../danMCai/training/continuous/lib.mjs';
import { BOMB_TYPES, planKey } from './human-moves.mjs';

export const cohortOf = (a) =>
  a.actor !== 'human'
    ? a.actor
    : a.assisted === true
      ? 'human-assisted'
      : a.assisted === false
        ? 'human-explicit-unassisted'
        : 'human-assistance-unknown';
const primary = (r) =>
  r.cohort === 'human-explicit-unassisted' || r.cohort === 'human-assistance-unknown';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const inc = (o, k) => {
  o[k] = (o[k] || 0) + 1;
};
const count = (rows, f) => rows.filter(f).length;
const rate = (n, d) => ({ numerator: n, denominator: d, rate: d ? n / d : null });

export async function compareDecision(game, play, models, values) {
  const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
  const key = (p) => planKey(p, p?.cards || [], game.L);
  const actualKey = key(play),
    keys = plays.map(key),
    plans = new Set(keys).size;
  const choices = {};
  for (const model of models) {
    const result = await modelChoice(values, model.file, game, plays),
      selected = plays[result.index];
    choices[model.id] = {
      samePlan: keys[result.index] === actualKey,
      auto: result.auto,
      type: selected?.type || 'pass',
      cards: selected?.cards.length || 0,
      usesWild: !!selected?.cards.some((c) => isWild(c, game.L)),
    };
  }
  return {
    plans,
    covered: keys.includes(actualKey),
    actualType: play?.type || 'pass',
    actualCards: play?.cards.length || 0,
    actualUsesWild: !!play?.cards.some((c) => isWild(c, game.L)),
    lead: !game.trick,
    partnerTrick: game.trick?.player === (game.turn + 2) % 4,
    canRespond: plays.some(Boolean),
    canBomb: plays.some((p) => p && BOMB_TYPES.has(p.type)),
    handSize: game.hands[game.turn].length,
    totalRemaining: game.hands.reduce((s, h) => s + h.length, 0),
    choices,
  };
}

export function summarizeRows(rows, modelID = '029') {
  const eligible = rows.filter(primary),
    choice = eligible.filter((r) => r.plans > 1 && !r.choices[modelID].auto);
  const covered = choice.filter((r) => r.covered),
    lead = choice.filter((r) => r.lead),
    follow = choice.filter((r) => !r.lead && r.canRespond),
    partner = follow.filter((r) => r.partnerTrick),
    bomb = choice.filter((r) => r.canBomb);
  const pairedRate = (group, human, model) => ({
    human: rate(count(group, human), group.length),
    model: rate(count(group, model), group.length),
  });
  const types = {};
  for (const r of lead) {
    const a = (types[r.actualType] ||= { human: 0, model: 0 });
    a.human++;
    const b = (types[r.choices[modelID].type] ||= { human: 0, model: 0 });
    b.model++;
  }
  const phases = {};
  for (const [label, keep] of [
    ['hand20plus', (r) => r.handSize >= 20],
    ['hand10to19', (r) => r.handSize >= 10 && r.handSize <= 19],
    ['hand1to9', (r) => r.handSize <= 9],
  ]) {
    const part = covered.filter(keep);
    phases[label] = rate(
      count(part, (r) => r.choices[modelID].samePlan),
      part.length,
    );
  }
  return {
    observedActions: eligible.length,
    decisionOpportunities: choice.length,
    forcedOrAutoFinishExcluded: eligible.length - choice.length,
    actualPlansMissingFromGenerator: choice.length - covered.length,
    samePlan: rate(
      count(covered, (r) => r.choices[modelID].samePlan),
      covered.length,
    ),
    lead: {
      n: lead.length,
      types,
      wild: pairedRate(
        lead,
        (r) => r.actualUsesWild,
        (r) => r.choices[modelID].usesWild,
      ),
      meanCards: {
        human: lead.length ? lead.reduce((s, r) => s + r.actualCards, 0) / lead.length : null,
        model: lead.length
          ? lead.reduce((s, r) => s + r.choices[modelID].cards, 0) / lead.length
          : null,
      },
    },
    follow: {
      n: follow.length,
      pass: pairedRate(
        follow,
        (r) => r.actualType === 'pass',
        (r) => r.choices[modelID].type === 'pass',
      ),
      humanPassModelPlays: count(
        follow,
        (r) => r.actualType === 'pass' && r.choices[modelID].type !== 'pass',
      ),
      humanPlaysModelPasses: count(
        follow,
        (r) => r.actualType !== 'pass' && r.choices[modelID].type === 'pass',
      ),
    },
    partner: {
      n: partner.length,
      play: pairedRate(
        partner,
        (r) => r.actualType !== 'pass',
        (r) => r.choices[modelID].type !== 'pass',
      ),
    },
    bomb: {
      n: bomb.length,
      play: pairedRate(
        bomb,
        (r) => BOMB_TYPES.has(r.actualType),
        (r) => BOMB_TYPES.has(r.choices[modelID].type),
      ),
    },
    phases,
  };
}

/** Resample whole recorded match IDs; repeated people across matches remain a stated limitation. */
export function pairedMatchIntervals(rows, modelID = '029', repeats = 2000) {
  const groups = [...new Set(rows.filter(primary).map((r) => r.match))].map((id) =>
    rows.filter((r) => r.match === id),
  );
  let state = 2026111507;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const metrics = (s) => ({
    samePlan: s.samePlan.rate,
    followPassHumanMinusModel:
      s.follow.pass.human.rate == null ? null : s.follow.pass.human.rate - s.follow.pass.model.rate,
    partnerPlayHumanMinusModel:
      s.partner.play.human.rate == null
        ? null
        : s.partner.play.human.rate - s.partner.play.model.rate,
    bombPlayHumanMinusModel:
      s.bomb.play.human.rate == null ? null : s.bomb.play.human.rate - s.bomb.play.model.rate,
  });
  const samples = {};
  if (!groups.length) return {};
  // Keep per-match sufficient summaries; do not copy the private hands or rerun inference.
  for (let b = 0; b < repeats; b++) {
    const sample = [];
    for (let j = 0; j < groups.length; j++)
      sample.push(...groups[Math.floor(random() * groups.length)]);
    for (const [k, v] of Object.entries(metrics(summarizeRows(sample, modelID))))
      if (v != null) (samples[k] ||= []).push(v);
  }
  return Object.fromEntries(
    Object.entries(samples).map(([k, v]) => {
      v.sort((a, b) => a - b);
      return [
        k,
        {
          matches: groups.length,
          bootstrapReplicates: v.length,
          ci95: [v[Math.floor(0.025 * v.length)], v[Math.floor(0.975 * v.length)]],
        },
      ];
    }),
  );
}

async function main() {
  const arg = (k) => process.argv.find((x) => x.startsWith('--' + k + '='))?.slice(k.length + 3);
  const protocolFile = resolve(arg('protocol')),
    p = JSON.parse(readFileSync(protocolFile, 'utf8')),
    root = resolve(p.localOutput),
    stop = join(root, 'STOP');
  if (existsSync(join(root, 'results.json')) || existsSync(join(root, 'decisions.jsonl')))
    throw Error('Preserve existing analysis; no overwrite');
  mkdirSync(root, { recursive: true });
  for (const m of p.models)
    if (hash(readFileSync(m.file)) !== m.sha256) throw Error('Model SHA mismatch ' + m.id);
  for (const [file, sha] of Object.entries(p.sourceSHA256))
    if (hash(readFileSync(join(p.sourceRoot, file))) !== sha)
      throw Error('Analysis source SHA mismatch');
  const check = async () => {
    while (freemem() < 4 * 2 ** 30) {
      if (Date.now() >= Date.parse(p.deadlineUTC) || existsSync(stop))
        throw Error('Analysis stopped');
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (Date.now() >= Date.parse(p.deadlineUTC) || existsSync(stop))
      throw Error('Analysis stopped');
  };
  const census = {
      downloadedRecords: 0,
      kinds: {},
      validRecords: 0,
      invalid: {},
      duplicates: 0,
      officialRounds: 0,
      sources: {},
      humanCounts: {},
      actionCohorts: {},
      matches: 0,
      modelActions: {},
      firstStartedAt: null,
      lastEndedAt: null,
      matchRoundCoverage: [],
    },
    files = readdirSync(p.localInput)
      .filter((f) => /^round-\d+\.json$/.test(f))
      .sort(),
    seen = new Map(),
    matches = new Map(),
    rows = [],
    manifests = [];
  const pool = await createModelPool(ort, { threads: 1, limit: p.models.length });
  try {
    for (const file of files) {
      await check();
      const text = readFileSync(join(p.localInput, file)),
        saved = JSON.parse(text),
        digest = hash(text);
      census.downloadedRecords++;
      inc(census.kinds, saved.kind);
      manifests.push({ file, sha256: digest });
      if (seen.has(saved.id)) {
        if (seen.get(saved.id) !== digest) throw Error('Conflicting round IDs');
        census.duplicates++;
        continue;
      }
      seen.set(saved.id, digest);
      const { result, levelsAfter, remaining, trust, ...raw } = saved;
      try {
        validateRecord(raw);
        census.validRecords++;
      } catch (e) {
        inc(census.invalid, e.message);
        continue;
      }
      if (raw.kind !== 'game') continue;
      census.officialRounds++;
      inc(census.sources, raw.appVersion.startsWith('c1977') ? 'Clint' : 'thisSite');
      inc(census.humanCounts, raw.seats.filter((s) => s.human).length);
      if (!census.firstStartedAt || raw.startedAt < census.firstStartedAt)
        census.firstStartedAt = raw.startedAt;
      if (!census.lastEndedAt || raw.endedAt > census.lastEndedAt) census.lastEndedAt = raw.endedAt;
      if (!matches.has(raw.matchId)) matches.set(raw.matchId, []);
      matches.get(raw.matchId).push(raw.round);
      for (const { index, action, game, play } of replay(raw)) {
        await check();
        const cohort = cohortOf(action);
        inc(census.actionCohorts, cohort);
        if (action.actor !== 'human') {
          inc(census.modelActions, action.model?.id || 'unknown');
          continue;
        }
        const row = {
          match: raw.matchId,
          round: raw.round,
          actionIndex: index,
          cohort,
          ...(await compareDecision(game, play, p.models, (...args) => pool.values(...args))),
        };
        rows.push(row);
        appendFileSync(join(root, 'decisions.jsonl'), JSON.stringify(row) + '\n');
      }
      writeFileSync(
        join(root, 'progress.json'),
        JSON.stringify({
          phase: 'running',
          processedRecords: census.downloadedRecords,
          totalRecords: files.length,
          humanDecisions: rows.length,
          updatedAtUTC: new Date().toISOString(),
        }) + '\n',
      );
    }
  } finally {
    await pool.close();
  }
  census.matches = matches.size;
  census.matchRoundCoverage = [...matches.values()]
    .map((v) => ({
      rounds: v.length,
      min: Math.min(...v),
      max: Math.max(...v),
      missingInsideRange: Math.max(...v) - Math.min(...v) + 1 - v.length,
    }))
    .sort((a, b) => b.rounds - a.rounds);
  writeFileSync(join(root, 'input-manifest.json'), JSON.stringify(manifests, null, 2) + '\n');
  const summaries = Object.fromEntries(p.models.map((m) => [m.id, summarizeRows(rows, m.id)])),
    assistance = Object.fromEntries(
      ['human-assisted', 'human-assistance-unknown', 'human-explicit-unassisted'].map((cohort) => [
        cohort,
        summarizeRows(
          rows
            .filter((r) => r.cohort === cohort)
            .map((r) => ({ ...r, cohort: 'human-explicit-unassisted' })),
          p.models[0].id,
        ),
      ]),
    );
  const result = {
    schema: 1,
    complete: true,
    census,
    models: p.models.map(({ file, ...rest }) => rest),
    summaries,
    assistance,
    intervals: pairedMatchIntervals(rows, p.models[0].id),
    protocolSHA256: hash(readFileSync(protocolFile)),
    inputManifestSHA256: hash(readFileSync(join(root, 'input-manifest.json'))),
    formalTrainingUpdates: 0,
    newSimulatedGames: 0,
    counterfactualContinuations: 0,
    completedAtUTC: new Date().toISOString(),
    limits: p.limits,
  };
  writeFileSync(join(root, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(
    join(root, 'progress.json'),
    JSON.stringify({
      phase: 'complete',
      humanDecisions: rows.length,
      updatedAtUTC: result.completedAtUTC,
    }) + '\n',
  );
  console.log(JSON.stringify({ complete: true, census, summaries }));
}

if (isMain(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
