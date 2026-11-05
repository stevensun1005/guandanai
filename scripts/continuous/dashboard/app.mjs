const element = (id) => document.getElementById(id);
const set = (id, value) => (element(id).textContent = value);
const number = (value) => Number(value || 0).toLocaleString('zh-CN');
const zone = { timeZone: 'America/Toronto', hour12: false };
const time = (value) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        ...zone,
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const clock = (value) =>
  value
    ? new Date(value).toLocaleTimeString('zh-CN', {
        ...zone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

const outcomes = {
  accept: '通过，成为新冠军',
  reject: '未通过',
  inconclusive: '证据不足',
  regression: '明显退步',
  'no-regression': '未退步',
};
const stopReasons = {
  'operator-stop': '人工停止',
  'time-limit': '达到计划时长',
  'anchor-regression': '连续两次锚点退步',
  'source-changed': '训练代码发生变化',
  'crash-limit': '进程连续崩溃',
  'disk-limit': '磁盘超过上限',
  'supervisor-error': '调度进程出错',
};
const eventNames = {
  initialized: '创建训练',
  start: '启动训练',
  snapshot: '保存快照进联赛池',
  'gate-start': '开始冠军门控',
  'gate-finish': '冠军门控结束',
  'gate-interrupted': '冠军门控中断',
  'anchor-start': '开始锚点检查',
  'anchor-finish': '锚点检查结束',
  champion: '产生新冠军',
  shutdown: '训练停机',
  stop: '触发停止',
  'process-exit': '进程退出',
  'protocol-change': '调整采样方式（协议变化）',
};
const processName = (process) => {
  const base =
    process.name === 'learner'
      ? '训练'
      : process.name.startsWith('actor-')
        ? '采样 ' + (Number(process.name.slice(6)) + 1)
        : process.name === 'gate'
          ? '冠军门控'
          : process.name === 'anchor'
            ? '锚点检查'
            : process.name;
  return base + (process.alive === false ? ' · 未运行' : '');
};
const node = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
};

function render(data) {
  const running = data.phase === 'running';
  const stopped = data.phase === 'stopped';

  set('subtitle', `多伦多时间 · 最后读取 ${clock(data.observedAt)} · 每 5 秒自动刷新`);
  set('state', running ? '● 训练中' : stopped ? '■ 已停止' : '⚠ 状态待确认');
  element('state').dataset.phase = data.phase;

  set('run-name', (data.run || '').split(/[\\/]/).pop() || '—');
  set(
    'task-title',
    stopped
      ? `持续自对弈训练 · 已停止（${stopReasons[data.stopReason] || data.stopReason || '原因未记录'}）`
      : '持续自对弈训练',
  );
  const change = data.protocolChanges?.at(-1);
  element('protocol').hidden = !change;
  if (change)
    set(
      'protocol',
      `${time(change.at)} 起调整了采样方式（${data.actorImplementation === 'fast' ? '改用 GPU 批量推理的快速采样进程' : '采样设置变化'}），属于协议变化，详见研究报告。`,
    );

  const hours = data.elapsedSeconds / 3600;
  const planned = data.plannedHours;
  set('elapsed', `已运行 ${hours.toFixed(2)} 小时`);
  set(
    'planned',
    planned
      ? `/ 计划 ${planned} 小时（${Math.min(100, (hours / planned) * 100).toFixed(0)}%）`
      : '',
  );
  element('progress').value = planned ? Math.min(100, (hours / planned) * 100) : 0;
  set(
    'eta',
    running && planned
      ? `预计 ${time(Date.parse(data.observedAt) + Math.max(0, planned * 3600 - data.elapsedSeconds) * 1000)} 结束`
      : stopped
        ? `停止于 ${time(data.stoppedAt)}`
        : '',
  );

  set('matches', number(data.totals.matches));
  set('decisions', `学习决策 ${number(data.totals.decisions)}`);
  set('steps', number(data.learner.step));
  set('buffer', `缓冲样本 ${number(data.learner.buffer)} 行`);
  set('rate', data.decisionsPerSecond == null ? '—' : number(Math.round(data.decisionsPerSecond)));
  const samplers = data.processes.filter((p) => p.name.startsWith('actor-') && p.alive !== false);
  const fast = samplers.filter((p) => p.implementation === 'fast').length;
  set(
    'samplers',
    `决策/秒 · ${samplers.length} 个采样进程${fast === samplers.length && fast ? '（快速版）' : fast ? `（${fast} 个快速版）` : ''}`,
  );
  const updates = data.learnerUpdatesPerSecond ?? data.learner.stepsPerSecond;
  set('update-rate', updates == null ? '—' : updates.toFixed(1));
  set(
    'learner-state',
    '步/秒 · ' +
      (stopped
        ? '已停止'
        : data.learner.state === 'training'
          ? '正在训练'
          : data.learner.state === 'waiting-for-data'
            ? '等待新样本'
            : '准备中'),
  );

  const changes = Math.max(0, (data.champion?.history?.length || 1) - 1);
  set('champion', `${data.champion?.version || '—'} · 已更替 ${changes} 次`);
  set('latest', `${data.latest?.version || '—'} · ${time(data.latest?.publishedAt)} 保存`);
  set(
    'anchor',
    running
      ? `${time(data.nextAnchorAt)} · 连续退步 ${data.anchorRegressionStreak}/2`
      : '训练未运行',
  );

  const memory =
    data.learner.gpuAllocatedBytes == null
      ? ''
      : ` · 显存 ${(data.learner.gpuAllocatedBytes / 2 ** 20).toFixed(0)} MiB`;
  set(
    'device',
    (data.learner.deviceName || (data.device?.startsWith('cuda') ? 'GPU' : 'CPU')) + memory,
  );
  set('disk', data.diskGB == null ? '—' : `${data.diskGB.toFixed(1)} GB`);
  const publication = data.publication || {};
  set(
    'publication',
    (publication.reporterAlive ? '自动同步中' : '报告器未运行') +
      (publication.snapshotAt ? ` · 上次 ${time(publication.snapshotAt)}` : ''),
  );
  set('updated', `${clock(data.updatedAt)}（${Math.max(0, Math.round(data.heartbeatAge))} 秒前）`);

  element('processes').replaceChildren(
    ...data.processes.map((process) =>
      node(
        'span',
        processName(process),
        process.alive === false ? 'offline' : process.implementation === 'fast' ? 'fast' : '',
      ),
    ),
  );

  const rows = data.evaluations
    .slice()
    .reverse()
    .map((record) => {
      const row = node('tr');
      const conclusion =
        record.status === 'complete'
          ? outcomes[record.decision] || record.decision
          : record.status === 'running' && running
            ? '进行中'
            : '未完成';
      const score =
        record.score == null
          ? '—'
          : `${(record.score * 100).toFixed(1)}%` +
            (record.interval
              ? `（${record.interval.map((x) => (x * 100).toFixed(0)).join('–')}%）`
              : '');
      for (const [text, className] of [
        [record.kind === 'anchor' ? '锚点检查' : '冠军门控'],
        [record.challenger, 'mono'],
        [
          record.kind === 'anchor' ? '初始模型' : record.opponent || '当前冠军',
          record.kind === 'anchor' ? '' : 'mono',
        ],
        [`${record.pairs}/${record.maxPairs} 对`, 'num'],
        [`${record.wins} / ${record.losses} / ${record.draws}`, 'num'],
        [score, 'num'],
        [conclusion, `verdict ${record.decision || record.status}`],
      ])
        row.append(node('td', text, className));
      return row;
    });
  element('evaluations').replaceChildren(
    ...(rows.length
      ? rows
      : [
          (() => {
            const row = node('tr');
            const cell = node('td', '还没有对战检查；保存第一个新模型后开始。', 'muted');
            cell.colSpan = 7;
            row.append(cell);
            return row;
          })(),
        ]),
  );

  set('roadmap-state', running ? '进行中' : stopped ? '已停止，等待复核' : '状态待确认');

  element('events').replaceChildren(
    ...data.events
      .slice()
      .reverse()
      .slice(0, 8)
      .map((event) => {
        const item = node('li');
        item.append(node('time', time(event.t)));
        const detail =
          event.kind === 'gate-finish' || event.kind === 'anchor-finish'
            ? event.decision
              ? ' · ' + (outcomes[event.decision] || event.decision)
              : ''
            : event.kind === 'stop' && event.reason
              ? ' · ' + event.reason
              : '';
        item.append(
          node(
            'span',
            (eventNames[event.kind] || event.kind) +
              (event.version || event.challenger
                ? ' · ' + (event.version || event.challenger)
                : '') +
              detail,
          ),
        );
        return item;
      }),
  );

  const warning =
    data.phase === 'unconfirmed'
      ? '调度进程没有在运行，或状态文件已过期。下面是最后一次记录，不代表训练仍在继续。'
      : '';
  element('connection').hidden = !warning;
  element('connection').textContent = warning;
}

async function refresh() {
  try {
    const response = await fetch('/api/status', {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '无法读取状态');
    render(data);
  } catch (error) {
    element('connection').hidden = false;
    set('connection', `暂时连不上训练记录（${error.message}），下面的数据可能已过期，正在重试。`);
    set('state', '⚠ 连接中断');
    element('state').dataset.phase = 'unconfirmed';
  }
}
await refresh();
setInterval(refresh, 5000);
