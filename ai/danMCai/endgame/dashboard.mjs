/**
 * Read-only local dashboard for an endgame oracle-guiding run. Listens on 127.0.0.1 only, reads the
 * run's status files every request, never writes to the run or controls training.
 *
 *   node ai/danMCai/endgame/dashboard.mjs --run=<dir> [--port=8768]
 */
import { createServer } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readJSON } from '../training/continuous/lib.mjs';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const age = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : null);

const history = [];

export function snapshot(run) {
  const config = readJSON(join(run, 'config.json'));
  if (!config) throw Error('运行尚未生成 config.json');
  const status = readJSON(join(run, 'status.json'), {});
  const learner = readJSON(join(run, 'learner', 'status.json'), {});
  const latest = readJSON(join(run, 'models', 'latest.json'), {});
  const actors = config.actor.slotSeeds.map((owned, slot) => {
    const blocks = Array.isArray(owned[0]) ? owned : [owned];
    const total = blocks.reduce((sum, [start, end]) => sum + end - start, 0);
    const a = readJSON(join(run, 'actors', `slot-${slot}.json`), {});
    return {
      slot,
      rounds: a.rounds || 0,
      rows: a.rows || 0,
      shards: a.shards || 0,
      seedProgress: (a.rounds || 0) / total,
      updatedAgeSeconds: age(a.updatedAt),
      stopped: !!a.stopped,
    };
  });
  let shardFiles = 0;
  try {
    shardFiles = readdirSync(join(run, 'shards')).filter((f) => f.endsWith('.json')).length;
  } catch {}
  const totals = {
    rounds: actors.reduce((s, a) => s + a.rounds, 0),
    rows: actors.reduce((s, a) => s + a.rows, 0),
  };
  const now = Date.now();
  history.push({
    t: now,
    rows: totals.rows,
    step: learner.step || 0,
    loss: learner.lossEma,
    keep: learner.oracleKeep,
  });
  while (history.length > 2 && now - history[0].t > 4 * 3600_000) history.shift();
  const window = history.filter((h) => now - h.t <= 120_000);
  const first = window[0];
  const seconds = first ? (now - first.t) / 1000 : 0;
  const created = Date.parse(config.createdAt),
    deadline = Date.parse(config.deadline);
  const supervisorAlive = alive(status.pid);
  const heartbeat = age(status.updatedAt);
  return {
    run: basename(run),
    purpose: config.purpose || 'endgame oracle-guiding training',
    champion: config.champion,
    threshold: config.actor.threshold,
    temperature: config.actor.temperature,
    learnerConfig: config.learner,
    createdAt: config.createdAt,
    deadline: config.deadline,
    timeProgress: Math.min(1, Math.max(0, (now - created) / (deadline - created))),
    remainingSeconds: Math.max(0, (deadline - now) / 1000),
    running: supervisorAlive && heartbeat !== null && heartbeat < 30 && !status.endedAt,
    supervisor: {
      pid: status.pid,
      alive: supervisorAlive,
      heartbeatAgeSeconds: heartbeat,
      children: (status.children || []).map((c) => ({ ...c, alive: alive(c.pid) })),
      restarts: status.restarts || {},
      stopReason: status.stopReason || null,
      endedAt: status.endedAt || null,
    },
    learner: { ...learner, heartbeatAgeSeconds: age(learner.updatedAt) },
    latest,
    actors,
    totals: { ...totals, shardFiles },
    rates: {
      rowsPerSecond: seconds >= 20 ? (totals.rows - first.rows) / seconds : null,
      stepsPerSecond: seconds >= 20 ? ((learner.step || 0) - first.step) / seconds : null,
    },
    machine: {
      cpus: cpus().length,
      load1: loadavg()[0],
      freeMemoryGiB: freemem() / 2 ** 30,
      totalMemoryGiB: totalmem() / 2 ** 30,
    },
    history: history.filter((_, i) => i % Math.max(1, Math.floor(history.length / 240)) === 0),
    readAt: new Date(now).toISOString(),
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>尾盘训练面板</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#667085;--line:#e3e6ec;--accent:#2f6fde;--ok:#15803d;--bad:#b42318;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--ink:#e6e9ef;--muted:#98a2b3;--line:#2a313b;--accent:#6ea0ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:1080px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card h2{font-size:13px;color:var(--muted);margin:0 0 8px;font-weight:600}
.big{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}.row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
.row span:first-child{color:var(--muted)}.num{font-variant-numeric:tabular-nums}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:6px 0}.bar>div{height:100%;background:var(--accent)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{text-align:right;padding:4px 6px;border-bottom:1px solid var(--line)}td:first-child,th:first-child{text-align:left}th{color:var(--muted);font-weight:600;font-size:12px}
svg{width:100%;height:70px}.note{color:var(--muted);font-size:12px;margin-top:12px}
.wide{grid-column:1/-1}
</style></head><body><main>
<h1>danMCai 尾盘训练（明牌引导）</h1><div class="sub" id="sub">读取中…</div>
<div class="grid" id="grid"></div>
<p class="note">只读面板：每 3 秒读取运行目录的真实状态文件，不控制训练。时间进度条只表示本次固定窗口用掉的时间，不代表棋力；损失下降、更新步数和样本数都不是胜率。明牌信息只进训练，导出的学生模型只看自己的牌。</p>
</main><script>
const f=(n,d=0)=>n==null||!isFinite(n)?'—':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d});
const dur=s=>{if(s==null)return'—';s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+' 小时 '+m+' 分':m+' 分 '+(s%60)+' 秒'};
const pill=(t,c)=>'<span class="pill '+c+'">'+t+'</span>';
function spark(points,key,lo,hi){const v=points.map(p=>p[key]).filter(x=>x!=null);if(v.length<2)return'<div class="note">数据不足</div>';
const a=lo??Math.min(...v),b=hi??Math.max(...v),r=b-a||1;const d=v.map((x,i)=>(i/(v.length-1)*300).toFixed(1)+','+(65-(x-a)/r*60).toFixed(1)).join(' ');
return '<svg viewBox="0 0 300 70" preserveAspectRatio="none"><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="'+d+'"/></svg><div class="row"><span>区间</span><span class="num">'+f(a,3)+' – '+f(b,3)+'</span></div>'}
async function tick(){let s;try{s=await (await fetch('api/status',{cache:'no-store'})).json()}catch(e){document.getElementById('sub').innerHTML=pill('面板连接中断','bad');return}
if(s.error){document.getElementById('sub').textContent=s.error;return}
const L=s.learner||{},st=s.running?pill('训练中','ok'):s.supervisor.endedAt?pill('已结束 · '+(s.supervisor.stopReason||''),'warn'):pill('未在运行','bad');
document.getElementById('sub').innerHTML=st+' &nbsp;'+s.run+' · 教师 '+s.champion.id+'／'+s.champion.version+' · 尾盘阈值 全桌剩 ≤'+s.threshold+' 张 · 读取于 '+new Date(s.readAt).toLocaleTimeString('zh-CN');
const kids=(s.supervisor.children||[]).map(c=>c.name+(c.alive?'':' ✗')).join('、')||'—';
const actors=s.actors.map(a=>'<tr><td>槽 '+a.slot+'</td><td>'+f(a.rounds)+'</td><td>'+f(a.rows)+'</td><td>'+f(a.seedProgress*100,2)+'%</td><td>'+(a.updatedAgeSeconds==null?'—':dur(a.updatedAgeSeconds)+'前')+'</td></tr>').join('');
document.getElementById('grid').innerHTML=
'<div class="card"><h2>固定窗口</h2><div class="big">'+dur(s.remainingSeconds)+'</div><div class="bar"><div style="width:'+(s.timeProgress*100).toFixed(1)+'%"></div></div><div class="row"><span>截止</span><span>'+new Date(s.deadline).toLocaleString('zh-CN')+'</span></div><div class="row"><span>时间进度</span><span class="num">'+f(s.timeProgress*100,1)+'%</span></div></div>'+
'<div class="card"><h2>学习器（MPS）</h2><div class="big">'+f(L.step)+' 步</div><div class="row"><span>状态</span><span>'+(L.state||'—')+'</span></div><div class="row"><span>更新速度</span><span class="num">'+f(s.rates.stepsPerSecond,2)+' 步/秒</span></div><div class="row"><span>损失（EMA）</span><span class="num">'+f(L.lossEma,4)+'</span></div><div class="row"><span>心跳</span><span>'+(L.heartbeatAgeSeconds==null?'—':dur(L.heartbeatAgeSeconds)+'前')+'</span></div></div>'+
'<div class="card"><h2>明牌信息保留率</h2><div class="big">'+(L.oracleKeep==null?'—':f(L.oracleKeep*100,1)+'%')+'</div><div class="bar"><div style="width:'+((L.oracleKeep??0)*100).toFixed(1)+'%"></div></div><div class="row"><span>降到 0 的步数</span><span class="num">'+f(s.learnerConfig.oracleDecaySteps)+'</span></div><div class="row"><span>说明</span><span>逐步去掉他家手牌</span></div></div>'+
'<div class="card"><h2>样本</h2><div class="big">'+f(s.totals.rows)+' 行</div><div class="row"><span>采样速度</span><span class="num">'+f(s.rates.rowsPerSecond,1)+' 行/秒</span></div><div class="row"><span>已打局数</span><span class="num">'+f(s.totals.rounds)+'</span></div><div class="row"><span>已入回放</span><span class="num">'+f(L.ingestedRows)+'</span></div><div class="row"><span>回放容量</span><span class="num">'+f(L.replayRows)+' / '+f(s.learnerConfig.capacity)+'</span></div></div>'+
'<div class="card"><h2>最新学生模型</h2><div class="big">'+(s.latest.version||'—')+'</div><div class="row"><span>SHA-256</span><span class="num">'+(s.latest.sha256||'').slice(0,12)+'</span></div><div class="row"><span>说明</span><span>只看自己的牌，尚未独立评测</span></div></div>'+
'<div class="card"><h2>进程与本机</h2><div class="row"><span>调度器</span><span>'+(s.supervisor.alive?pill('存活','ok'):pill('未运行','bad'))+'</span></div><div class="row"><span>子进程</span><span>'+kids+'</span></div><div class="row"><span>重启次数</span><span class="num">'+(Object.entries(s.supervisor.restarts).map(([k,v])=>k+'×'+v).join(' ')||'0')+'</span></div><div class="row"><span>系统负载</span><span class="num">'+f(s.machine.load1,2)+' / '+s.machine.cpus+' 核</span></div><div class="row"><span>空闲内存</span><span class="num">'+f(s.machine.freeMemoryGiB,1)+' / '+f(s.machine.totalMemoryGiB,0)+' GiB</span></div></div>'+
'<div class="card"><h2>损失（EMA）走势</h2>'+spark(s.history,'loss')+'</div>'+
'<div class="card"><h2>明牌保留率走势</h2>'+spark(s.history,'keep',0,1)+'</div>'+
'<div class="card wide"><h2>采样进程</h2><table><tr><th>槽位</th><th>局数</th><th>尾盘样本</th><th>种子块用量</th><th>更新</th></tr>'+actors+'</table></div>'}
tick();setInterval(tick,3000);
</script></body></html>`;

function main() {
  const run = resolve(option('run', ''));
  if (!option('run')) throw Error('Missing --run');
  const port = Number(option('port', 8768));
  createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url.startsWith('/api/status')) {
      let body;
      try {
        body = snapshot(run);
      } catch (error) {
        body = { error: error.message };
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.url === '/' || request.url.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    response.writeHead(404).end();
  }).listen(port, '127.0.0.1', () => console.log(`Endgame dashboard: http://127.0.0.1:${port}/`));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
