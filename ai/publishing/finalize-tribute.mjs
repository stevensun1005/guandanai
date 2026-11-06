/** Deadline-triggered validation/publication of this specialist, in its dedicated worktree. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluate } from '../shared/tribute/evaluate.mjs';
import { readJSON, writeJSON, option } from '../danMCai/training/continuous/lib.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = resolve(option('run')),
  test = process.argv.includes('--preflight');
const manifestFile = join(root, 'web/src/ai/tribute-model.json');
function command(binary, args) {
  return execFileSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}
const git = (...args) => command('git', args).trim();
function check() {
  command(process.execPath, [
    join(root, 'node_modules/prettier/bin/prettier.cjs'),
    '--check',
    'web/**/*.{js,mjs,css,html,md}',
    'ai/**/*.{mjs,md}',
    '*.md',
    '.github/**/*.yml',
    'package.json',
    '.prettierrc.json',
  ]);
  // npm.cmd is a shell script on Windows; invoke npm's JS entry through Node instead.
  const npm =
    process.env.npm_execpath ||
    join(resolve(process.execPath, '..'), 'node_modules/npm/bin/npm-cli.js');
  for (const script of ['test', 'build']) command(process.execPath, [npm, 'run', script]);
  const python = option('validation-python', 'python');
  command(python, ['-m', 'unittest', 'discover', '-s', 'ai/shared/tests', '-p', '*test.py']);
  command(python, ['-m', 'unittest', 'discover', '-s', 'ai/research/tests', '-p', '*test.py']);
  command(python, ['-m', 'unittest', 'discover', '-s', 'ai/danMCai/tests', '-p', '*test.py']);
  command(python, ['-m', 'unittest', 'discover', '-s', 'ai/guanzero/tests', '-p', '*test.py']);
}
async function main() {
  const previous = readJSON(join(run, 'fusion.json'));
  if (!test && previous?.commit) {
    if (previous.stage === 'complete') return;
    await finishDeployment(previous);
    return;
  }
  const protocol = readJSON(join(run, 'protocol.json'));
  if (!protocol) throw Error('Missing fixed protocol');
  if (!test) {
    if (Date.now() < Date.parse(protocol.deadlineUTC)) throw Error('Cannot finalize before cutoff');
    if (readJSON(join(run, 'progress.json'))?.stopReason !== 'time-limit')
      throw Error('Training has not stopped at its fixed cutoff');
    if (git('status', '--porcelain'))
      throw Error('Publishing worktree has drafts; refusing to stage them');
    const before = git('rev-parse', 'HEAD');
    git('fetch', 'origin', 'main');
    git('merge', '--ff-only', 'origin/main');
    if (git('rev-parse', 'HEAD') !== before) {
      // Reload modules after synchronizing another machine's changes.
      command(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)]);
      return;
    }
  }
  const finalizerCommit = git('rev-parse', 'HEAD');
  if (!test)
    for (const file of [
      'ai/shared/tribute/encoding.mjs',
      'web/src/core/cards.js',
      'web/src/core/tribute.js',
      'web/src/core/match.js',
    ])
      if (
        sha(Buffer.from(readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n'))) !==
        protocol.sourceSHA256[file]
      )
        throw Error('Web tribute rules/encoding changed since frozen training: ' + file);
  let runtimeRoot = root;
  if (!test) {
    const entries = git('worktree', 'list', '--porcelain').split('\n\n');
    const candidates = entries.filter(
      (s) =>
        s.includes('HEAD ' + protocol.sourceCommit + '\n') ||
        s.endsWith('HEAD ' + protocol.sourceCommit),
    );
    runtimeRoot = candidates
      .map((entry) =>
        entry
          .split('\n')
          .find((s) => s.startsWith('worktree '))
          .slice(9),
      )
      .find((directory) => {
        try {
          return Object.entries(protocol.sourceSHA256).every(
            ([file, digest]) =>
              sha(
                Buffer.from(readFileSync(join(directory, file), 'utf8').replaceAll('\r\n', '\n')),
              ) === digest,
          );
        } catch {
          return false;
        }
      });
    if (!runtimeRoot) throw Error('Intact frozen training checkout missing');
  }
  const evaluation = await evaluate(
    run,
    test ? { test: true, seedBase: 3799000100, pairs: 4 } : { runtimeRoot },
  );
  const best = readJSON(join(run, 'learner/best.json')),
    bytes = readFileSync(join(run, 'learner/best.onnx'));
  if (sha(bytes) !== best.sha256) throw Error('Candidate changed after evaluation');
  const tag = 'tribute-' + best.sha256,
    file = tag + '.onnx';
  const candidate = {
    schema: 1,
    enabled: true,
    version: best.version,
    file,
    sha256: best.sha256,
    bytes: bytes.length,
    url: `https://github.com/stevensun1005/guandanai/releases/download/${tag}/${file}`,
    encoding: 'public-tribute-389-v1',
    approvedBaseSHA256: protocol.models.map((m) => [m.sha256]),
    evidence: 'ai/research/evaluation/tribute-20261106-final.json',
  };
  mkdirSync(join(root, 'ai/publishing/cache'), { recursive: true });
  copyFileSync(
    join(run, 'learner/best.onnx'),
    join(root, 'ai/publishing/cache', best.sha256 + '.onnx'),
  );
  command(process.execPath, [join(root, 'ai/shared/tribute/browser-fixtures.mjs'), `--run=${run}`]);
  const original = readFileSync(manifestFile);
  // Candidate is enabled only in this isolated local build during browser tests.
  try {
    writeJSON(manifestFile, candidate);
    const npm =
      process.env.npm_execpath ||
      join(resolve(process.execPath, '..'), 'node_modules/npm/bin/npm-cli.js');
    command(process.execPath, [npm, 'run', 'build']);
    command(option('validation-python', 'python'), [
      '-X',
      'utf8',
      join(root, 'web/tests/tribute_specialist_smoke.py'),
      `--run=${run}`,
    ]);
  } finally {
    writeFileSync(manifestFile, original);
  }
  const browser = readJSON(join(run, 'browser-validation.json'));
  if (browser.candidateSHA256 !== best.sha256 || browser.pageErrors.length)
    throw Error('Missing browser validation');
  if (test) {
    check();
    writeJSON(join(run, 'fusion-preflight.json'), {
      kind: 'test-not-published',
      evaluation: evaluation.summaries,
      browser,
    });
    return;
  }
  if (git('rev-parse', 'HEAD') !== finalizerCommit || git('status', '--porcelain'))
    throw Error('Publishing checkout changed during validation');
  const accepted = evaluation.accepted;
  if (accepted) {
    update('ai/shared/tribute/README.md', (s) =>
      s.replace('网页尚未启用；', '网页仅对通过独立验证的底座启用；'),
    );
    update('web/docs/WEB_MODELS.md', (s) =>
      s
        .replace('进还贡专项组件（开发中）', '进还贡专项组件（按底座独立验收）')
        .replace('当前默认关闭。', '仅对独立验收的底座启用。'),
    );
    update('web/README.md', (s) =>
      s.replace(
        '当前组件默认关闭，启用须有固定窗口独立结果和浏览器验证，不增加菜单项。',
        '当前只对通过固定窗口独立结果和浏览器验证的底座启用，不增加菜单项。',
      ),
    );
    let release;
    try {
      release = JSON.parse(command('gh', ['release', 'view', tag, '--json', 'tagName,assets']));
    } catch (e) {
      if (!/release not found|HTTP 404/i.test(String(e.stderr))) throw e;
    }
    if (release) {
      if (!release.assets.some((a) => a.name === file))
        throw Error('Immutable release exists without expected asset');
      const response = await fetch(candidate.url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== best.sha256)
        throw Error('Existing release differs; never overwrite');
    } else {
      const asset = join(root, 'ai/publishing/cache', file);
      copyFileSync(join(run, 'learner/best.onnx'), asset);
      const notes = join(root, 'ai/publishing/cache/tribute-release-notes.md');
      writeFileSync(
        notes,
        `Independent tribute/return specialist ${best.version}. Full SHA-256: ${best.sha256}. Two fixed teacher cohorts only; complete-round evaluation, not a full-match or global-strength claim.\n`,
      );
      command('gh', [
        'release',
        'create',
        tag,
        asset,
        '--target',
        finalizerCommit,
        '--title',
        best.version + ' tribute specialist',
        '--notes-file',
        notes,
        '--prerelease',
      ]);
    }
    writeJSON(manifestFile, candidate);
  }
  const evidence = {
    schema: 1,
    kind: 'independent-complete-round-and-browser',
    createdUTC: new Date().toISOString(),
    deployedSpecialist: accepted,
    mainNetworksUnchanged: true,
    finalizerCommit,
    frozenTrainingCommit: protocol.sourceCommit,
    protocol,
    protocolSHA256: sha(readFileSync(join(run, 'protocol.json'))),
    training: readJSON(join(run, 'progress.json')),
    candidate: best,
    evaluation,
    browser,
    release: accepted ? { tag, url: candidate.url, sha256: best.sha256 } : null,
    scope:
      'synthetic prior order/levels, completed single round; no full-match, human or Clint strength claim',
  };
  writeJSON(join(root, 'ai/research/evaluation/tribute-20261106-final.json'), evidence);
  const update = (file, transform) => {
    const p = join(root, file);
    writeFileSync(p, transform(readFileSync(p, 'utf8')));
  };
  const table = evaluation.summaries
    .map(
      (s, i) =>
        `| ${protocol.heads[i]} | ${s.rounds} | ${s.wins}/${s.losses}/${s.draws} | ${s.doubleUps}/${s.doubleDowns} | ${s.meanPairedPoints.toFixed(4)} | ${s.ci95.map((x) => x.toFixed(4)).join(' – ')} |`,
    )
    .join('\n');
  const status = accepted
    ? '独立门槛及浏览器验证通过，仅对这两个 SHA 底座启用专项。'
    : '未通过预先登记的双头独立门槛，网页保留原贡还行为，候选、数据及负结果保留。';
  update(
    'ai/research/MODEL_STUDY.md',
    (s) =>
      s +
      `\n\n### 35.1 固定窗口完成 · ${evidence.createdUTC}\n\n${status} 训练实际落盘 ${evidence.training.trainingGroups} 个训练组、${evidence.training.developmentGroups} 个开发组、${evidence.training.completedCounterfactualRounds} 次完整单局反事实标签；最佳专项 ${best.version}，SHA \`${best.sha256}\`。不把开发分或继承计数写成独立胜率。\n\n| 底座 | 完成单局 | 胜/负/平 | 双上/双下 | 配对平均积分 | 种子簇95%区间 |\n|---|---:|---|---|---:|---|\n${table}\n\n对照为同一冻结网络配历史 original 贡还，候选队伍两席使用专项，另一队两席不使用；每种子交换阵营。128 对/路线，种子 4,000,000,000–4,000,000,127，留出不用于选择检查点。单局指标不等于整场通过 A。Chrome WASM ${browser.states} 个公开局面/${browser.headDecisions} 次双头决策，最大绝对误差 ${browser.maxAbsoluteError}；贡还守恒、早还贡与 Clint 隔离通过。新冠军或新 GuanZero SHA 未测试时自动保留原贡还，不扩大结论。详细协议、模型及源码指纹和完整名次见[原始证据](evaluation/tribute-20261106-final.json)。\n`,
  );
  update(
    'ai/research/CODEX_HANDOFF.md',
    (s) =>
      s +
      `\n\n进还贡固定窗口已完成：${status} 见 [最终证据](evaluation/tribute-20261106-final.json)。不要续约训练或把此单局结论当作整场验收。\n`,
  );
  update('CHANGELOG.md', (s) =>
    s.replace(
      '# 更新记录',
      `# 更新记录\n\n## 2026-11-06 · 进还贡固定窗口结果\n\n${status} [完整结果](ai/research/evaluation/tribute-20261106-final.json)。主网络与冠军清单不变。`,
    ),
  );
  for (const file of ['ai/shared/tribute/README.md', 'web/docs/WEB_MODELS.md'])
    update(
      file,
      (s) =>
        s +
        `\n\n2026-11-06 窗口结论：${status} [完整结果](${file.startsWith('web/') ? '../../ai/research/evaluation/tribute-20261106-final.json' : '../../research/evaluation/tribute-20261106-final.json'})。${accepted ? '只对清单 `approvedBaseSHA256` 中底座启用，后续新底座默认不继承此验收。' : ''}\n`,
    );
  if (accepted) {
    update('README.md', (s) =>
      s.replace(
        '该模块尚未启用到网页，当前模型菜单和默认冠军不变。',
        '专项已对通过独立测试的底座启用；模型菜单和默认冠军不变。',
      ),
    );
    update('README.en.md', (s) =>
      s.replace(
        'It is not enabled on the website yet; the champion menu is unchanged.',
        'It is enabled only for independently tested base-model SHAs; the champion menu is unchanged.',
      ),
    );
  }
  const index = readJSON(join(root, 'ai/research/evaluation/model-artifacts.json'));
  index.specialistExperiments = (index.specialistExperiments || []).filter(
    (x) => x.id !== 'tribute-20261106',
  );
  index.specialistExperiments.push({
    id: 'tribute-20261106',
    status: accepted ? 'enabled-tested-cohorts' : 'rejected-preserved',
    sha256: best.sha256,
    evidence: 'tribute-20261106-final.json',
    release: evidence.release,
  });
  writeJSON(join(root, 'ai/research/evaluation/model-artifacts.json'), index);
  const files = [
    'ai/research/evaluation/tribute-20261106-final.json',
    'ai/research/evaluation/model-artifacts.json',
    'ai/research/MODEL_STUDY.md',
    'ai/research/CODEX_HANDOFF.md',
    'CHANGELOG.md',
    'ai/shared/tribute/README.md',
    'web/docs/WEB_MODELS.md',
    ...(accepted
      ? ['web/src/ai/tribute-model.json', 'README.md', 'README.en.md', 'web/README.md']
      : []),
  ];
  command(process.execPath, [
    join(root, 'node_modules/prettier/bin/prettier.cjs'),
    '--write',
    ...files.filter((f) => f.endsWith('.md')),
  ]);
  check();
  git('add', '--', ...files);
  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (staged.some((f) => !files.includes(f))) throw Error('Unrelated staged file');
  for (const file of staged)
    if (readFileSync(join(root, file)).length > 1024 * 1024) throw Error('Large file refused');
  git(
    'commit',
    '-m',
    'Record tribute specialist independent result' + (accepted ? ' and enable tested cohorts' : ''),
  );
  try {
    git('push', 'origin', 'HEAD:main');
  } catch {
    git('fetch', 'origin', 'main');
    git('rebase', 'origin/main');
    check();
    git('push', 'origin', 'HEAD:main');
  }
  const commit = git('rev-parse', 'HEAD');
  await finishDeployment({ accepted, commit, sha256: best.sha256, file });
}

async function finishDeployment(record) {
  const { accepted, commit, sha256, file } = record;
  if (!accepted) {
    writeJSON(join(run, 'fusion.json'), {
      ...record,
      stage: 'complete',
      pages: { status: 'unchanged', reason: 'Evidence-only commit; website retained' },
      updatedUTC: new Date().toISOString(),
    });
    return;
  }
  let pages;
  for (let i = 0; i < 90; i++) {
    const runs = JSON.parse(
      command('gh', [
        'run',
        'list',
        '--workflow',
        'pages.yml',
        '--limit',
        '15',
        '--json',
        'headSha,status,conclusion,url',
      ]),
    );
    pages = runs.find((r) => r.headSha === commit);
    if (pages?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 10000));
  }
  const fusion = {
    file,
    stage: pages?.conclusion === 'success' ? 'pages-weight-unverified' : 'pages-pending-or-failed',
    accepted,
    commit,
    pages,
    sha256,
    updatedUTC: new Date().toISOString(),
  };
  writeJSON(join(run, 'fusion.json'), fusion);
  if (pages?.conclusion !== 'success')
    throw Error('Pages deployment not confirmed; see fusion.json');
  let verified = false;
  for (let i = 0; i < 6 && !verified; i++) {
    const response = await fetch(
      'https://stevensun1005.github.io/guandanai/models/' + file + '?verify=' + Date.now(),
      { signal: AbortSignal.timeout(30000) },
    );
    verified = response.ok && sha(Buffer.from(await response.arrayBuffer())) === sha256;
    if (!verified) await new Promise((r) => setTimeout(r, 5000));
  }
  if (!verified) {
    fusion.stage = 'pages-weight-unverified';
    writeJSON(join(run, 'fusion.json'), fusion);
    throw Error('Public Pages weight SHA not confirmed');
  }
  fusion.stage = 'complete';
  fusion.publicWeightVerified = true;
  writeJSON(join(run, 'fusion.json'), fusion);
}
if (
  process.argv[1] &&
  pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
)
  main().catch((e) => {
    writeJSON(join(run, test ? 'fusion-preflight-error.json' : 'fusion-error.json'), {
      error: e.stack,
      updatedUTC: new Date().toISOString(),
    });
    if (!test) {
      const progress = readJSON(join(run, 'progress.json'), {});
      writeJSON(join(run, 'progress.json'), {
        ...progress,
        stage: 'fusion-failed',
        error: e.message,
        updatedUTC: new Date().toISOString(),
      });
    }
    console.error(e);
    process.exitCode = 1;
  });
