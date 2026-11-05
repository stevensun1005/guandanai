const $ = (id) => document.getElementById(id),
  number = (v) => (Number.isFinite(v) ? v.toLocaleString('zh-CN') : '—'),
  fixed = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—'),
  pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');
function text(id, value) {
  $(id).textContent = value;
}
function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
const NS = 'http://www.w3.org/2000/svg';
function svgElement(name, attributes) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
  return e;
}
function chart(id, records, key, color) {
  const svg = $(id);
  svg.replaceChildren();
  const values = records.filter((r) => Number.isFinite(r[key]));
  if (values.length < 2) {
    const t = svgElement('text', { x: 320, y: 90, 'text-anchor': 'middle' });
    t.textContent = '正在收集趋势数据';
    svg.append(t);
    return;
  }
  let min = Math.min(...values.map((v) => v[key])),
    max = Math.max(...values.map((v) => v[key]));
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  for (let i = 0; i < 4; i++) {
    const y = 14 + i * 48;
    svg.append(svgElement('line', { x1: 52, x2: 630, y1: y, y2: y, class: 'grid' }));
    const t = svgElement('text', { x: 43, y: y + 4, 'text-anchor': 'end' });
    t.textContent = fixed(max - ((max - min) * i) / 3, key === 'loss' ? 2 : 0);
    svg.append(t);
  }
  const first = values[0].time,
    last = values.at(-1).time;
  const points = values.map((v) => [
    52 + ((v.time - first) / Math.max(1, last - first)) * 578,
    14 + ((max - v[key]) / (max - min)) * 144,
  ]);
  svg.append(
    svgElement('path', {
      d: 'M' + points.map((p) => p.join(',')).join(' L'),
      fill: 'none',
      stroke: color,
      'stroke-width': 2.5,
      'stroke-linejoin': 'round',
    }),
  );
}
function row(values) {
  const tr = document.createElement('tr');
  for (const value of values) {
    const td = document.createElement('td');
    td.textContent = value;
    tr.append(td);
  }
  return tr;
}
function render(s) {
  const phases = {
    running: '训练运行中',
    stopped: '已停止',
    unconfirmed: '状态待确认',
    error: '训练异常',
  };
  text('phase', phases[s.phase]);
  $('phase').className =
    'badge ' +
    (['stopped', 'unconfirmed'].includes(s.phase) ? 'stopped' : s.phase === 'error' ? 'error' : '');
  text('run-name', s.name);
  text(
    'device',
    `${s.learner.deviceName || s.config.device} · ${s.learner.precision || 'FP32'} · ${s.config.actors} 个 CPU 采样进程 · ${s.config.objective.toUpperCase()}`,
  );
  text('elapsed', duration(s.elapsedSeconds));
  text(
    'plan',
    s.plannedHours
      ? `计划 ${s.plannedHours} 小时 · ${Math.min(100, (100 * s.elapsedSeconds) / (s.plannedHours * 3600)).toFixed(1)}%`
      : '',
  );
  text('matches', number(s.totals.matches));
  text('rows', number(s.totals.rows));
  text('steps', number(s.learner.step));
  text('loss', fixed(s.learner.loss, 4));
  text('match-rate', `${fixed(s.rates.matchesPerMinute, 1)} 场 / 分钟`);
  text('sample-rate', `${fixed(s.rates.samplesPerSecond, 0)} 条 / 秒`);
  text('used', `已训练 ${number(s.learner.usedSamples)} 条样本`);
  text('updates', `${fixed(s.rates.updatesPerSecond, 2)} 更新 / 秒`);
  const gpu = s.hardware.gpu;
  text('gpu-name', gpu?.name || s.learner.deviceName || '等待 GPU');
  text('gpu-util', gpu ? `${gpu.utilization}% · ${gpu.temperature}°C` : '暂不可用');
  text(
    'vram',
    gpu ? `${fixed(gpu.usedMiB / 1024, 1)} / ${fixed(gpu.totalMiB / 1024, 1)} GiB` : '暂不可用',
  );
  text('cpu-util', `${fixed(s.hardware.cpuPercent, 1)}%`);
  $('gpu-meter').value = gpu?.utilization || 0;
  $('vram-meter').value = gpu ? (gpu.usedMiB / gpu.totalMiB) * 100 : 0;
  $('cpu-meter').value = s.hardware.cpuPercent || 0;
  text(
    'ram',
    `内存 ${fixed(s.hardware.ramUsedBytes / 2 ** 30, 1)} / ${fixed(s.hardware.ramTotalBytes / 2 ** 30, 1)} GiB`,
  );
  text('actor-count', `${s.totals.liveActors} / ${s.config.actors} 在线`);
  text('model', `v${s.latest.version ?? '—'}`);
  text('backlog', `${s.pendingShards} 个`);
  text('objective', `${s.config.objective.toUpperCase()} / ${number(s.config.batchSize)}`);
  text(
    'heartbeat',
    s.learnerAgeSeconds === null ? '等待' : `${fixed(s.learnerAgeSeconds, 1)} 秒前`,
  );
  $('actors').replaceChildren(
    ...s.actors.map((a) => {
      const e = document.createElement('span');
      e.className = 'actor' + (a.alive ? '' : ' off');
      e.textContent = `槽 ${a.slot} · v${a.loadedModel ?? '—'}`;
      e.title = `${a.matches} 场 / ${a.rows} 样本 / ${fixed(a.ageSeconds, 1)} 秒前`;
      return e;
    }),
  );
  chart('loss-chart', s.history, 'loss', '#64e1b3');
  chart('sample-chart', s.history, 'rows', '#6caaf8');
  const range =
    s.history.length > 1
      ? `${new Date(s.history[0].time).toLocaleTimeString()} — ${new Date(s.history.at(-1).time).toLocaleTimeString()}`
      : '等待下一次刷新';
  text('loss-range', range);
  text('sample-range', range);
  const names = { random: '随机出牌', rule: '规则机器人', p0: 'P0' };
  $('evaluations').replaceChildren(
    ...(s.evaluations.length
      ? s.evaluations.map((e) =>
          row([
            `${names[e.opponent] || e.opponent} / #${e.block}`,
            `${e.matches} 场`,
            `${e.wins} / ${e.losses} / ${e.draws}`,
            pct(e.matchWinRate),
            pct(e.roundWinRate),
            fixed(e.averageUpgradePoints, 3),
            e.confidence95?.matchWinRate
              ? e.confidence95.matchWinRate.map(pct).join(' – ')
              : '样本不足',
          ]),
        )
      : [row(['尚未完成评测', '—', '—', '—', '—', '—', '—'])]),
  );
  text('path', s.run);
  text('updated', `最后刷新 ${new Date(s.observedAt).toLocaleTimeString()} · 每 2 秒更新`);
  const alert =
    s.learner.error ||
    (s.phase === 'unconfirmed' ? '训练心跳过期或进程尚未就绪，请检查运行状态。' : '');
  $('alert').hidden = !alert;
  $('alert').textContent = alert;
}
let fetching = false;
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' }),
      data = await response.json();
    if (!response.ok) throw Error(data.error);
    render(data);
  } catch (error) {
    $('alert').hidden = false;
    text('alert', '暂时无法读取训练状态：' + error.message);
    text('phase', '连接中断');
    $('phase').className = 'badge error';
  } finally {
    fetching = false;
  }
}
$('refresh').addEventListener('click', refresh);
$('auto').addEventListener('change', () => {
  if ($('auto').checked) refresh();
});
setInterval(() => {
  if ($('auto').checked) refresh();
}, 2000);
refresh();
