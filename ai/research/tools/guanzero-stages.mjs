/** Read-only dynamic cards for the existing GuanZero window and immutable suite plans. */
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { suiteRows } from '../../guanzero/training/suite-reports.mjs';
const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const block = (rows) => [{ heading: '实际记录', rows, rule: '开发检查，不作验收', verdict: null }];
export function guanzeroCards(root, now) {
  const window = read(join(root, 'window.json')),
    status = read(join(root, 'learner/status.json'));
  const cards = [];
  if (window && status) {
    const start = Date.parse(window.startedAt),
      end = Date.parse(window.plannedEnd);
    const running = alive(status.pid),
      done = now >= end && !running && !existsSync(join(root, 'supervisor.lock'));
    cards.push({
      key: 'guanzero-learning',
      title: basename(root) + ' / 学习器',
      desc: '既有冻结训练窗口，读取真实学习器状态；时间进度不是棋力进度。',
      kind: 'guanzero',
      rule: '运行状态，描述性',
      dev: true,
      ruleLabel: '描述性',
      state: status.error ? 'failed' : done ? 'done' : running ? 'running' : 'queued',
      start,
      end: done ? end : null,
      processAlive: running,
      progress: {
        fraction: Math.max(0, Math.min(1, (now - start) / (end - start))),
        text: `已更新 ${status.step} 次；${status.usedSamples} 行；索引分片 ${status.indexedShards}；采样${status.pauseSampling ? '暂停' : '运行'}`,
        eta: end,
        etaText: null,
      },
      results: block([
        ['训练版本', String(status.step)],
        ['设备', status.deviceName || status.device],
        ['学习速度', `${status.updatesPerSecond ?? '—'} 次更新/秒`],
        ['ADP损失（诊断）', String(status.loss ?? '—')],
        ['最后状态', new Date(status.updatedAt * 1000).toISOString()],
      ]),
    });
  }
  const directory = join(root, 'eval'),
    manifest = read(join(directory, 'development-500/manifest.json'));
  const plans = new Map((manifest?.suites || []).map((p) => [p.id, p]));
  const worker = read(join(directory, 'development-500/status.json'));
  for (const row of suiteRows(directory, read, { runName: basename(root) })) {
    const plan = plans.get(row.suite),
      progress = read(
        join(
          directory,
          'development-500',
          row.suite,
          row.opponent,
          row.opponent + '-progress.json',
        ),
      );
    const start = Date.parse(plan.createdAt),
      completed = row.status === 'complete';
    cards.push({
      key: row.suite + '-' + row.opponent,
      title: row.modelName + ' / ' + row.opponentName,
      desc: `冻结同一模型；${row.plannedMatches}场完整比赛，交换阵营。种子 ${row.seedStart}–${row.seedEnd}。`,
      kind: 'guanzero',
      rule: '开发检查，不作验收',
      dev: true,
      ruleLabel: '开发检查，不作验收',
      state: completed ? 'done' : row.status === 'running' ? 'running' : 'queued',
      start: row.matches ? start : null,
      end: completed ? Date.parse(row.completedAt) : null,
      processAlive: completed ? null : alive(worker?.pid),
      progress: {
        fraction: row.matches / row.plannedMatches,
        text: `已完成 ${row.matches}/${row.plannedMatches} 场`,
        eta: null,
        etaText: null,
      },
      results: block([
        ['完成场数', `${row.matches}/${row.plannedMatches}`],
        ['胜／负／平', `${row.wins ?? 0}／${row.losses ?? 0}／${row.draws ?? 0}`],
        ['模型SHA', row.modelSHA256],
        ['对手版本', row.opponentVersion || '—'],
        ...(progress?.searchStats ? [['搜索与回落', JSON.stringify(progress.searchStats)]] : []),
      ]),
    });
  }
  return cards;
}
