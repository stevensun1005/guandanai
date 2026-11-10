import { localSourceHashes } from './remote.mjs';

export const sourceFiles = [
  ...[
    'supervisor.mjs',
    'gate-schedule.mjs',
    'actor.mjs',
    'gate.mjs',
    'lib.mjs',
    'learner.py',
    'value_net.py',
    'fast-actor.mjs',
    'batch-inference.mjs',
    'inference-worker.mjs',
    'fast-candidates.mjs',
    'fast-rollout.mjs',
    'onnx-rows.mjs',
    'resources.mjs',
    'remote.mjs',
    'windows-window.mjs',
  ].map((f) => `ai/danMCai/training/continuous/${f}`),
  ...['match-rollout.mjs', 'match-simulation.mjs', 'simulation.mjs', 'rule-baseline.mjs'].map(
    (f) => `ai/shared/simulation/${f}`,
  ),
  ...['cards.js', 'combinations.js', 'moves.js', 'match.js', 'tribute.js'].map(
    (f) => `web/src/core/${f}`,
  ),
  ...[
    'candidates.js',
    'encoding.mjs',
    'observation.js',
    'rule-policy.js',
    'hand-value.js',
    'habits.js',
  ].map((f) => `web/src/ai/${f}`),
  'web/src/hand/arrangement.js',
  'web/src/hand/hints.js',
  'web/src/ai/policy-features.mjs',
  // extrasMode 'public-belief': the fast actor computes belief marginals with these.
  'ai/danMCai/belief/sampler.mjs',
  'ai/danMCai/belief/features.mjs',
  'web/src/analysis/concepts.mjs',
  'package-lock.json',
  'ai/danMCai/training/continuous/sources.mjs',
  'ai/danMCai/training/continuous/mac-24h.mjs',
];

export const sourceHashes = () => localSourceHashes(sourceFiles);
