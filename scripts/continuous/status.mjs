/** Print a short human-readable summary of a continuous training run. */
import { existsSync } from 'node:fs';
import { option, readJSON, runPaths } from './lib.mjs';
import { actorTotals } from './remote.mjs';

const primary = existsSync('work/continuous/gpu-main/config.json')
  ? 'work/continuous/gpu-main'
  : 'work/continuous/main';
const paths = runPaths(option('run', primary));
const status = readJSON(paths.status);
const config = readJSON(paths.config);
if (!status) throw Error(`No status at ${paths.status}`);
const learner = status.learner || {};
const champion = status.champion || {};
const league = readJSON(paths.leagueMeta, { members: [], stats: {} });
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const sampled = actorTotals(paths.actors);
if (!sampled.slots.length) Object.assign(sampled, status.totals || {});
const lines = [
  `运行目录      ${paths.root}`,
  `网络训练设备  ${learner.deviceName || config.learner?.device || 'CPU'}`,
  `更新时间      ${status.updatedAt}${status.stoppedAt ? `（已停止 ${status.stoppedAt}）` : ''}`,
  `运行中进程    ${(status.running || []).join(', ') || '无'}`,
  `累计运行      ${status.elapsedSeconds == null ? '尚无累计计时' : (status.elapsedSeconds / 3600).toFixed(3) + ' 小时'}；停止原因 ${status.stopReason || '无'}`,
  `采样          ${sampled.matches} 场整场，${sampled.decisions} 个决策（采样槽 ${sampled.slots.join(',') || '-'}），本机约 ${status.decisionsPerSecond ?? '-'} 决策/秒`,
  `训练          第 ${learner.step ?? 0} 步，缓冲 ${learner.buffer ?? 0} 行，重放比 ${learner.replayRatio?.toFixed?.(2) ?? '-'}，损失 ${learner.lossEMA?.toFixed?.(4) ?? '-'}（${learner.state ?? '-'}）`,
  `最新模型      ${status.latest?.version ?? '-'}`,
  `冠军          ${champion.version ?? '-'}（更替 ${Math.max(0, (champion.history?.length || 1) - 1)} 次）`,
  `磁盘          ${status.diskGB ?? '-'} GB`,
  '',
  `最近 30 秒的对局（${config.exploration?.type || '探索'}，仅供监控，不是评测）：`,
];
for (const [mode, s] of Object.entries(status.recent?.byMode || {}))
  lines.push(
    `  ${mode.padEnd(7)} ${s.wins}/${s.matches} 胜 ${s.draws} 平（${pct(s.wins, s.matches)}）`,
  );
lines.push('', '联赛对手（最新模型对其近期胜率，指数遗忘）：');
for (const member of league.members) {
  const s = league.stats[member.id];
  lines.push(
    `  ${member.id.padEnd(12)} ${member.pinned ? '固定' : '    '} ${s ? `${s.wins.toFixed(1)}/${s.games.toFixed(1)}（${pct(s.wins, s.games)}）` : '暂无对局'}`,
  );
}
lines.push('', '门控记录（开发集，非留出验收）：');
for (const g of (status.gates || []).slice(-10))
  lines.push(
    `  #${g.index} ${g.challenger} 对 ${g.champion}: ${g.decision ?? '未完成'}，${g.pairs} 对，胜/负/平 ${g.wins}/${g.losses}/${g.draws}`,
  );
const gateFiles = (status.gates || []).length;
if (!gateFiles) lines.push('  暂无');
lines.push(
  '',
  `锚点检查（固定 150 对，开发监控；连续退步 ${status.anchorRegressionStreak || 0} 次）：`,
);
for (const check of (status.anchorChecks || []).slice(-5))
  lines.push(
    `  #${check.index} ${check.challenger}: ${check.status}，${check.pairs} 对，胜/负/平 ${check.wins}/${check.losses}/${check.draws}，得分 ${check.meanScore ?? '-'}，95% 区间 ${JSON.stringify(check.clusterHoeffding95CI)}`,
  );
console.log(lines.join('\n'));
