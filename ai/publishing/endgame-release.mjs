/** Owner-authorized conditional release. A separate, bounded companion; never edits a training run. */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  copyFileSync,
  appendFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { clusterInterval } from '../research/tools/window-dashboard.mjs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, x) => writeFileSync(p, JSON.stringify(x, null, 2) + '\n');
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
export function improvementGate(groups, n = 3000) {
  const maps = Object.fromEntries(
    ['A', 'B', 'C'].map((k) => [k, new Map(groups[k].map((r) => [r.seed, r.mean]))]),
  );
  if (
    ['A', 'B', 'C'].some((k) => groups[k].length !== n || maps[k].size !== n) ||
    [...maps.A.keys()].some((s) => !maps.B.has(s) || !maps.C.has(s))
  )
    throw Error('Incomplete, duplicate or unpaired heldout groups');
  const A = clusterInterval([...maps.A.values()]);
  const AB = clusterInterval([...maps.A].map(([s, v]) => v - maps.B.get(s)));
  const AC = clusterInterval([...maps.A].map(([s, v]) => v - maps.C.get(s)));
  if (![...maps.A.values(), ...maps.B.values(), ...maps.C.values()].every(Number.isFinite))
    throw Error('Nonfinite outcomes');
  return {
    accepted: [A, AB, AC].every((x) => x.ci95[0] > 0),
    A,
    finalMinusRebasedInitial: AB,
    finalMinusOriginalR2: AC,
    rule: 'All three groups3000 complete paired deals; A vs029 and paired A-B/A-C 95% lower bounds strictly>0. No rounding, outcome-based resizing or model selection.',
  };
}

export function auditRelease(run, plan) {
  if (existsSync(join(run, 'STOP')) || existsSync(join(run, 'failure.json')))
    throw Error('Stopped or failed research window cannot publish');
  if (read(join(run, 'FINISHED')).phase !== 'complete' || !read(join(run, 'results.json')).complete)
    throw Error('Window not complete');
  const protocol = read(join(run, 'protocol.json')),
    reg = read(join(run, 'registration.json'));
  if (
    hash(join(run, 'protocol.json')) !== reg.protocolSHA256 ||
    reg.trainingDeadlineUTC !== plan.trainingDeadlineUTC ||
    reg.evaluationDeadlineUTC !== plan.evaluationDeadlineUTC ||
    protocol.teacher.sha256 !== plan.baseSHA256 ||
    hash(join(run, 'seed-audit.json')) !== plan.seedAuditSHA256
  )
    throw Error('Frozen protocol/teacher/seeds changed');
  const latest = read(join(run, 'final-model.json')),
    audit = read(join(run, 'stop-audit.json'));
  if (
    !/^[\w-]+\.onnx$/.test(latest.file) ||
    !audit.networkExactlyMatchesCheckpoint ||
    !audit.adamMatchesNewUpdates ||
    audit.adamStates !== 13 ||
    latest.sha256 !== audit.latest.sha256 ||
    hash(join(run, 'train/models', latest.file)) !== latest.sha256 ||
    hash(join(run, 'train/learner/checkpoint.pt')) !== audit.checkpointSHA256 ||
    read(join(run, 'process-exit-audit.json')).relatedStillAlive.length
  )
    throw Error('Final window checkpoint/Adam/process audit failed');
  for (const [file, digest] of Object.entries(protocol.sourceSHA256))
    if (hash(join(protocol.sourceRoot, file)) !== digest)
      throw Error('Frozen evaluation source changed: ' + file);
  const seeds = read(join(run, 'seed-audit.json')).seeds;
  if (seeds.length !== 3000 || new Set(seeds).size !== 3000) throw Error('Reserved seeds invalid');
  const groups = {},
    evidence = {};
  for (const [k, sha] of [
    ['A', latest.sha256],
    ['B', plan.initialSHA256],
    ['C', plan.r2SHA256],
  ]) {
    const d = join(run, 'eval-' + k),
      r = read(join(d, 'run.json'));
    if (
      r.studentSHA256 !== sha ||
      r.championSHA256 !== plan.baseSHA256 ||
      r.seedsSHA256 !== plan.seedAuditSHA256 ||
      Number(r.pairs) !== 3000 ||
      Number(r.threshold) !== 32 ||
      (r.policy && r.policy !== 'student')
    )
      throw Error('Evaluation policy fingerprint mismatch ' + k);
    groups[k] = [];
    evidence[k] = { runSHA256: hash(join(d, 'run.json')), parts: {} };
    for (let i = 0; i < r.workers; i++) {
      const p = join(d, `part-${i}.json`);
      evidence[k].parts[`part-${i}.json`] = hash(p);
      for (const row of read(p)) {
        if (
          !seeds.includes(row.seed) ||
          !row.a ||
          !row.b ||
          [row.a, row.b].some(
            (x) =>
              ![-3, -2, -1, 1, 2, 3].includes(x.points) ||
              !Array.isArray(x.order) ||
              x.order.length !== 4 ||
              [...x.order].sort().join(',') !== '0,1,2,3',
          ) ||
          row.mean !== (row.a.points + row.b.points) / 2
        )
          throw Error('Invalid complete paired round');
        groups[k].push(row);
      }
    }
  }
  return {
    ...improvementGate(groups),
    model: latest,
    checkpointSHA256: audit.checkpointSHA256,
    evidence,
    protocolSHA256: reg.protocolSHA256,
    sourceCommit: protocol.sourceCommit,
    seedAuditSHA256: plan.seedAuditSHA256,
    completedAtUTC: new Date().toISOString(),
    scope:
      'Only final-window hybrid029/32-card student vs029 single rounds without tribute. Not old belief-search, human or match-level acceptance.',
  };
}

