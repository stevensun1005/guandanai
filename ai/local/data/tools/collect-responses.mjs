import { openSync, writeSync, closeSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { simulateRound, seededRandom } from '../../../shared/simulation/simulation.mjs';
import { createPolicyInference } from '../../../shared/simulation/policy-inference.mjs';
const TEACHER_STYLES = ['balanced', 'aggressive', 'conservative', 'observant'];
import { encodeResponse, RESPONSE_FEATURES } from '../../../../web/src/ai/response-features.mjs';
const option = (name, fallback) =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ||
  fallback;
const games = Number(option('games', '5000')),
  seed = Number(option('seed', '20270104'));
const output = option('output', 'ai/local/data/generated/dataset');
mkdirSync(output, { recursive: true });
const fd = openSync(`${output}/responses.f32`, 'w');
const engine = createPolicyInference();
let chunks = [],
  rows = 0,
  positives = 0;
const flush = () => {
  if (chunks.length) writeSync(fd, Buffer.concat(chunks));
  chunks = [];
};
const started = performance.now();
try {
  for (let game = 0; game < games; game++) {
    const random = seededRandom(seed + game + 100000);
    const styles = Array.from(
      { length: 4 },
      () => TEACHER_STYLES[Math.floor(random() * TEACHER_STYLES.length)],
    );
    let pending = null;
    await simulateRound(seed + game, styles, engine.infer, {
      onAction: ({ context, play }) => {
        if (pending && context.p === pending.recipient) {
          const label = play ? 1 : 0;
          const row = new Float32Array(RESPONSE_FEATURES + 2);
          row.set(pending.features);
          row[RESPONSE_FEATURES] = label;
          row[RESPONSE_FEATURES + 1] = game;
          chunks.push(Buffer.from(row.buffer));
          rows++;
          positives += label;
          if (chunks.length >= 500) flush();
        }
        pending = null;
        if (!play) return;
        for (let step = 1; step < 4; step++) {
          const recipient = (context.p + step) % 4;
          if (!context.counts[recipient]) continue;
          if (recipient % 2 !== context.p % 2)
            pending = { recipient, features: encodeResponse(context, play, recipient) };
          break;
        }
      },
    });
    if ((game + 1) % 100 === 0)
      console.log(
        `${game + 1}/${games} games · ${rows} responses · ${Math.round((performance.now() - started) / 1000)}s`,
      );
  }
  flush();
  const hash = (name) => createHash('sha256').update(readFileSync(name)).digest('hex');
  const metadata = {
    featureVersion: 1,
    features: RESPONSE_FEATURES,
    rowFloats: RESPONSE_FEATURES + 2,
    rows,
    games,
    seed,
    positives,
    positiveRate: positives / rows,
    split: 'gameIndex % 10: test 0, validation 1, training 2..9',
    teacherPolicySHA256: hash('ai/local/models/baseline/policy.onnx'),
    profileSHA256: hash('web/src/ai/profiles.js'),
    featureSHA256: hash('web/src/ai/response-features.mjs'),
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  writeFileSync(`${output}/metadata.json`, JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
} finally {
  closeSync(fd);
  engine.close();
}
