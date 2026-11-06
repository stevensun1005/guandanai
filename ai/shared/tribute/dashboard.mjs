/** Read-only specialist progress. It does not control or restart any trainer. */
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { readJSON, option } from '../../danMCai/training/continuous/lib.mjs';

const run = resolve(option('run', 'ai/danMCai/runs/tribute-20261106'));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>进还贡专项训练</title>
<style>body{background:#101c19;color:#e6ede8;font:16px system-ui;margin:0;padding:28px}main{max-width:1100px;margin:auto}header{display:flex;justify-content:space-between;gap:16px;align-items:center}h1{font-size:27px}small,p{color:#adc0b5;line-height:1.65}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}article{padding:20px;background:#19372c;border:1px solid #3a5b4b;border-radius:16px}strong{display:block;font-size:28px;color:#f4c95f;margin:10px 0}.wide{margin-top:18px;padding:20px;background:#162b23;border-radius:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 system-ui}#state{color:#66dca0}a{color:#f4c95f}</style>
<main><header><h1>进还贡专项训练</h1><span id="state">读取中</span></header><p id="deadline"></p><p>独立共享网络 · danMCai / GuanZero 两个输出头 · 学习整局最终升级分。当前训练与开发分数不是独立胜率。</p>
<section class="grid"><article>训练决策组<strong id="train">—</strong>全部合法动作反事实回放</article><article>开发决策组<strong id="dev">—</strong>与训练种子分开</article><article>已落盘整局回放<strong id="rounds">—</strong>不含未完成的决策组</article><article>样本行<strong id="rows">—</strong>每行对应一个合法贡／还选项</article><article>共享网络训练步<strong id="steps">—</strong><span id="device">GPU 尚未首训</span></article><article>可用内存<strong id="ram">—</strong><span id="cpu">预留目标至少 4 GiB</span></article></section>
<section class="wide"><h2>正在做什么</h2><pre id="current"></pre><h2>底座与开发观察</h2><pre id="models"></pre><pre id="development"></pre><p id="updated"></p></section></main>
<script>
const el=id=>document.getElementById(id), stages={loading:'加载冻结底座',sampling:'生成整局反事实样本','memory-pause':'等待内存恢复',fitting:'GPU 更新共享网络',stopped:'已到时停止采样','fusion-validation':'验证并融合',complete:'已完成','awaiting-fusion':'已保存，等待融合',failed:'运行失败'};
async function update(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error(await r.text());const s=await r.json();el('state').textContent=stages[s.stage]||s.stage||'等待启动';el('deadline').textContent='固定截止：'+new Date(s.deadlineUTC).toLocaleString('zh-CN',{timeZone:'America/Toronto',hour12:false})+'（多伦多） · 重启不延长';for(const [id,key]of [['train','trainingGroups'],['dev','developmentGroups'],['rounds','completedCounterfactualRounds'],['rows','rows']])el(id).textContent=Number(s[key]||0).toLocaleString();el('steps').textContent=s.learner?.step??'尚未开始';el('device').textContent=s.learner?.deviceName||'GPU 尚未首训';el('ram').textContent=Number(s.freeGiB||0).toFixed(1)+' GiB';el('cpu').textContent='采样进程平均约 '+(Number(s.cpuCorePercent||0)/100).toFixed(2)+' 个 CPU 核';el('current').textContent=s.error||s.note||JSON.stringify(s.current||{},null,2);el('models').textContent=(s.sourceModels||[]).map(m=>m.version+' · SHA '+m.sha256.slice(0,16)).join('\n');el('development').textContent=s.learner?.development?'开发反事实积分差（非胜率）：'+JSON.stringify(s.learner.development.meanCounterfactualGain):'等待首批开发结果';el('updated').textContent='最后更新：'+s.updatedUTC+' · 每 5 秒刷新';if(Date.now()-Date.parse(s.updatedUTC)>90000&&!['complete','stopped','awaiting-fusion','failed'].includes(s.stage))el('state').textContent='状态超过 90 秒未更新，请检查进程'}catch(e){el('state').textContent='进度尚不可用：'+e.message}}
update();setInterval(update,5000);
</script></html>`;
createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    response.writeHead(405);
    response.end();
    return;
  }
  if (request.url === '/api/status') {
    const data = readJSON(join(run, 'progress.json'));
    response.setHeader('Content-Type', 'application/json');
    response.writeHead(data ? 200 : 503);
    response.end(JSON.stringify(data || { stage: 'waiting', message: 'Training has not started' }));
    return;
  }
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(Number(option('port', '8788')), '127.0.0.1', () =>
  console.log('Specialist dashboard: http://127.0.0.1:' + option('port', '8788') + '/'),
);