async function deliver(run, companion, plan) {
  const repo = plan.repository,
    checkout = plan.deliveryRoot;
  const git = (args, cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git(['fetch', 'origin', 'main']);
  if (existsSync(checkout)) throw Error('Delivery checkout already exists; inspect before retry');
  git(['worktree', 'add', '--detach', checkout, 'origin/main']);
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `New-Item -ItemType Junction -Path '${checkout}/node_modules' -Target '${repo}/node_modules' | Out-Null`,
    ],
    { windowsHide: true },
  );
  const script = join(checkout, 'ai/publishing/endgame-release.mjs');
  if (hash(script) !== plan.releaseToolSHA256)
    throw Error('Publisher changed on main; review before delivery');
  for (const [file, digest] of Object.entries(plan.publicationSourceSHA256))
    if (hash(join(checkout, file)) !== digest)
      throw Error('Publication policy changed; review before delivery: ' + file);
  await new Promise((ok, fail) => {
    const fd = openSync(join(companion, 'delivery.log'), 'a');
    const child = spawn(
      process.execPath,
      [script, `--run=${run}`, `--companion=${companion}`, '--deliver'],
      { cwd: checkout, windowsHide: true, stdio: ['ignore', fd, fd] },
    );
    write(join(companion, 'delivery-process.json'), {
      pid: child.pid,
      startedAtUTC: new Date().toISOString(),
    });
    child.on('error', fail);
    child.on('exit', (code) => {
      closeSync(fd);
      code === 0 ? ok() : fail(Error('Delivery exited ' + code));
    });
  });
}

