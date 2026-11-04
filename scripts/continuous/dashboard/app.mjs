const element = (id) => document.getElementById(id);
const set = (id, value) => (element(id).textContent = value);
const number = (value) => Number(value || 0).toLocaleString('zh-CN');
const time = (value) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'America/Toronto', hour12: false }) +
      ' 多伦多'
    : '暂无';
const outcomes = {
  accept: '接受挑战者',
  reject: '拒绝挑战者',
  inconclusive: '证据不足',
  regression: '明确退步',
  'no-regression': '未触发退步阈值',
};
const reasons = {
  'operator-stop': '人工停止',
  'time-limit': '达到运行时限',
  'anchor-regression': '连续两次锚点退步',
  'source-changed': '训练源码发生变化',
  'crash-limit': '进程连续崩溃',
  'disk-limit': '达到磁盘上限',
  'supervisor-error': '调度进程错误',
};
const label = (name) =>
  name === 'learner'
    ? '训练进程'
    : name.startsWith('actor-')
      ? '采样 ' + (Number(name.slice(6)) + 1)
      : name === 'anchor'
        ? '锚点评测'
        : name === 'gate'
          ? '冠军门控'
          : name;
const child = (tag, content, className) => {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
};

function render(data) {
  const gpu = data.device?.startsWith('cuda');
  set(
    'device',
    (data.learner.deviceName || (gpu ? 'GPU 初始化中' : 'CPU')) + (gpu ? ' · GPU 反向传播' : ''),
  );
  set('observed', time(data.observedAt));
  set(
    'gpu-memory',
    data.learner.gpuAllocatedBytes == null
      ? '—'
      : (data.learner.gpuAllocatedBytes / 2 ** 20).toFixed(0) + ' MiB（不含驱动及其他进程）',
  );
  set(
    'update-rate',
    data.learner.stepsPerSecond == null
      ? '—'
      : data.learner.stepsPerSecond.toFixed(2) + ' 次/秒（本进程均值）',
  );
  const cpuPaused = data.cpuBaseline?.stoppedAt;
  element('baseline-note').hidden = !cpuPaused;
  if (cpuPaused)
    set(
      'baseline-note',
      `纯 CPU 基线已停止，占用已释放。最后完成 ${number(data.cpuBaseline.totals?.matches)} 场、${number(data.cpuBaseline.learner?.step)} 次更新，检查点保留。以下主视图显示 GPU 运行。`,
    );
  set(
    'description',
    `${data.actorCount} 个采样进程收集完整比赛，训练进程更新整个价值网络。每 ${data.anchorHours} 小时与初始模型检查，连续两次明显退步会自动停止。`,
  );
  const phase = { running: '● 正在训练', stopped: '■ 已停止', unconfirmed: '状态待确认' }[
    data.phase
  ];
  set('state', phase);
  element('state').dataset.phase = data.phase;
  set(
    'task',
    data.phase === 'stopped'
      ? '本次训练已停止'
      : gpu
        ? 'GPU 加速的长期自对弈训练'
        : '默认配置的长期自对弈训练',
  );
  set(
    'roadmap-state',
    data.phase === 'running'
      ? '训练运行中，尚未完成第 1 步'
      : data.phase === 'stopped'
        ? '等待复核结果，未自动进入下一步'
        : '等待确认进程与状态',
  );
  const hours = data.elapsedSeconds / 3600;
  set('elapsed', '实际运行 ' + hours.toFixed(2) + ' 小时');
  const planned = data.plannedHours;
  element('progress').value = planned ? Math.min(100, (hours / planned) * 100) : 0;
  set(
    'fraction',
    planned ? `${((hours / planned) * 100).toFixed(1)}% / ${planned} 小时计划` : '未设置固定时限',
  );
  set('matches', number(data.totals.matches));
  set('decisions', number(data.totals.decisions) + ' 个学习决策');
  set('steps', number(data.learner.step));
  set('buffer', number(data.learner.buffer) + ' 行缓冲样本');
  set('rate', data.decisionsPerSecond == null ? '—' : number(Math.round(data.decisionsPerSecond)));
  set('disk', data.diskGB == null ? '—' : data.diskGB.toFixed(2) + ' GB');
  set(
    'learner',
    data.phase === 'stopped'
      ? '停止原因：' + (reasons[data.stopReason] || data.stopReason || '尚未记录')
      : data.learner.state === 'waiting-for-data'
        ? '正在等待新样本：采样进程继续打牌，训练进程遵守重放比上限。'
        : data.learner.state === 'training'
          ? '正在使用采样到的比赛数据更新整个价值网络。'
          : '正在准备训练进程。',
  );
  element('processes').replaceChildren(
    ...data.processes.map((process) =>
      child(
        'span',
        label(process.name) + (process.alive === false ? ' · 未运行' : ''),
        process.alive === false ? 'offline' : '',
      ),
    ),
  );
  set('latest', (data.latest?.version || '尚未保存') + ' · ' + time(data.latest?.publishedAt));
  set(
    'champion',
    (data.champion?.version || '暂无') +
      ' · 更替 ' +
      Math.max(0, (data.champion?.history?.length || 1) - 1) +
      ' 次',
  );
  set(
    'anchor',
    data.phase === 'running'
      ? time(data.nextAnchorAt) + ' · 连续退步 ' + data.anchorRegressionStreak + '/2'
      : '训练未运行',
  );
  const publication = data.publication;
  set(
    'publication',
    (publication.reporterAlive ? '报告器运行中' : '报告器未运行') +
      ' · ' +
      (publication.confirmed ? '上次快照已推送 main：' : '证据快照（尚未确认推送）：') +
      time(publication.snapshotAt),
  );
  set(
    'updated',
    time(data.updatedAt) + ' · ' + Math.max(0, Math.round(data.heartbeatAge)) + ' 秒前',
  );
  set('run', data.run);
  element('gpu-panel').hidden = !data.deviceRuns?.length;
  element('gpu-runs').replaceChildren(
    ...(data.deviceRuns || []).map((run) => {
      const box = child('div', '', 'evaluation');
      box.append(child('strong', run.deviceName + ' · ' + run.name));
      box.append(
        child(
          'p',
          (run.phase === 'running' ? '运行中' : run.phase === 'stopped' ? '已停止' : '状态待确认') +
            ` · ${run.actorCount} 个采样进程 · 实际运行 ${(run.elapsedSeconds / 3600).toFixed(2)} 小时`,
        ),
      );
      box.append(
        child('p', `完成 ${number(run.totals.matches)} 场 · ${number(run.step)} 次全网络更新`),
      );
      box.append(
        child(
          'p',
          (run.learnerState === 'waiting-for-data'
            ? '等待新样本'
            : run.learnerState === 'training'
              ? '正在更新参数'
              : '等待训练状态') +
            (run.gpuAllocatedBytes == null
              ? ''
              : ` · 张量分配显存 ${(run.gpuAllocatedBytes / 2 ** 20).toFixed(0)} MiB`),
          'muted small',
        ),
      );
      return box;
    }),
  );
  const evaluations = data.evaluations.map((record) => {
    const box = child('div', '', 'evaluation');
    box.append(
      child(
        'strong',
        (record.kind === 'anchor' ? '锚点检查' : '冠军门控') + ' · ' + record.challenger,
      ),
    );
    box.append(
      child(
        'p',
        `${record.pairs} / ${record.maxPairs} 对 · 胜 / 负 / 平：${record.wins} / ${record.losses} / ${record.draws}`,
      ),
    );
    box.append(
      child(
        'p',
        record.status === 'complete'
          ? outcomes[record.decision] || record.decision
          : record.status === 'running' && data.phase === 'running'
            ? '评测中，尚无最终结论'
            : '检查未完成，无最终结论',
        'muted',
      ),
    );
    if (record.score !== null)
      box.append(
        child(
          'p',
          `平均得分 ${(record.score * 100).toFixed(2)}%` +
            (record.interval
              ? ` · 95% 区间 [${record.interval.map((x) => (x * 100).toFixed(2)).join('%, ')}%]`
              : '') +
            (record.status !== 'complete' ? '（阶段记录）' : ''),
          'small muted',
        ),
      );
    return box;
  });
  element('evaluations').replaceChildren(
    ...(evaluations.length
      ? evaluations
      : [
          child(
            'p',
            '本次运行还没有对战检查。先收集样本和更新网络，保存首个新模型后才开始门控。',
            'muted',
          ),
        ]),
  );
  const eventNames = {
    initialized: '创建运行并冻结配置',
    start: '启动训练',
    snapshot: '保存联赛快照',
    'gate-start': '开始冠军门控',
    'gate-finish': '完成冠军门控',
    'anchor-start': '开始锚点检查',
    'anchor-finish': '结束锚点检查',
    champion: '产生新冠军',
    shutdown: '训练停机',
    stop: '触发停止规则',
    'process-exit': '子进程退出',
  };
  element('events').replaceChildren(
    ...data.events
      .slice()
      .reverse()
      .map((event) => {
        const item = child(
          'li',
          (eventNames[event.kind] || event.kind) +
            (event.version ? ' · ' + event.version : '') +
            (event.reason ? ' · ' + event.reason : ''),
        );
        item.prepend(child('time', time(event.t)));
        return item;
      }),
  );
  const warning =
    data.phase === 'unconfirmed'
      ? '状态文件已过期或调度进程未运行。以下为最后记录，不能据此认为训练仍在继续。'
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
    set('connection', '无法连接实时进度：' + error.message + '。下面的数据可能已过期。正在重试。');
    set('state', '连接中断');
    element('state').dataset.phase = 'unconfirmed';
  }
}
await refresh();
setInterval(refresh, 5000);
