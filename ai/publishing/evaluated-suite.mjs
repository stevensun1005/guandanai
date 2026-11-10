import { reasonProtocolDigest } from '../guanzero/training/evaluate-reason.mjs';
import { clintProtocolDigest, verifyClintMetadata } from '../guanzero/training/evaluate-clint.mjs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyFrozenReason, reasonProtocol } from '../guanzero/training/reason.mjs';
import { validSuiteReport } from '../guanzero/training/suite-reports.mjs';
import {
  DEFAULT_OPPONENTS,
  LEGACY_FIVE_OPPONENTS,
  THREE_OPPONENT_PANEL,
  LEGACY_THREE_OPPONENTS,
  TWO_OPPONENT_PANEL,
  REASON_PANELS,
  LEGACY_TWO_OPPONENTS,
  suiteOpponents,
  suiteReasonProtocol,
  suitePairs,
  MIXED_PANEL,
} from '../guanzero/training/opponents.mjs';
import { sha256 } from './artifacts.mjs';

export async function verifyEvaluatedSuite(directory, input, digest, source, root) {
  if (!directory) throw Error('GuanZero io48 requires --evaluated-suite');
  const suite = resolve(directory);
  const parent = dirname(suite);
  const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
  try {
    await readFile(join(suite, 'cancelled.json'));
    throw Error('Owner cancelled this suite; cannot publish');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const plan = await read(join(suite, 'plan.json'));
  const manifest = await read(join(parent, 'manifest.json'));
  // Unmarked historical plans always require all five reports. A missing report
  // cannot turn an old batch into a newer smaller batch.
  const legacy = plan.opponentPanel === undefined;
  const historicalThree = plan.opponentPanel === THREE_OPPONENT_PANEL;
  const panel = suiteOpponents(plan);
  const reasonPanel = REASON_PANELS.includes(plan.opponentPanel);
  if (reasonPanel) {
    verifyFrozenReason(suite, plan.reason, plan.champion);
    if (reasonProtocol(plan.reason) !== suiteReasonProtocol(plan))
      throw Error('Reason protocol and opponent panel differ');
  }
  if (plan.opponentPanel === MIXED_PANEL) verifyClintMetadata(plan.clint);
  for (const op of panel) suitePairs(plan, op);
  if (
    (!legacy && !historicalThree && plan.opponentPanel !== TWO_OPPONENT_PANEL && !reasonPanel) ||
    (source.run === 'guanzero-adp-io48' &&
      (legacy !== (plan.index === 5098) || (historicalThree && plan.index !== 5100))) ||
    resolve(input) !== join(suite, 'model.onnx') ||
    basename(parent) !== 'development-500' ||
    basename(dirname(parent)) !== 'eval' ||
    basename(dirname(dirname(parent))) !== source.run ||
    plan.id !== basename(suite) ||
    source.version !== plan.modelVersion ||
    !/^model-\d+$/.test(plan.modelVersion) ||
    Number(plan.modelVersion.slice(6)) !== source.step ||
    plan.modelSHA256 !== digest ||
    plan.protocol !== 'development-500-v1' ||
    plan.pairs !== 250 ||
    plan.seedEnd !== plan.seedStart + 249 ||
    !isDeepStrictEqual(plan.opponents, panel) ||
    !manifest.suites.some((s) => isDeepStrictEqual(s, plan))
  )
    throw Error('Frozen evaluation identity mismatch');

  const gateFile = plan.champion.gate.evidence;
  if (!/^ai\/research\/evaluation\/[\w-]+\/gate-\d+\.json$/.test(gateFile))
    throw Error('Invalid champion evidence');
  const gateBytes = await readFile(join(root, gateFile)),
    gate = JSON.parse(gateBytes);
  if (
    sha256(gateBytes) !== plan.champion.gate.evidenceSHA256 ||
    gate.decision !== 'accept' ||
    gate.challenger.version !== plan.champion.version ||
    gate.challenger.sha256 !== plan.champion.modelSHA256 ||
    sha256(await readFile(join(suite, 'champion.onnx'))) !== plan.champion.modelSHA256
  )
    throw Error('Frozen champion gate mismatch');

  const opponents = {};
  for (const op of panel) {
    const bytes = await readFile(join(suite, op, 'report.json'));
    const report = JSON.parse(bytes);
    if (
      !validSuiteReport(report, plan, op) ||
      report.opponents[op].id !== op ||
      (op === 'rule' && report.opponents.rule.version !== 'original') ||
      (op === 'clint' &&
        report.opponents.clint.version !==
          (plan.opponentPanel === MIXED_PANEL ? 'rules-v2-brain-v1' : 'rules-v2')) ||
      (op === 'champion' && !isDeepStrictEqual(report.opponents.champion.gate, plan.champion.gate))
    )
      throw Error('Incomplete or mismatched report: ' + op);
    if (op === 'reason' && report.protocolSHA256 !== reasonProtocolDigest(report))
      throw Error('Reason protocol fingerprint mismatch');
    if (
      op === 'clint' &&
      plan.opponentPanel === MIXED_PANEL &&
      report.protocolSHA256 !== clintProtocolDigest(report)
    )
      throw Error('Clint protocol fingerprint mismatch');
    const { wins, losses, draws, confidence95, clusters } = report.results[op];
    const matches = clusters.flat();
    if (
      matches.some(
        (m) => m.opponent !== report.opponents[op].mode || ![null, 0, 1].includes(m.winner),
      ) ||
      matches.filter((m) => m.winner === m.neuralTeam).length !== wins ||
      matches.filter((m) => m.winner === null).length !== draws
    )
      throw Error('Per-match outcomes disagree: ' + op);
    opponents[op] = {
      wins,
      losses,
      draws,
      confidence95,
      reportSHA256: sha256(bytes),
      ...(plan.opponentPanel === MIXED_PANEL
        ? {
            pairs: suitePairs(plan, op),
            matches: 2 * suitePairs(plan, op),
            seedEnd: plan.seedStart + suitePairs(plan, op) - 1,
          }
        : {}),
    };
  }
  return {
    protocol: plan.protocol,
    opponentPanel: legacy ? 'legacy-five' : plan.opponentPanel,
    modelSHA256: digest,
    seedStart: plan.seedStart,
    seedEnd: plan.seedEnd,
    championSHA256: plan.champion.modelSHA256,
    ...(plan.reason && { reason: plan.reason }),
    ...(plan.clint && { clint: plan.clint, opponentPairs: plan.opponentPairs }),
    opponents,
  };
}
