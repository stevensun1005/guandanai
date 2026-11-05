import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { clusterEstimate } from './evaluate-trained.mjs';

function indexedResults(results) {
  if (!Array.isArray(results) || !results.length) throw Error('Empty evaluation');
  const indexed = new Map();
  for (const result of results) {
    if (!Number.isSafeInteger(result.seed) || result.seed < 0 || indexed.has(result.seed))
      throw Error('Invalid or duplicate deal seed');
    if (result.outcomes?.length !== 2) throw Error('Each deal requires both team assignments');
    const sides = new Map();
    for (const outcome of result.outcomes) {
      const { testedSide, winner, points, order } = outcome;
      if (
        ![0, 1].includes(testedSide) ||
        sides.has(testedSide) ||
        ![0, 1].includes(winner) ||
        ![1, 2, 3].includes(points) ||
        order?.length !== 4 ||
        new Set(order).size !== 4 ||
        !order.every((seat) => [0, 1, 2, 3].includes(seat)) ||
        order[0] % 2 !== winner
      )
        throw Error('Invalid outcome');
      const partnerPosition = order.indexOf((order[0] + 2) % 4);
      if (points !== (partnerPosition === 1 ? 3 : partnerPosition === 2 ? 2 : 1))
        throw Error('Points disagree with finishing order');
      const won = winner === testedSide;
      const signedPoints = (won ? 1 : -1) * points;
      if (outcome.won !== won || outcome.signedPoints !== signedPoints)
        throw Error('Stored win or points disagree with outcome');
      sides.set(testedSide, { won, signedPoints });
    }
    indexed.set(result.seed, sides);
  }
  return indexed;
}

function summarize(deals) {
  const metric = (model, key) =>
    clusterEstimate(
      deals.map((deal) => deal.sides.reduce((sum, side) => sum + Number(side[model][key]), 0) / 2),
      key === 'won' ? [0, 1] : null,
    );
  const difference = (key) =>
    clusterEstimate(
      deals.map(
        (deal) =>
          deal.sides.reduce(
            (sum, side) => sum + Number(side.candidate[key]) - Number(side.baseline[key]),
            0,
          ) / 2,
      ),
      key === 'won' ? [-1, 1] : null,
    );
  const pairedOutcomes = { bothWin: 0, candidateOnlyWins: 0, baselineOnlyWins: 0, bothLose: 0 };
  for (const deal of deals)
    for (const side of deal.sides) {
      const key = side.candidate.won
        ? side.baseline.won
          ? 'bothWin'
          : 'candidateOnlyWins'
        : side.baseline.won
          ? 'baselineOnlyWins'
          : 'bothLose';
      pairedOutcomes[key]++;
    }
  return {
    deals: deals.length,
    roundsPerModel: deals.length * 2,
    baselineWinRate: metric('baseline', 'won'),
    candidateWinRate: metric('candidate', 'won'),
    winRateDifference: difference('won'),
    baselineSignedPoints: metric('baseline', 'signedPoints'),
    candidateSignedPoints: metric('candidate', 'signedPoints'),
    signedPointsDifference: difference('signedPoints'),
    pairedOutcomes,
    byTestedTeam: [0, 1].map((testedTeam) => ({
      testedTeam,
      seats: [testedTeam, testedTeam + 2],
      roundsPerModel: deals.length,
      baselineWins: deals.filter((deal) => deal.sides[testedTeam].baseline.won).length,
      candidateWins: deals.filter((deal) => deal.sides[testedTeam].candidate.won).length,
      baselineWinRate: clusterEstimate(
        deals.map((deal) => Number(deal.sides[testedTeam].baseline.won)),
        [0, 1],
      ),
      candidateWinRate: clusterEstimate(
        deals.map((deal) => Number(deal.sides[testedTeam].candidate.won)),
        [0, 1],
      ),
    })),
  };
}

/** Compare whole paired deals, never treating the two seat assignments as independent samples. */
export function comparePolicyEvaluations(baselineResults, candidateResults) {
  const baseline = indexedResults(baselineResults);
  const candidate = indexedResults(candidateResults);
  if (baseline.size !== candidate.size || [...baseline.keys()].some((seed) => !candidate.has(seed)))
    throw Error('Evaluations must contain exactly the same deal seeds');
  const deals = [...baseline.keys()]
    .sort((a, b) => a - b)
    .map((seed) => ({
      seed,
      level: createRound(seed).L,
      sides: [0, 1].map((side) => ({
        baseline: baseline.get(seed).get(side),
        candidate: candidate.get(seed).get(side),
      })),
    }));
  return {
    confidenceMethod:
      '95% normal interval on independent per-deal means; both team assignments stay in one cluster. Subgroups are descriptive, not separate model-selection tests.',
    winDefinition: 'Team containing the first player to empty their hand.',
    ...summarize(deals),
    byLevel: Array.from({ length: 13 }, (_, index) => index + 2)
      .map((level) => ({ level, deals: deals.filter((deal) => deal.level === level) }))
      .filter((group) => group.deals.length)
      .map((group) => ({ level: group.level, ...summarize(group.deals) })),
  };
}

async function main() {
  const option = (name, fallback) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const directories = [option('baseline'), option('candidate')];
  if (directories.some((directory) => !directory))
    throw Error('Use --baseline=directory --candidate=directory');
  const read = async (directory, name) =>
    JSON.parse(await readFile(resolve(directory, name), 'utf8'));
  const summaries = await Promise.all(
    directories.map((directory) => read(directory, 'summary.json')),
  );
  for (const key of ['opponent', 'endgameCards', 'protocol', 'winDefinition'])
    if (summaries[0][key] !== summaries[1][key]) throw Error(`Evaluation protocols differ: ${key}`);
  const frozenSources = Object.keys(summaries[0].sourceSHA256 || {}).filter((path) =>
    /^(src\/(core|hand)\/|src\/ai\/(rule-policy|hand-value|candidates)\.|scripts\/lib\/(simulation|rule-baseline)\.)/.test(
      path,
    ),
  );
  if (!frozenSources.length) throw Error('Missing frozen opponent and game source hashes');
  for (const path of frozenSources)
    if (summaries[0].sourceSHA256[path] !== summaries[1].sourceSHA256?.[path])
      throw Error(`Game or opponent source changed: ${path}`);
  for (const path of ['ai/shared/simulation/simulation.mjs', 'web/src/core/cards.js'])
    if (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== summaries[0].sourceSHA256[path]
    )
      throw Error(`Cannot reconstruct deal levels with changed source: ${path}`);
  if (summaries[0].opponentModel?.sha256 !== summaries[1].opponentModel?.sha256)
    throw Error('Opponent models differ');
  const results = await Promise.all(
    directories.map((directory) => read(directory, 'results.json')),
  );
  const report = {
    schema: 1,
    baseline: summaries[0].testedModel,
    candidate: summaries[1].testedModel,
    opponent: summaries[0].opponent,
    endgameCards: summaries[0].endgameCards,
    inputResultsSHA256: await Promise.all(
      directories.map(async (directory) =>
        createHash('sha256')
          .update(await readFile(resolve(directory, 'results.json')))
          .digest('hex'),
      ),
    ),
    ...comparePolicyEvaluations(...results),
  };
  const output = resolve(option('output', resolve(directories[1], 'comparison.json')));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...report, byLevel: undefined }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
