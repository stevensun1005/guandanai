/** Compile private, match-isolated legal-action behavioral cloning data. No optimizer updates. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { candidates } from '../../../web/src/ai/candidates.js';
import { cardsArray } from '../../../web/src/ai/encoding.mjs';
import { policyState } from '../../../web/src/ai/observation.js';
import { humanExamples } from '../../shared/data/tools/human-examples.mjs';
import { encodeSample } from '../../danMCai/training/continuous/lib.mjs';
import { replay } from '../../danMCai/endgame/human-endgames.mjs';
import { isMain } from '../../danMCai/endgame/platform.mjs';
import { BOMB_TYPES } from './human-moves.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
export function imitationDecision(game, actual) {
  const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
  if (plays.length === 1 || plays.some((p) => p && p.cards.length === game.hands[game.turn].length))
    return null;
  const keys = new Map(),
    unique = [];
  for (const play of plays) {
    const key = String(cardsArray(play?.cards.map((c) => c.id) || []));
    if (!keys.has(key)) {
      keys.set(key, unique.length);
      unique.push(play);
    }
  }
  if (unique.length < 2) return null;
  const target = keys.get(String(cardsArray(actual?.cards.map((c) => c.id) || [])));
  if (target == null) throw Error('Human action omitted from legal face-vector candidates');
  const state = policyState(game, game.turn, 0, unique);
  return {
    features: unique.map((p) => encodeSample(state, p?.cards.map((c) => c.id) || [])),
    target,
    types: unique.map((p) => p?.type || 'pass'),
    actualType: actual?.type || 'pass',
    lead: !game.trick,
    partnerTrick: game.trick?.player === (game.turn + 2) % 4,
    canRespond: unique.some(Boolean),
    canBomb: unique.some((p) => p && BOMB_TYPES.has(p.type)),
  };
}

async function main() {
  const file = process.argv.find((x) => x.startsWith('--protocol='))?.slice(11);
  const plan = JSON.parse(readFileSync(resolve(file), 'utf8')),
    out = join(plan.run, 'data');
  if (existsSync(join(out, 'manifest.json')) || existsSync(join(out, 'features.i8')))
    throw Error('Dataset already exists');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'features.i8'), '');
  const input = JSON.parse(readFileSync(plan.inputManifest, 'utf8'));
  if (sha(readFileSync(plan.inputManifest)) !== plan.inputManifestSHA256)
    throw Error('Input snapshot manifest changed');
  const decisions = [],
    splits = {},
    matches = new Map();
  let rows = 0,
    eligible = 0;
  for (const entry of input) {
    if (Date.now() >= Date.parse(plan.deadlineUTC) || existsSync(join(plan.run, 'STOP')))
      throw Error('Preparation stopped');
    const text = readFileSync(join(plan.raw, entry.file));
    if (sha(text) !== entry.sha256) throw Error('Raw snapshot changed');
    const saved = JSON.parse(text);
    const examples = humanExamples(saved);
    if (!examples.length) continue;
    const selected = new Map(examples.map((x) => [x.actionIndex, x]));
    const { result, levelsAfter, remaining, trust, ...record } = saved;
    for (const { index, game, play } of replay(record)) {
      const example = selected.get(index);
      if (!example) continue;
      eligible++;
      const item = imitationDecision(game, play);
      if (!item) continue;
      const { features, ...meta } = item;
      appendFileSync(join(out, 'features.i8'), Buffer.concat(features.map((x) => Buffer.from(x))));
      const match = sha(Buffer.from('human-imitation-group:' + example.matchId));
      if (matches.has(match) && matches.get(match) !== example.split)
        throw Error('Match split leakage');
      matches.set(match, example.split);
      decisions.push({
        ...meta,
        start: rows,
        length: features.length,
        split: example.split,
        match,
      });
      rows += features.length;
      const s = (splits[example.split] ||= { decisions: 0, candidateRows: 0 });
      s.decisions++;
      s.candidateRows += features.length;
    }
  }
  writeFileSync(join(out, 'decisions.json'), JSON.stringify(decisions));
  for (const [split, s] of Object.entries(splits))
    s.matches = [...matches.values()].filter((x) => x === split).length;
  const manifest = {
    schema: 1,
    eligibleActions: eligible,
    decisions: decisions.length,
    excludedForcedOrFinish: eligible - decisions.length,
    candidateRows: rows,
    features: 567,
    distinctFaceVectors: true,
    sourceHumanChoiceOnly: true,
    splits,
    featureSHA256: sha(readFileSync(join(out, 'features.i8'))),
    decisionSHA256: sha(readFileSync(join(out, 'decisions.json'))),
    labels:
      'Local legal face-vector choice, cross entropy; context type tags are descriptive only, not loss inputs',
    noNamesRoomsOrOpponentHands: true,
    optimizerUpdates: 0,
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(plan.run, 'data-panel.json'),
    JSON.stringify({
      rows: [
        ['有效真人动作', eligible],
        ['可选决策', decisions.length],
        ...Object.entries(splits).map(([k, s]) => [k, `${s.matches}会话 / ${s.decisions}决策`]),
        ['隐私', '仅本人手牌/公开信息；已标辅助排除'],
      ],
    }),
  );
  console.log(JSON.stringify(manifest));
}
if (isMain(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