async function publish(run, companion, plan) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const gate = auditRelease(run, plan);
  if (!gate.accepted) throw Error('Gate did not pass');
  const command = (exe, args) => {
    if (
      existsSync(join(companion, 'STOP')) ||
      existsSync(join(run, 'STOP')) ||
      Date.now() >= Date.parse(plan.publicationDeadlineUTC)
    )
      throw Error('Release STOP/deadline');
    return execFileSync(exe, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 << 20,
      env: { ...process.env, PORT: '8789' },
      timeout: Math.min(
        25 * 60 * 1000,
        Math.max(1, Date.parse(plan.publicationDeadlineUTC) - Date.now()),
      ),
    });
  };
  const git = (args) => command('git', args).trim();
  const node = (args) => command(process.execPath, args);
  const registry = join(root, 'web/src/ai/model-catalog.json'),
    original = readFileSync(registry, 'utf8');
  const catalog = JSON.parse(original);
  if (
    git(['status', '--porcelain']) ||
    catalog.defaultId !== '029' ||
    catalog.selection.defaultChoice !== '029' ||
    catalog.searchBots.some((b) => b.base === '029') ||
    catalog.models.find((m) => m.id === '029')?.sha256 !== plan.baseSHA256
  )
    throw Error('Delivery checkout/base not clean/current029');
  const baseCommit = git(['rev-parse', 'HEAD']);
  const pubArgs = [
    'ai/publishing/publish-web-model.mjs',
    `--model=${join(run, 'train/models', gate.model.file)}`,
    '--source=endgame-rebase-029-20261112',
    `--version=${gate.model.version}`,
    `--step=${gate.model.step}`,
  ];
  const prepared = JSON.parse(node(pubArgs)).prepared;
  if (!prepared) throw Error('Student already archived; reconcile existing identity before retry');
  catalog.models.push(prepared);
  const id = String(Math.max(9001, ...(catalog.searchBots || []).map((b) => Number(b.id))) + 1);
  const bot = {
    id,
    kind: 'endgame-student',
    base: '029',
    student: { id: prepared.id, sha256: prepared.sha256 },
    threshold: 32,
    version: `v000061013-tail-${gate.model.version}`,
    source: {
      status: 'independent-hybrid-gate-accepted',
      evidence: 'ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/gate.json',
      scope: gate.scope,
    },
  };
  const { searchBotManifest, validateCatalog } = await import(
    pathToFileURL(join(root, 'web/src/ai/model-catalog.mjs'))
  );
  bot.sha256 = createHash('sha256')
    .update(
      JSON.stringify(
        searchBotManifest(
          bot,
          catalog.models.find((m) => m.id === '029'),
        ),
      ),
    )
    .digest('hex');
  catalog.searchBots.push(bot);
  catalog.selection.defaultChoice = id;
  validateCatalog(catalog);
  const target = join(
    root,
    'ai/research/evaluation/endgame-rebase-029-20261112/conditional-release',
  );
  mkdirSync(target, { recursive: true });
  write(join(target, 'gate.json'), gate);
  copyFileSync(join(companion, 'authorization.json'), join(target, 'authorization.json'));
  write(registry, catalog);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // npm.cmd needs a command shell on Windows; every argument here is a fixed script name.
  const npmRun = (args) =>
    process.platform === 'win32'
      ? command('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`])
      : command(npm, args);
  const log = (name, text) => writeFileSync(join(companion, name), text);
  log('tests.log', npmRun(['test', '--', '--test-concurrency=4']));
  log('format.log', npmRun(['run', 'format:check']));
  log(
    'learner-tests.log',
    command(plan.gpuPython, ['-B', '-X', 'utf8', 'ai/danMCai/tests/endgame_learner_test.py']),
  );
  log(
    'research-tests.log',
    command(plan.gpuPython, [
      '-B',
      '-X',
      'utf8',
      '-m',
      'unittest',
      'discover',
      '-s',
      'ai/research/tests',
      '-p',
      '*test.py',
    ]),
  );
  log('build.log', npmRun(['run', 'build']));
  node([
    'ai/publishing/student-browser-reference.mjs',
    `--out=${join(companion, 'browser-reference.json')}`,
  ]);
  const server = spawn(process.execPath, ['web/tools/serve.mjs'], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, PORT: '8789' },
    stdio: 'ignore',
  });
  try {
    await nap(1500);
    log(
      'wasm.log',
      command(plan.browserPython, [
        '-B',
        '-X',
        'utf8',
        'web/tests/student_release_smoke.py',
        'http://127.0.0.1:8789/',
        join(companion, 'browser-reference.json'),
      ]),
    );
    log(
      'production.log',
      command(plan.browserPython, [
        '-B',
        '-X',
        'utf8',
        'web/tests/production_smoke.py',
        'http://127.0.0.1:8789/',
      ]),
    );
    log(
      'coach.log',
      command(plan.browserPython, [
        '-B',
        '-X',
        'utf8',
        'web/tests/coach_smoke.py',
        'http://127.0.0.1:8789/',
        '--solo-only',
      ]),
    );
    log(
      'security.log',
      command(plan.browserPython, [
        '-B',
        '-X',
        'utf8',
        'web/tests/replay_security_smoke.py',
        'http://127.0.0.1:8789/',
      ]),
    );
  } finally {
    server.kill();
  }
  command('git', ['fetch', 'origin', 'main']);
  if (git(['rev-parse', 'origin/main']) !== baseCommit)
    throw Error(
      'Concurrent main update: preserve prepared checkout, resync and revalidate before publish',
    );
  // The established publisher owns immutable ONNX upload/verification. Restore its original catalog first.
  writeFileSync(registry, original);
  log('archive-release.log', node([...pubArgs, '--publish']));
  const uploaded = read(registry);
  if (uploaded.models.find((m) => m.sha256 === prepared.sha256)?.id !== prepared.id)
    throw Error('Concurrent archive ID changed');
  uploaded.searchBots.push(bot);
  uploaded.selection.defaultChoice = id;
  write(registry, uploaded);
  validateCatalog(uploaded);
  const release = {
    id,
    bot,
    gate,
    baseChampionUnchanged: true,
    checkedAtUTC: new Date().toISOString(),
    browserValidated: true,
    trainingSourceCommit: gate.sourceCommit,
    publicationCommitPending: true,
  };
  write(join(target, 'release.json'), release);
  for (const [p, text] of [
    [
      'README.md',
      `\n029底座尾盘reason已通过三组独立配对门槛并发布。它在32张以内使用训练网络，不是旧9001多世界搜索，原始网络值不视作校准概率。[发布证据](ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/release.json)。\n`,
    ],
    [
      'README.en.md',
      `\nThe029-based trained endgame reason passed all preregistered paired gates. It uses its student at32 cards or fewer, not the old9001 belief search; values are uncalibrated. [Release evidence](ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/release.json).\n`,
    ],
    [
      'web/docs/WEB_MODELS.md',
      `\nConditional release ${id}:029 above32cards, trained student ${prepared.id}/${gate.model.version} at32or fewer. Both policies greedy/finish-first, own/public observations only; no belief search mixed into this evidence. Default reason ${id}; raw champion029 and old9001 remain archived unchanged. See [evidence](../../ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/release.json).\n`,
    ],
    [
      'CHANGELOG.md',
      `\n## 029 trained endgame reason ${id}\n\nCompleted A/B/C3000pairs each; all three95%lower bounds positive, Node/Chrome WASM and UI checks passed. Default reason ${id}, raw champion029 unchanged.\n`,
    ],
    [
      'ai/research/MODEL_STUDY.md',
      `\n### Conditional endgame reason release ${id}\n\nFinal-window ${gate.model.version}, SHA ${prepared.sha256}. A vs029 ${JSON.stringify(gate.A)}, paired A−B ${JSON.stringify(gate.finalMinusRebasedInitial)}, A−C ${JSON.stringify(gate.finalMinusOriginalR2)}. Single rounds/no tribute; no human, mixed-team or full-match claim. [Gate and release](evaluation/endgame-rebase-029-20261112/conditional-release/release.json).\n`,
    ],
    [
      'ai/research/CODEX_HANDOFF.md',
      `\n029-trained tail reason ${id} conditionally published after complete independent gates. Source, exactSHA and limits: [release](evaluation/endgame-rebase-029-20261112/conditional-release/release.json). Original029/017/9001 and all raw research evidence retained.\n`,
    ],
  ])
    writeFileSync(join(root, p), readFileSync(join(root, p), 'utf8') + text);
  const indexPath = join(root, 'ai/research/evaluation/model-artifacts.json'),
    index = read(indexPath);
  index.endgameTransferWindows.find(
    (x) => x.id === 'endgame-rebase-029-20261112',
  ).conditionalRelease =
    'ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/release.json';
  write(indexPath, index);
  const docs = [
    'README.md',
    'README.en.md',
    'web/docs/WEB_MODELS.md',
    'CHANGELOG.md',
    'ai/research/MODEL_STUDY.md',
    'ai/research/CODEX_HANDOFF.md',
  ];
  node(['node_modules/prettier/bin/prettier.cjs', '--write', ...docs]);
  npmRun(['run', 'format:check']);
  npmRun(['run', 'build']);
  node(['web/tools/package.mjs']);
  const bundle = join(root, 'web/artifacts/packages/guandan-web.zip');
  const packagePath = join(
    plan.downloads,
    `danMCai-reason-v000061013-${gate.model.version}-${prepared.sha256.slice(0, 8)}-web.zip`,
  );
  if (existsSync(packagePath)) {
    if (hash(packagePath) !== hash(bundle)) throw Error('Existing Downloads package differs');
  } else copyFileSync(bundle, packagePath, 1);
  const tag = `web-reason-${id}`,
    gh = (args) => command('gh', args);
  gh([
    'release',
    'create',
    tag,
    bundle,
    join(target, 'release.json'),
    '--target',
    baseCommit,
    '--title',
    `danMCai reason ${id}`,
    '--notes',
    'Owner-authorized trained32-card endgame hybrid; independent paired gate in attached release.json. Raw champion029 unchanged.',
    '--prerelease',
    '--latest=false',
  ]);
  const packageResponse = await fetch(
    `https://github.com/stevensun1005/guandanai/releases/download/${tag}/guandan-web.zip`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (
    !packageResponse.ok ||
    createHash('sha256')
      .update(Buffer.from(await packageResponse.arrayBuffer()))
      .digest('hex') !== hash(packagePath)
  )
    throw Error('Public web package SHA mismatch');
  const files = [
    ...docs,
    'web/src/ai/model-catalog.json',
    'ai/research/evaluation/model-artifacts.json',
    `ai/research/evaluation/web-model-${prepared.id}.json`,
    ...['gate.json', 'release.json', 'authorization.json'].map(
      (f) => 'ai/research/evaluation/endgame-rebase-029-20261112/conditional-release/' + f,
    ),
  ];
  git(['add', '--', ...files]);
  git(['diff', '--cached', '--check']);
  git(['commit', '-m', `Publish independently improved029 endgame reason ${id}`]);
  git(['push', 'origin', 'HEAD:main']);
  const commit = git(['rev-parse', 'HEAD']);
  let workflow;
  while (Date.now() < Date.parse(plan.publicationDeadlineUTC)) {
    const list = JSON.parse(
      gh([
        'run',
        'list',
        '--workflow=pages.yml',
        '--commit=' + commit,
        '--json',
        'databaseId,status,conclusion,url',
      ]),
    );
    workflow = list[0];
    if (workflow?.status === 'completed') break;
    await nap(20000);
  }
  if (workflow?.conclusion !== 'success')
    throw Error('Pages deployment not verified: ' + JSON.stringify(workflow));
  let live;
  for (let attempt = 0; attempt < 12; attempt++) {
    live = await fetch(
      'https://stevensun1005.github.io/guandanai/models/catalog.json?release=' +
        commit +
        '&try=' +
        attempt,
      { cache: 'no-store', signal: AbortSignal.timeout(30000) },
    ).then((r) => r.json());
    if (live.defaultId === id && live.searchBots.find((b) => b.id === id)?.sha256 === bot.sha256)
      break;
    await nap(10000);
  }
  if (
    live.defaultId !== id ||
    live.neuralDefaultId !== '029' ||
    live.searchBots.find((b) => b.id === id)?.sha256 !== bot.sha256
  )
    throw Error('Production catalog mismatch');
  write(join(companion, 'published.json'), {
    commit,
    workflow,
    reasonId: id,
    studentSHA256: prepared.sha256,
    packagePath,
    packageSHA256: hash(packagePath),
    verifiedAtUTC: new Date().toISOString(),
  });
}

async function main() {
  const arg = (n) => process.argv.find((a) => a.startsWith('--' + n + '='))?.slice(n.length + 3);
  const run = resolve(arg('run')),
    companion = resolve(arg('companion')),
    plan = read(join(companion, 'authorization.json'));
  if (process.argv.includes('--deliver')) return publish(run, companion, plan);
  if (hash(fileURLToPath(import.meta.url)) !== plan.releaseToolSHA256)
    throw Error('Frozen release companion changed');
  const lock = join(companion, 'companion.lock');
  closeSync(openSync(lock, 'wx'));
  const stage = (phase, extra = {}) => {
    write(join(companion, 'status.json'), {
      pid: process.pid,
      phase,
      updatedAtUTC: new Date().toISOString(),
      ...extra,
    });
    write(join(companion, 'dashboard-record.json'), {
      title: '条件发布实际状态',
      rows: [
        ['状态', phase],
        ['当前网页', '029；门槛/发布验证完成前不变'],
        ['停止训练', '11月13日03:58:54美东，原截止不变'],
        ['验收条件', '完整三组3000副，A/A-B/A-C的95%下界均>0'],
        ...(extra.error ? [['失败原因', extra.error]] : []),
      ],
    });
  };
  let started = false;
  try {
    while (!existsSync(join(run, 'FINISHED'))) {
      if (
        existsSync(join(companion, 'STOP')) ||
        Date.now() >= Date.parse(plan.publicationDeadlineUTC)
      )
        throw Error('Conditional release STOP/deadline');
      stage('waiting-for-training-and-independent-evaluation');
      await nap(15000);
    }
    stage('checking-complete-independent-results');
    appendFileSync(
      join(run, 'stages.log'),
      new Date().toISOString() + ' START conditional-release\n',
    );
    started = true;
    const gate = auditRelease(run, plan);
    write(join(companion, 'gate.json'), gate);
    if (!gate.accepted) {
      stage('not-published-no-confirmed-improvement', { gate });
      return;
    }
    stage('validating-and-publishing');
    const reg = {
      startUTC: new Date().toISOString(),
      deadlineUTC: plan.publicationDeadlineUTC,
      durationHours: (Date.parse(plan.publicationDeadlineUTC) - Date.now()) / 3600000,
      restartExtendsDeadline: false,
    };
    write(join(companion, 'registration.json'), reg);
    const awake = spawn(
      plan.powershell,
      [
        '-NoProfile',
        '-File',
        join(dirname(fileURLToPath(import.meta.url)), '../research/tools/evaluation-awake.ps1'),
        '-Run',
        companion,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    write(join(companion, 'awake-launch.json'), { pid: awake.pid, deadlineUTC: reg.deadlineUTC });
    await deliver(run, companion, plan);
    stage('published', read(join(companion, 'published.json')));
  } catch (error) {
    stage('failed', { error: String(error.stack || error) });
    write(join(companion, 'failure.json'), { error: String(error.stack || error) });
    throw error;
  } finally {
    write(join(companion, 'FINISHED'), { atUTC: new Date().toISOString() });
    if (started)
      appendFileSync(
        join(run, 'stages.log'),
        new Date().toISOString() +
          ' END conditional-release rc=' +
          (existsSync(join(companion, 'failure.json')) ? 1 : 0) +
          '\n',
      );
    unlinkSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
