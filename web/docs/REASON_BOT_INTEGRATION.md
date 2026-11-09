# danMCai-reason 接入指南（供其他掼蛋网站）

本文写给另一个项目的开发者或 AI 代理，目标是 Clint 的掼蛋网站（[clintsun1977/guandan](https://github.com/clintsun1977/guandan)）：用 **danMCai-reason-v000855042**（本项目编号 `9001`）替换该站目前的普通 danMCai 机器人（冠军 017，`bot/danmcai/danmcai-v000855042.onnx`）。按本文操作，只需从本仓库取文中列出的文件，不必读懂本仓库其余部分。

- **本仓库版本**：网页代码以 `296c27e82e7c9570a78395306d08af9d5a6f7c08`（2026-11-09，每步上限改为 50 秒）为准，本文第 4.1 节的打包输出也是在这个提交上得到的。本文的这次更新是在它之后提交的，所以 `296c27e` 本身不含更新后的本文。实际接入时，用包含本文的 `main` 提交（它的网页代码与 `296c27e` 相同，除非之后又有改动），并记下完整 SHA。要确认网页代码没变：`git diff --stat 296c27e <你用的提交> -- web/src ai/danMCai ai/shared` 应该没有输出；有输出时，打包文件的 SHA 会和第 4.1 节的表不同，第 14 节的自检必须重做。本文初版对应的是 `fc2ed469fe83366532ee3bc6825eaef493163c42`（每步 3／4 秒）；两者之间网页代码只改了 `web/src/ai/search/constants.mjs` 和 `client.js`（预算、首次加载等待、评价请停上一手）。
- **对方仓库**：按 Clint 仓库 `main` 的 `2d91ecca950e6617f80e500cd205450112bb40d4`（2026-11-09）核对过。文中凡是写“你们的”代码（`G`、`NET`、`NeuralBot`、`BOT_USED`、`botStart`、`aiMove`、`recModel`、`coachSnap`、`coachGrade`、`CO.shown`、`check_models`），都以这个版本为准。对方代码变了要重新核对。
- 文中出处路径都相对本仓库根目录；Clint 仓库的路径写成“Clint `路径`”。
- 第 8–10 节中给 Clint 的代码是**按 `2d91ecc` 写的示意**，没有在 Clint 的网站上运行过。它们说明必须满足的规则，最后以第 14 节的自检为准。

## 1. 这是什么

danMCai-reason 是一个**推理搜索策略**：底座是冠军 017 的网络，外面加一层“推断暗牌 → 抽样多个可能世界 → 搜索”。它**不是**新训练的模型，也**不是**新的门控冠军。清单里它的状态是 `research-bot-not-champion-deployment-not-acceptance`（`web/src/ai/model-catalog.json` 的 `searchBots[0].source.status`）。

| 部件     | 内容                                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 底座     | 冠军 017：`bot-017.onnx`，SHA-256 `462afc99…b3f7`，版本 `v000855042`，门控 gate 330。负责给候选打分、推演时四家的出牌、超时回落。                                                                                                                                           |
| 推断网络 | `belief-v1-16d76783.onnx`（特征版本 `belief-v1`）。只读公开信息，输出“每种未见牌面在下家／对家／上家”的倾向：54 种牌面 × 3 个座位 = 162 个数（`web/src/ai/search/inference.mjs`）。训练数据是冠军自博弈、不进贡、桌上 21–80 张，训练种子 4,255,121,000–4,255,160,999。      |
| 搜索规则 | 与留出测试过的 Node 版 `ai/danMCai/belief/midgame-search.mjs --worlds-source=belief --endgame=pimc --endgame-hi=20 --endgame-worlds=belief` 完全相同。浏览器版是逐行移植（`web/src/ai/search/core.mjs`），参数冻结在 `web/src/ai/search/constants.mjs` 的 `SEARCH_BOT_V1`。 |

按“桌上四家剩余总张数”分三段（`searchBand`，`web/src/ai/search/constants.mjs`）：

| 剩余张数  | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 41 张以上 | 不搜索，走 017 的普通决策。                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 21–40 张  | **中盘搜索**（`midgameDecision`）。搜索根是 017 估值前 6 的候选（同分按候选序号），合法时再加上过牌。用推断网络按手牌张数精确抽 8 个世界。每个世界里先出这一手，然后四家都按 017 贪心打到本局结束（能一手出完就出完，只有一个候选就出它，否则取 017 最高分），记本方的带符号升级分（±1／±2／±3）。**净 2 规则**（`netChoice`）：非冠军候选 r 要入选，须满足 Σ<sub>世界</sub> sign(o[r] − o[冠军]) ≥ 2，且平均分高于冠军 1e-9 以上；在入选者中取平均分最高者，平均分相差 1e-9 以内的按 017 估值高者。 |
| ≤20 张    | **尾盘精确 PIMC**（`endgameDecision`）。同一推断网络抽 8 个世界，在每个世界里用完美信息精确求解器（`ai/danMCai/endgame/solver.mjs`，单次最多 1,500,000 节点）求每个候选的值，再对解完的世界取平均。解完的世界不少于 4 个时取平均最高者，相差 1e-9 以内的按 017 估值高者；不足 4 个时出 017 的原始首选（`minWorldsFallback`，与 Node 规则一致）。                                                                                                                                                     |

另有三条规则：

- 能一手出完或只有一个候选时，不搜索，交给 017 的普通路径。**这一步由调用方判断，Worker 不做**：本仓库在 `web/src/ai/controller.js` 中先由 `prepareTableDecision` 返回，`searchRequest` 也返回 `null`。你们按第 8.2 节用打包导出的 `candidates` 判断。
- 世界种子为 `(seed*1009 + ply*7919)>>>0`（`worldSeed`）。其中 `seed` 是每局一个、与牌面无关的随机 uint32，`ply` 是 `game.log.length`（过牌也算一条）。
- 只要搜索完成并返回 `ok`，就出它选的牌；搜索完成时，017 的公开残局求解不会再覆盖这个选择。

## 2. 验证范围：能说什么、不能说什么

| 证据                                                                                                                                                                                                                                                                                             | 来源                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 留出 H4（种子 990,023,757–990,026,756，3,000 对牌，每对交换座位各打一次）：Node 版组合机器人（中盘＋尾盘）对冠军 017 对手，每对牌平均带符号升级分 **+0.237，95% 区间 [0.208, 0.266]**（文件里的 `meanSignedPoints`、`ci95`）。条件：单局、不进贡、本方两名队友都用搜索。                         | 结果 `ai/research/evaluation/window2-20261109/results/C-h4.json`（SHA-256 `17cf1dcf…075be`）；预登记 `ai/research/evaluation/window2-20261109/protocol.json`（`969eda3e…103afc`）与种子审计 `seed-audit.json`；主报告第 71 节                                                    |
| 留出 H3（种子 989,000,000–989,002,999），只有中盘搜索：+0.139 [0.111, 0.166]。                                                                                                                                                                                                                   | 结果 `ai/research/evaluation/window1-20261109/results/H3-belief.json`（`3217933d…ddb95`，`meanSignedPoints`、`ci95`）；与均匀世界的配对比较在同目录 `H3-compare.json`；预登记 `ai/research/evaluation/window1-20261109/protocol-h3.json` 与 `seed-audit-h3.json`；主报告第 70 节 |
| 浏览器移植与 Node 是否一致（开发种子，不是棋力）：265 个决策中，浏览器核心＋onnxruntime-node 与 Node 完全一致 265/265；WASM 选择相同 265/265；按当时的电脑预算（中盘 3 秒、尾盘 4 秒）运行回落 2 次，其余 263 个完成的决策都与 Node 相同。Chrome 中直接调用构建好的 Worker：93/93 相同，0 回落。 | `ai/research/evaluation/web-search-bot-parity.json`、`web-search-bot-latency.json`、`web-search-bot-9001.json`，主报告第 72 节                                                                                                                                                   |

**关于“留出”的说明**：`C-h4.json`、`H3-belief.json` 里的 `purpose` 字段写着 “not preregistered; dev seeds”，`interval` 字段写着 “development seeds, not held-out”。这两段是评测工具 `ai/danMCai/belief/midgame-search.mjs` 写死的文字，每次运行都一样，不反映这次运行的用途。H3、H4 是否留出，以预登记文件为准：`protocol.json` 写明 H4 是“审计无冲突的连续留出块，只用于评测”；`protocol-h3.json` 对 H3 也有同样说明。两个种子块都经过种子审计（`window2-20261109/seed-audit.json`、`window1-20261109/seed-audit-h3.json`）。主报告第 70、71 节记录了预登记和结果。核对时会看到这处不一致，以预登记文件为准。

可以这样说：“预算内完成时，与留出测试过的 Node 研究机器人做同样的决定；否则出冠军 017 的牌。”

不能这样说：

- 不能说网页上的机器人每对牌 +0.237，你们网站上的也不能。
- 对真人、真人队友、混合队伍（一边一个搜索机器人）和进贡局都没测过，表现可能更弱。
- 推断网络没用 ≤20 张的数据训练，尾盘不在它的训练范围内。
- 推演假设四家都按 017 出牌。
- 手机上回落会更多。
- 进贡局里用公开贡牌、还牌约束抽样，这部分没有电脑端证据。
- 它不是新冠军；在本项目里设为默认是所有者的部署决定，不是棋力验收（主报告 72 节“设为默认”）。

## 3. 总体结构

```
主线程（房主或单人页面）
  ├─ searchPayload(G, p, NET.off, seed) ── 只放本座位手牌和公开信息
  ├─ createSearchClient({spawn})       ── 一个页面只建一个，牌桌和出牌评价共用，牌桌优先
  │     └─ 专用 module Worker：search-worker.mjs
  │           ├─ 017 ONNX 会话＋推断网络 ONNX 会话（onnxruntime-web WASM，单线程）
  │           └─ 精确求解器（尾盘）
  └─ 结果检查：牌号、牌型、能否压过都对得上 → 出搜索的牌
              有任何问题 → 回落：017 普通决策（你们现有的 NeuralBot.decide('danmcai', …)）
```

Worker 在单独的线程里跑，不会卡住页面。搜索花的时间和电脑的“思考”延迟重叠：本仓库在本座位计时开始时就发请求（`web/src/game/turns.js` 调用 `TableBot.prefetch(p)`）；你们的 `botStart(p)` 也是在计时开始时调用的（Clint `web/src/game/turns.js`），在那里发请求即可。

## 4. 要复制哪些文件

### 4.1 推荐做法：两个打包文件，加 ORT 和两份模型

不要把源文件逐个抄进你们的 `//@include` 拼接构建。原因有三：

1. 这些源文件是 ES module（`export`/`import`）。
2. 搜索内部必须用**本仓库**的 `candidates`、`analyze`、`encoding`，候选顺序会影响搜索根和同分规则。
3. 研究代码 `ai/danMCai/belief/sampler.mjs` 里有 `node:fs`／`node:path` 导入，需要替换成桩模块。

做法是：在本仓库的检出里，用 esbuild 打出两个自包含的 ES module。Worker 本来就是 `type:'module'`；经典脚本页面也可以用动态 `import()` 加载客户端，你们现在加载 ORT 就是这样做的（Clint `bot/neural/neural-bot.js` 的 `ort()`）。

本仓库不提交这个打包脚本，脚本全文就是下面的代码块。它复用本仓库的 `web/tools/node-stub.mjs` 和 `ai/publishing/artifacts.mjs` 的 `modelBytes`。**不要手工复制**，用下面的命令从本文里取出（本文中第一个以 ` ```js ` 开头的代码块就是它），再核对 SHA：

````bash
# 在 guandanai 检出根目录运行，需要 Node ≥ 20.19
npm ci
awk '/^```js$/{if(!n++){f=1;next}} f&&/^```$/{exit} f' web/docs/REASON_BOT_INTEGRATION.md > web/tools/build-reason-bundle.mjs
shasum -a 256 web/tools/build-reason-bundle.mjs   # 应为 28e967d8d5de0c613de4a61e36e90aeb9cfdddb5be1b62162c7cccb2093f5dd6
node web/tools/build-reason-bundle.mjs <输出目录>
````

```js
// web/tools/build-reason-bundle.mjs（在 guandanai 检出根目录运行）
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '../src/ai/model-catalog.json' with { type: 'json' };
import { modelBytes } from '../../ai/publishing/artifacts.mjs';
import { nodeStub } from './node-stub.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.resolve(process.argv[2] || 'reason-bundle');
const bot = catalog.searchBots.find((b) => b.id === '9001');
const base = catalog.models.find((m) => m.id === bot.base);
// 与 web/tools/build.mjs 相同：模型 URL 的 ?v= 取 SHA-256 前 16 位
const versions = {
  ['bot:' + base.id]: base.sha256.slice(0, 16),
  ['belief:' + bot.id]: bot.belief.sha256.slice(0, 16),
};
for (const dir of ['assets/vendor', 'models'])
  await mkdir(path.join(out, dir), { recursive: true });
await build({
  entryPoints: [path.join(root, 'web/src/ai/search-worker.mjs')],
  outfile: path.join(out, 'assets/search-worker.mjs'),
  absWorkingDir: root, // 打包文件里的路径注释相对仓库根目录，与在哪个目录运行无关
  bundle: true,
  format: 'esm',
  target: 'es2022',
  charset: 'utf8',
  external: ['./vendor/*'],
  plugins: [nodeStub],
  define: { __MODEL_VERSIONS__: JSON.stringify(versions) },
});
await build({
  stdin: {
    contents: [
      "export { createSearchClient, deviceClass } from './web/src/ai/search/client.js';",
      "export { searchPayload } from './web/src/ai/search/payload.mjs';",
      "export { SEARCH_BOT_V1, SEARCH_BUDGETS, searchBand, hardTimeoutMs } from './web/src/ai/search/constants.mjs';",
      "export { candidates } from './web/src/ai/candidates.js';",
      "export { mergeSearchValues, rankedCoachActions, relativeRating, actionKey } from './web/src/coach/evaluation.mjs';",
      "export { botIdentity, botModelName } from './web/src/ai/model-catalog.mjs';",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'reason-client-entry.mjs',
  },
  outfile: path.join(out, 'assets/reason-client.mjs'),
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  charset: 'utf8',
});
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
  await copyFile(
    path.join(root, 'node_modules/onnxruntime-web/dist', f),
    path.join(out, 'assets/vendor', f),
  );
// modelBytes：先读 ai/publishing/cache，否则从 Release 下载；SHA-256 不符直接报错
await writeFile(path.join(out, 'models', base.file), await modelBytes(root, base));
await writeFile(
  path.join(out, 'models', bot.belief.file),
  await modelBytes(root, { id: 'belief:' + bot.id, ...bot.belief }),
);
const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }))
    e.isDirectory() ? await walk(path.join(dir, e.name)) : files.push(path.join(dir, e.name));
}
await walk(out);
for (const f of files.sort()) {
  const bytes = await readFile(f);
  console.log(
    `${createHash('sha256').update(bytes).digest('hex')}  ${bytes.length}  ${path.relative(out, f)}`,
  );
}
```

2026-11-09 用上面命令取出的脚本（SHA 如上）在 `296c27e` 的网页代码上实际运行过，输出如下（两个打包文件在 `fc2ed46` 上原为 `search-worker.mjs` 87,977 字节 `f5d632bf…ba14`、`reason-client.mjs` 49,455 字节 `45c39536…3d36`，本次在网页代码与之相同的 `4fec0f6` 上重跑仍得到这两个值）。脚本设了 `absWorkingDir: root`，在哪个目录运行结果都一样。打包文件的 SHA 会随本仓库网页代码变化，ORT 和模型的 SHA 不会变：

| 部署路径（相对输出目录）                    | 字节       | SHA-256                                                            | 说明                                                                |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `assets/search-worker.mjs`                  | 87,993     | `3cb40262b059a6bdb972eaabc7b4b6745f59a9ffcd9ff616051c2576e2a8e258` | Worker 打包（296c27e）                                              |
| `assets/reason-client.mjs`                  | 49,622     | `a9e4cf2dc8abc55449d78c2f4ef88e55a7992c48064501d18b70dfe30cf91a08` | 主线程客户端打包（296c27e，含 `candidates` 导出）                   |
| `assets/vendor/ort.wasm.min.mjs`            | 53,725     | `c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234` | onnxruntime-web 1.31.1（你们 `NeuralBot` 从 CDN 加载的也是 1.31.1） |
| `assets/vendor/ort-wasm-simd-threaded.mjs`  | 24,738     | `30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3` | 同上                                                                |
| `assets/vendor/ort-wasm-simd-threaded.wasm` | 14,848,852 | `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d` | 同上                                                                |
| `models/bot-017.onnx`                       | 5,368,650  | `462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7` | 与你们的 `bot/danmcai/danmcai-v000855042.onnx` 字节相同             |
| `models/belief-v1-16d76783.onnx`            | 3,931,285  | `16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9` | 推断网络                                                            |

**目录关系不能改**。Worker 用 `new URL('./vendor/…', import.meta.url)` 加载 ORT，用 `new URL('../models/' + 文件名, import.meta.url)` 加载模型，文件名就是 `bot-017.onnx` 和 `belief-v1-16d76783.onnx`（`web/src/ai/search-worker.mjs` 的 `load`）。所以必须保持 `X/assets/…` 和 `X/models/…` 这两层。对你们网站，建议整个输出目录放到 `bot/reason/` 下，即 `bot/reason/assets/search-worker.mjs`、`bot/reason/models/bot-017.onnx`。用这个布局，第 14 节的 Chrome 自检工具可以直接指向 `http://…/bot/reason/`。017 会多存一份（5.4 MB，与你们的 `bot/danmcai/danmcai-v000855042.onnx` 字节相同），这是为了让 Worker 打包保持原样。

不要修改打包后的 Worker、搜索参数或模型。改了任何一项，本文的一致性结论就不再适用。按本仓库规则，换底座、推断网络、参数或核心代码要用新编号并提供新证据（主报告 72 节末）。

### 4.2 源文件清单（打包脚本实际带进去的内容）

用 esbuild metafile 核对过（入口 `web/src/ai/search-worker.mjs`，`external: ['./vendor/*']`，`plugins: [nodeStub]`），Worker 共带入下列文件：

| 文件                                                                                                                                                                                                                                                                                | 作用                                                                   | 浏览器安全性                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `web/src/ai/search-worker.mjs`                                                                                                                                                                                                                                                      | Worker 入口与消息协议                                                  | 浏览器专用（`self`、`performance`、`MessageChannel`）；需要 `define __MODEL_VERSIONS__` |
| `web/src/ai/search/core.mjs`、`coach.mjs`、`inference.mjs`、`payload.mjs`、`known-cards.mjs`、`constants.mjs`                                                                                                                                                                       | 搜索核心、评价值、ONNX 调用、载荷还原、公开贡牌约束、冻结参数          | 安全                                                                                    |
| `web/src/ai/model-catalog.mjs`、`web/src/ai/model-catalog.json`                                                                                                                                                                                                                     | 9001 定义、底座 017、身份摘要（import 时会跑 `validateCatalog`）       | 安全（JSON 用 `with { type: 'json' }` 导入，esbuild 打包）                              |
| `web/src/core/cards.js`、`web/src/core/combinations.js`、`web/src/ai/candidates.js`、`web/src/ai/encoding.mjs`、`web/src/ai/observation.js`、`web/src/ai/habits.js`、`web/src/ai/hand-value.js`、`web/src/ai/profiles.js`、`web/src/ai/endgame.js`、`web/src/analysis/concepts.mjs` | 牌、牌型、候选顺序、513／54 维编码、可见状态                           | 安全                                                                                    |
| `web/src/coach/oracle.mjs`、`web/src/coach/evaluation.mjs`                                                                                                                                                                                                                          | 经 `ai/shared/search/pimc.mjs` 间接带入                                | 安全                                                                                    |
| `ai/shared/simulation/simulation.mjs`、`ai/shared/search/pimc.mjs`、`ai/shared/search/belief.mjs`                                                                                                                                                                                   | 推演（`advanceRound`、`createRound`）、`searchObservation`、种子随机数 | 安全                                                                                    |
| `ai/danMCai/belief/features.mjs`                                                                                                                                                                                                                                                    | belief-v1 公开特征（`publicView`、`featuresFor`）                      | 安全                                                                                    |
| `ai/danMCai/belief/sampler.mjs`                                                                                                                                                                                                                                                     | 按推断概率精确抽样世界（`sampleBeliefWorlds`）                         | **需要 node-stub**：它导入 `node:fs`、`node:path`，只给本地读文件用，网页从不调用       |
| `ai/danMCai/endgame/solver.mjs`                                                                                                                                                                                                                                                     | 尾盘精确求解器                                                         | 安全                                                                                    |

node-stub（`web/tools/node-stub.mjs`）把 `node:fs`／`node:path` 换成一个调用就抛错（`Node file APIs are unavailable in the browser`）的模块，本仓库正式构建也这样做（`web/tools/build.mjs` 的 `bundles.search`）。本仓库测试 `web/tests/search-bot.test.mjs` 检查打包结果里没有 `node:` 导入、也没有 `onnxruntime-node`。图中只有 `sampler.mjs` 一个文件需要这个映射。

客户端打包（`reason-client.mjs`）导出 `createSearchClient`、`deviceClass`、`searchPayload`、`SEARCH_BOT_V1`、`SEARCH_BUDGETS`、`searchBand`、`hardTimeoutMs`、`candidates`、`mergeSearchValues`、`rankedCoachActions`、`relativeRating`、`actionKey`、`botIdentity`、`botModelName`。它带入 `web/src/ai/search/client.js`（只依赖 `constants.mjs`）、`payload.mjs` 及其依赖（`cards.js`、`known-cards.mjs` → `concepts.mjs` → `candidates.js`、`combinations.js`、`hand-value.js`、`encoding.mjs`），以及评价用的 `web/src/coach/evaluation.mjs`（依赖 `model-catalog.*`、`observation.js`、`habits.js`、`candidates.js`、`encoding.mjs`、`cards.js`、`combinations.js`）。这些都是浏览器安全的，不需要 node-stub。

`candidates` 是 Worker 内部用的同一个候选生成器。2026-11-09 用 20,000 组随机牌比较过：你们的 `analyze` 与本仓库的读法完全相同；在 1,000 手随机手牌上，你们 `NeuralBot` 移植的候选生成器与本仓库的 `candidates` 顺序也完全相同。这只是本文作者的一次本地检查，没有存成证据文件。打包导出 `candidates` 是为了让你们不依赖 `NeuralBot._test`。

## 5. 模型资源与 SHA 校验

| 文件                      | SHA-256                                                            | 字节      | 下载地址                                                                                                      |
| ------------------------- | ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------- |
| `bot-017.onnx`            | `462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7` | 5,368,650 | `https://github.com/stevensun1005/guandanai/releases/download/web-model-017/bot-017.onnx`                     |
| `belief-v1-16d76783.onnx` | `16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9` | 3,931,285 | `https://github.com/stevensun1005/guandanai/releases/download/web-belief-v1-16d76783/belief-v1-16d76783.onnx` |

两个 Release 都已上线：`web-belief-v1-16d76783` 于 2026-11-09 21:09 UTC 发布，只含这一个文件，3,931,285 字节。它由 `ai/publishing/publish-belief-asset.mjs --bot=9001 --file=<belief.onnx> --publish` 创建，工具会核对 SHA 和大小，不覆盖已有 tag。下载后照样要核对 SHA 和字节数；不一致不要部署。

**加载前校验**（两个项目的做法都是在构建时校验，再从同源地址加载）：

- 本仓库：`ai/publishing/artifacts.mjs` 的 `modelBytes`。上面的打包脚本也用它，SHA 不符就抛 `Model SHA-256 mismatch`。
- 你们的网站：Clint `web/build.py` 的 `check_models` 只检查带 `file` 字段的条目，而且只比 SHA。要另加对 `bot/reason/` 下文件的检查，见第 8.1 节的示意。也可以手工核对：`shasum -a 256 bot/reason/models/*.onnx`。
- 不要让 Worker 直接从 GitHub Release 地址加载模型。要从你们自己的同源地址加载，这样构建时校验过的字节就是浏览器实际拿到的字节。Worker 本身不校验 SHA。
- 模型 URL 的 `?v=` 取自打包时 `define` 进去的 `__MODEL_VERSIONS__`（SHA 前 16 位：`bot:017` → `462afc99ee6bcfb7`，`belief:9001` → `16d767830e453618`），模型变了浏览器缓存就会失效。

**托管要求**：ORT 以单线程、无代理方式运行（`search-worker.mjs` 里 `numThreads = 1`、`proxy = false`），不用 `SharedArrayBuffer`，所以不需要 COOP/COEP 头。GitHub Pages 默认没有 CSP；如果你们以后加 CSP，至少要允许同源 module Worker（`worker-src 'self'`）和 WASM 编译（`script-src` 含 `'wasm-unsafe-eval'`）。`.mjs` 要以 JavaScript MIME 提供，`.wasm` 以 `application/wasm` 提供，GitHub Pages 默认就是这样。

## 6. Worker 消息协议（`web/src/ai/search-worker.mjs`）

通常不用直接对 Worker 发消息，用第 7 节的客户端即可。这里列出协议是为了排查问题。Worker 内部有队列，一次只处理一个任务。

| 发送                                      | 回复                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `{id, type: 'init', bot: '9001', budget}` | `{id, result: {ready: true}}`；失败时 `{id, error}`                                                                                             |
| `{id, type: 'search', payload}`           | `{id, result}`，见 6.2；还没 init 时 `{id, error: 'Search worker not ready'}`                                                                   |
| `{id, type: 'coach', payload}`            | `{id, result}`，见 6.3；还没 init 时同上                                                                                                        |
| `{type: 'cancel', id}`                    | 无回复；只会停掉**正在运行**的 coach 任务（在两次推理或两个尾盘世界之间检查，约 50 毫秒内）。排队中的任务由客户端丢弃。牌桌搜索不让步、不可取消 |

`init` 会加载两个网络，在固定开局（`createRound(1)`）上预热一次，并建好求解器（节点上限 1,500,000，时限和置换表大小取自 `budget`）。

### 6.1 请求载荷（`searchPayload(game, p, offset, seed)`，`web/src/ai/search/payload.mjs`）

载荷**只含**本座位的手牌和公开信息，没有其他三家的手牌：

| 字段                    | 内容                                                                                                                                                                         | 在你们 `G` 里的对应                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `p`                     | 当前出牌座位（必须等于 `game.turn`，否则抛 `Search payload is only built for the seat to move`）                                                                             | `G.turn`                                       |
| `offset`                | 视角偏移，用于从 `levels` 取本方和对方级数                                                                                                                                   | 牌桌：`NET.off`（房主和单人恒为 0）；评价：`0` |
| `seed`                  | 每局一个随机 uint32，取 `>>>0`；不能从牌面推出                                                                                                                               | 自己生成，见 8.2、9.2                          |
| `L`、`levels`           | 本局级牌，两队级数                                                                                                                                                           | `G.L`、`G.levels`                              |
| `turn`、`passes`、`out` | 轮到谁、本轮已过牌数、已出完的座位顺序                                                                                                                                       | `G.turn`、`G.passes`、`G.out`                  |
| `hand`                  | 本座位手牌的物理牌号（0–107，`makeDeck()` 顺序）                                                                                                                             | `G.hands[p]` 的 `id`                           |
| `counts`                | 四家剩余张数（只取长度）                                                                                                                                                     | `G.hands[i].length`                            |
| `log`                   | 公开记录：出牌是 `{p, cards: [id…], type, value, n, lead}`，过牌是 `{p, cards: null}`                                                                                        | `G.log`（字段名相同）                          |
| `trick`                 | 当前牌权 `{player, type, value, n, wu, cards: [id…]}` 或 `null`。`wu` 是这手牌里用作百搭的逢人配张数，取 `play.wu \|\| 0`；Worker 把它还原到 `trick.play.wu`，搜索选择不读它 | `G.trick`（`{player, play}`）                  |
| `exchanges`             | `{trib: [{g, r, tc, rc}], kang: {has: [{g, n}]} \| null}`，`tc`／`rc` 是牌号，`rc` 可为 `null`                                                                               | `G.trib`（`tc`／`rc` 为牌对象）、`G.kang`      |

在 Clint `2d91ecc` 上核对过以下几点，所以可以直接调用 `searchPayload(G, p, off, seed)`，不用做转换：

- 你们的 `makeDeck()` 与本仓库相同：同样的花色顺序 `['S','H','C','D']`、同样的牌号。
- `G.log` 的条目带 `lead/type/value/n`（Clint `web/src/game/play.js`）。
- `G.trib` 是 `{g, r, tc, rc}`（Clint `web/src/game/tribute.js`）。
- `G.kang.has` 是 `{g, n}`。
- `G.trib`、`G.kang`、`G.log`、`G.out` 每局开始时清空，`G.tok` 每局加 1（Clint `web/src/game/round.js` 的 `startRound`）。

**不要**用 `botStart` 里给 `NeuralBot` 做的精简副本 `g`：它没有 `out`、`turn`、`trib`、`kang`。

Worker 的 `restoreGame` 会重建对局，其他三家的手牌换成**读取就报错**的占位（`Hidden card read during search`）。遇到以下情况抛 `Invalid search payload`：`p` 越界或不是整数、`turn ≠ p`、`counts` 不是 4 项、`hand.length ≠ counts[p]`、牌号重复或不存在。

进贡、还贡、抗贡是公开信息，按**牌面**换算成约束（`web/src/ai/search/known-cards.mjs`）：

- 收贡方确定持有一张贡牌的牌面，收还牌方同理。
- 抗贡记录说明该家有 `n` 张大王。
- 某家打出同牌面的牌后，减掉对应的约束。

约束互相矛盾时，Worker 回 `known-cards` 回落。

### 6.2 `search` 的结果

成功时：

```js
{ ok: true, kind: 'midgame' | 'endgame', index, championIndex, candidates,
  ids: [牌号…],                      // 过牌为 []
  shape: {type, value, n} | null,    // 过牌为 null
  minWorldsFallback,                 // 尾盘解完的世界少于 4 个，按规则出 017 原始首选
  worldsUsed, inferences, ms }
```

Worker 自己报告的回落：`{fallback: true, reason: 'out-of-band' | 'known-cards' | 'budget', kind?, ms?, inferences?}`。

注意：`index` 和 `championIndex` 是**本仓库** `candidates()` 生成顺序里的序号。本仓库的 `searchedPlay`（`web/src/ai/controller.js`）用 `index` 去取本地候选，再核对牌号和牌型，因为本仓库的本地候选就是同一个生成器的输出。你们**不要**照搬这种做法：要按 `ids`＋`shape` 在 `G.hands[p]` 里重建出牌（第 8.3 节），不要用 `index` 去索引自己的候选列表。

### 6.3 `coach` 的结果（出牌评价）

成功时：

```js
{ ok: true, kind: 'midgame' | 'endgame',
  plays: [[牌号…]…],         // Worker 的候选顺序；[] 表示过牌
  base: [017 估值…],          // 与 plays 一一对应
  values: [数 | null…],       // 中盘：只有搜索根有值，其余为 null；尾盘：全部候选
  worlds,                     // 抽到的世界数（8）
  used,                       // 中盘：等于 worlds（8）；尾盘：解完的世界数（4–8）
  evaluated, ms }
```

回落：`{fallback: true, reason: 'out-of-band' | 'known-cards' | 'budget' | 'cancelled' | 'min-worlds', kind?}`。尾盘解完的世界少于 4 个时回 `min-worlds`。

## 7. 主线程客户端（`createSearchClient`，`web/src/ai/search/client.js`）

```js
// 经典脚本里也能用。VERSION 是你们 web/build.py 写进页面的构建戳（const VERSION），
// 基准地址与你们 NeuralBot 加载 bot/… 的方式一致（location.href）。
let RS = null;
const reasonClient = () =>
  (RS ||= import(
    new URL('bot/reason/assets/reason-client.mjs?v=' + VERSION, location.href).href
  ).then(
    (m) => ({
      m,
      client: m.createSearchClient({
        spawn: () =>
          new Worker(new URL('bot/reason/assets/search-worker.mjs?v=' + VERSION, location.href), {
            type: 'module',
          }),
      }),
    }),
    (e) => {
      RS = null; // 下次再试
      throw e;
    },
  ));
```

- 页面若不在站点根目录（例如以后放进子路径且 URL 不以 `/` 结尾），`location.href` 会解析错。那时改用 `document.baseURI` 或绝对路径，并与 `NeuralBot` 的写法一起改。
- **整个页面只建一个客户端**，牌桌和出牌评价共用。一个 Worker 的堆内存峰值约 210–220 MB（`web-search-bot-latency.json` 和 `web-search-bot-9001.json` 测得 219 MB 和 214 MB），不要建两个。
- 传了 `spawn` 就不会用默认路径（`./assets/search-worker.mjs`）；不传 `device` 时用 `deviceClass()` 自动判断。
- `client.warm('9001')`：提前加载网络。本仓库在有电脑座位选 9001 时调用；出牌评价在桌上剩 ≤60 张时也会预热。
- `client.decide('9001', payload)`：牌桌决策，**不会抛错**。结果要么是 6.2 的 `ok` 对象，要么是 `{fallback: true, reason, …}`。
- `client.evaluate('9001', payload)`：出牌评价，同样不会抛错。新请求会顶掉排队中的旧评价请求，并请仍在运行的上一个评价任务停下（发 `cancel`，不换 Worker），新一手优先。
- `client.cancelCoach()`：关闭评价时调用，不影响牌桌任务。
- `client.stats`：只在内存里的统计（`device`、`budget`、`firstLoadWaitMs`、`requests`、`searched`、`differs`、`fallbacks`、`ms`，以及 `coach.*`），用于自检。

**设备和预算**（`SEARCH_BUDGETS`，`web/src/ai/search/constants.mjs`）：

| 设备类别                                                                                                                                                    | 中盘预算  | 尾盘预算  | 单次求解时限 | 置换表  | 硬超时（`hardTimeoutMs`） |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | ------------ | ------- | ------------------------- |
| `desktop`                                                                                                                                                   | 50,000 ms | 50,000 ms | 3,000 ms     | 300,000 | 56,000 ms                 |
| `mobile`：`userAgentData.mobile`；UA 含 `Mobi\|iPhone\|iPad\|iPod\|Android`；iPadOS（`MacIntel` 且多点触控）；`hardwareConcurrency ≤ 4`；`deviceMemory ≤ 4` | 50,000 ms | 50,000 ms | 3,000 ms     | 100,000 | 56,000 ms                 |

2026-11-09 所有者要求“把模型的单次出牌时间延长至50s”（真人每手 60 秒）：此前电脑为 3,000／4,000／3,000 ms（硬超时 10,000 ms），手机为 3,500／3,500／1,000 ms（硬超时 7,500 ms）。预算只是上限，搜索算完就返回，多数决策仍不到 1 秒。

各项规则（`client.js`、`core.mjs`）：

- 超过预算就**整次作废**，不会用到半截的搜索结果。
- 两档的单次求解时限都等于 Node 测试版本的 3 秒，被时钟停下或达到 1,500,000 节点上限的求解都跳过这个世界，与 Node 规则相同。（若单次时限短于 Node，被时钟停下的求解会让整次作废；这条规则仍在代码里，只对更短的预算起作用。）
- 第一次决策最多等 `FIRST_LOAD_WAIT_MS`（10 秒，与 50 秒预算脱钩；`client.stats.firstLoadWaitMs`）让网络加载完，超时就本次回落（`loading`），加载在后台继续。
- `init` 本身的超时是 60 秒；失败后 30 秒内不再重试（`search-init-wait`）。

**调度**：

- 客户端一次只向 Worker 发一个任务，牌桌任务优先。
- 牌桌请求到来时，丢掉排队中的评价任务；如果有评价任务在跑，先发 `cancel`，500 毫秒内还没停下，就替换 Worker 并重新加载网络（通常 0.3–0.6 秒）。
- 牌桌任务的预算和硬超时从它**发给 Worker 时**才开始计时，评价任务不会占用牌桌的时间。

**`decide` 最长要等多久**：通常不超过“首次加载等待＋硬超时”（10＋56＝66 秒，两档相同）；实际多数决策不到 1 秒。但有一种少见情况会更长：评价任务 500 毫秒内停不下来，Worker 被替换。这时牌桌任务排在新的 `init` 后面，`init` 最多可等 60 秒，牌桌任务的硬超时要等它发出后才开始。所以理论上最长约 0.5＋60＋56 秒。牌桌一侧要自己设上限（第 8.3 节），不能指望 `decide` 一定在 30 秒内返回。

客户端返回的回落原因包括：`timeout`、`loading`、`preempted`、`error`，以及 Worker 返回的 `budget`、`out-of-band`、`known-cards`、`min-worlds`、`cancelled`。本仓库还会在牌桌一侧记录 `mismatch`，指搜索结果与本桌的牌对不上。

## 8. 牌桌接入（替换普通 danMCai）

### 8.1 菜单条目、模型检查与选择映射

你们的菜单按钮写在 Clint `web/src/index.html` 里（`data-rule="bot"`），`bot/models.json` 给出名称和权重，`NeuralBot` 只认带 `file` 的条目（`NeuralBot.has`）。建议：

1. `bot/models.json` 保留 `danmcai` 条目原样（带 `file`）。它是 017，搜索回落、出牌评价和 `NeuralBot.decide('danmcai', …)` 都要用它，只是不再出现在菜单里。
2. 新增 reason 条目，**不带 `file`**。否则 `check_models` 会把身份摘要当文件 SHA 去核对而失败，`NeuralBot` 也会试图把它当 ONNX 加载。

   ```json
   {
     "id": "danmcai-reason",
     "name": "danMCai-reason",
     "label": "danMCai-reason-v000855042",
     "kind": "search",
     "base": "danmcai",
     "dir": "reason/",
     "identity": {
       "id": "9001",
       "sha256": "442d888ada3b59c56cb1e809bb24a97268f00c3daaa6345c6b53f2f84aca6a24",
       "version": "v000855042-bsearch1-16d76783"
     },
     "source": {
       "repo": "stevensun1005/guandanai",
       "commit": "<打包时的完整提交 SHA>",
       "searchBot": "9001",
       "status": "research-bot-not-champion-deployment-not-acceptance"
     }
   }
   ```

3. 菜单里 `data-val="danmcai"` 的按钮改成 `data-val="danmcai-reason"`。
4. Clint `web/src/lobby/rules.js` 的 `loadRules`：旧的保存值 `danmcai` 映射成 `danmcai-reason`。合法性检查也要接受 `danmcai-reason`，因为 `NeuralBot.has('danmcai-reason')` 为假。
5. `web/build.py`：在 `check_models` 之外，按你们记录的 SHA 清单检查 `bot/reason/` 下的 7 个文件，包括字节数。例如：

   ```python
   REASON = {  # 第 4.1 节的表；打包文件的 SHA 换成你们实际打包的输出
       "reason/models/bot-017.onnx": ("462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7", 5368650),
       "reason/models/belief-v1-16d76783.onnx": ("16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9", 3931285),
       # "reason/assets/search-worker.mjs": (...), "reason/assets/reason-client.mjs": (...), 三个 vendor 文件 ...
   }
   for rel, (sha, size) in REASON.items():
       data = (root / "bot" / rel).read_bytes()
       if hashlib.sha256(data).hexdigest() != sha or len(data) != size:
           sys.exit(f"bot/{rel}: SHA-256 or size does not match")
   ```

### 8.2 只在负责计算的设备上算，什么时候搜索

在本仓库，电脑座位只由单人页面或房主页面计算（`turns.js` 里 `if (isHost()) TableBot?.prefetch(p)`）；加入者只显示房主发来的结果，不创建搜索 Worker 来跑电脑。你们的 `botStart` 已经只在 `isHost()&&!TEST` 时调用（Clint `web/src/game/turns.js`），保持这一点即可。注意：你们的 `?test=1` 不调用 `botStart`，电脑一律按 Clint 规则出牌，所以 reason 只能在普通模式下自检。

参照本仓库 `web/src/ai/controller.js` 的 `searchRequest`。同时满足以下条件才发搜索请求，否则直接走 017：

1. 当前桌选的是 `danmcai-reason`（你们的 `RULES.bot`），而且该座位是电脑座位。
2. 不是明牌座位（你们的 `aiSeesAll(p)`；本仓库对应的是 `privateSeat`）。这类座位保持你们现有的规则／残局大脑分支，`botStart` 开头已经这样处理。
3. `G.turn === p`，并且桌上四家剩余总张数满足 `searchBand(总数) !== null`，也就是 1–40 张。
4. 用打包导出的 `candidates(G.hands[p], G.L, G.trick && G.trick.play)` 生成候选：候选多于一个，而且没有任何一手能把 `G.hands[p]` 一次出完。

**种子**：每局生成一次 `crypto.getRandomValues(new Uint32Array(1))[0]`，这一局里该页面的所有牌桌决策共用。本仓库用 `WeakMap` 以每局的游戏对象为键保存。你们的 `G` 是整场共用一个对象（Clint `web/src/game/match.js` 新建，`round.js` 按局清空字段），所以改用 `G.tok + ':' + G.round` 作键。

### 8.3 发请求、采用结果、回落

**回落顺序**：搜索 → 017（`NeuralBot.decide('danmcai', g, p, NET.off)`）→ Clint 规则。

- 搜索的任何问题（不是 `ok`、对不上、出错、超过上限）都回落到 017，**不调用** `botFail`。
- 只有 017 也失败时，才走你们现有的 `nn.err → botFail(nn.id) → rulesMove(p)`。`botFail` 会让本页面之后都改用 Clint 规则。

`NeuralBot.decide('danmcai')` 是本仓库 017 牌桌路径（`table-policy.mjs`、`policy-inference.mjs`、`endgame.js`）的移植，包括公开残局求解（Clint `bot/neural/neural-bot.js` 的 `decide`、`solvePublicEndgame`）。

**等待上限**：搜索要自己设上限：`client.stats.firstLoadWaitMs + hardTimeoutMs(client.stats.budget) + 1000`（两档都是 10＋56＋1＝67 秒），超过上限就按回落处理。你们的 `BOT_WAIT_MS = 30000`，超过后 `aiMove` 记 `nn.err`，然后调用 `botFail`，它**短于**这个上限。所以采用 50 秒预算时必须把 `BOT_WAIT_MS` 提高到能容下“搜索上限＋017 的计算”（例如 75 秒），并核对你们给电脑座位的出牌计时、超时托管和联机掉线判定不会在这段时间内先触发；只有房主（负责计算的页面）在等，Worker 不占主线程，心跳照常。若要保留 30 秒的 `BOT_WAIT_MS`，就得把搜索上限设在 30 秒以内（例如 25 秒），超过即出 017 的牌：这样少数长搜索会多回落，不再是所有者要求的 50 秒，须向你们的所有者说明。

**重建出牌**：

1. 按 `ids` 在 `G.hands[p]` 里找到每张牌。
2. 用你们的 `analyze(cards, G.L)` 找出 `type`、`value`、`n` 都与 `shape` 相同、并且 `beats(读法, G.trick && G.trick.play)` 成立的读法。
3. 过牌：`ids` 为空、`shape === null`，并且当前有牌权（`G.trick`）。
4. 任何一步对不上，都按回落处理。

**过期结果**：搜索返回前桌面变了（`G.tok`、`G.log.length`、`G.turn` 任一不同），就丢弃结果。你们的 `aiMove` 已经用 `nn.key`（`G.tok:G.log.length:p`）丢弃过期结果，而且会对照 `G.hands[p]` 再查一次牌，这一层保留即可。

**真人超时托管**：不发起搜索，保持你们现有的 `timeoutPlay` 不变。本仓库对选了 9001 的真人座位超时托管直接出 017（`decide(p, {timeout: true})`）；你们的托管用 `timeoutPlay`（Clint `web/src/game/ticker.js`）的固定规则，本来就不用网络。

**示意代码**（Clint `web/src/game/computer-players.js`；`analyze`、`beats`、`isWild`、`aiSeesAll`、`NET`、`G` 都是你们页面已有的全局）：

```js
const REASON_ID = 'danmcai-reason',
  REASON_BASE = 'danmcai',
  REASON_BOT = '9001';
const REASON_SEEDS = new Map(); // G.tok+':'+G.round -> uint32
// botId：reason 只要求底座 017 可用
const botId = () =>
  RULES.bot === REASON_ID
    ? NeuralBot.has(REASON_BASE)
      ? REASON_ID
      : ''
    : RULES.bot && RULES.bot !== 'clint' && NeuralBot.has(RULES.bot)
      ? RULES.bot
      : '';
// botPreload：reason 时预载 017，并 reasonClient().then(({client}) => client.warm(REASON_BOT))
// botStart：把 NeuralBot.decide(id, g, p, NET.off) 换成
//   (id === REASON_ID ? reasonDecide(p, g) : NeuralBot.decide(id, g, p, NET.off))
// nn.id 仍是 REASON_ID，所以 aiMove 里 BOT_USED[p] 会记成 REASON_ID（含 017 回落的出牌）。

async function reasonDecide(p, g) {
  let pl;
  try {
    pl = await reasonSearch(p);
  } catch (e) {
    pl = undefined; // 搜索的任何异常都回落 017，不调用 botFail
  }
  return pl !== undefined ? pl : NeuralBot.decide(REASON_BASE, g, p, NET.off);
}

// 返回出牌对象、null（过牌）或 undefined（不搜索／回落）
async function reasonSearch(p) {
  const at = G.tok + ':' + G.log.length + ':' + G.turn;
  const now = () => G.tok + ':' + G.log.length + ':' + G.turn;
  if (aiSeesAll(p) || G.turn !== p || G.phase !== 'play') return undefined;
  const { m, client } = await reasonClient();
  if (now() !== at) return undefined;
  const left = G.hands.reduce((s, h) => s + h.length, 0);
  if (!m.searchBand(left)) return undefined;
  const cur = G.trick && G.trick.play;
  const plays = m.candidates(G.hands[p], G.L, cur);
  if (plays.length <= 1 || plays.some((x) => x && x.cards.length === G.hands[p].length))
    return undefined;
  const key = G.tok + ':' + G.round;
  if (!REASON_SEEDS.has(key)) {
    REASON_SEEDS.clear();
    REASON_SEEDS.set(key, crypto.getRandomValues(new Uint32Array(1))[0]);
  }
  const payload = m.searchPayload(G, p, NET.off, REASON_SEEDS.get(key));
  const b = client.stats.budget;
  let timer;
  const r = await Promise.race([
    client.decide(REASON_BOT, payload),
    new Promise((res) => {
      timer = setTimeout(
        () => res({ fallback: true, reason: 'caller-timeout' }),
        client.stats.firstLoadWaitMs + m.hardTimeoutMs(b) + 1000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (!r || !r.ok || now() !== at) return undefined;
  const trick = G.trick && G.trick.play;
  if (!r.ids.length) return !r.shape && trick ? null : undefined;
  const cards = r.ids.map((id) => G.hands[p].find((c) => c.id === id));
  if (cards.some((c) => !c) || !r.shape) return undefined;
  const s = analyze(cards, G.L).find(
    (x) =>
      x.type === r.shape.type && x.value === r.shape.value && x.n === r.shape.n && beats(x, trick),
  );
  return s ? { ...s, cards, wu: cards.filter((c) => isWild(c, G.L)).length } : undefined;
}
```

写本文时，作者在本地检查过上面“重建出牌”的写法：在 60 局模拟对局里，把每个决策点的每个合法候选（共 98,263 个，含 6,051 个过牌）都当成搜索结果，用你们 `2d91ecc` 的 `analyze`、`beats` 重建，全部成功。这项检查没有存成证据文件，也没有运行你们的页面。

也可以在发搜索请求时同时开始 017 决策，搜索失败时直接用它的结果。这只是把回落的计算提前，回落规则本身不变。

### 8.4 进还贡

本仓库里，进贡和还贡都由 017 决定，不搜索；你们现在用 Clint 规则做进还贡。替换机器人**不要求**改动进还贡，保持原样即可。搜索只读取已经公开的进贡／还贡／抗贡记录。

## 9. 出牌评价接入

参照本仓库 `web/src/coach/controller.js`（`reasoningPayload`、`startSnapshot`、`applyValues`、`rerank`、`grade`、`renderTop5`）、`web/src/coach/evaluation.mjs`、`web/src/ai/search/coach.mjs`，使用说明见 `web/docs/MOVE_COACH.md`。你们的对应代码在 Clint `web/src/coach/coach.js`。

### 9.1 在哪里算、按张数用哪种值

- **在哪里算**：在每个玩家自己的设备上（单人、房主、加入者都一样），只在 `G.turn === 0` 时算，载荷用 `searchPayload(G, 0, 0, seed)`。
  - 你们的加入者页面通过 `round` 事件拿到整副牌（Clint `web/src/game/round.js` 的 `startRound` 用 `e.deck`），之后照同样的事件出牌。所以加入者本地的 `G.hands[i].length` 和 `G.log` 里的牌对象（带 `id`）都是对的。载荷只取其他座位的张数，不取它们的牌。
  - 偏移为 0：你们的 `G.levels` 按本地座位所在队编号（Clint `web/src/game/match.js` 的 `tOf` 用 `toLocal`）。你们的 `NeuralBot.rate` 也用 `observe(g,0,plays,0)`。
  - 房主页面上，评价和电脑共用同一个客户端，电脑优先。
- **按剩余张数决定用哪种值**：
  - 21–40 张：值来自中盘搜索，只有搜索根（017 前 6 加过牌）有值，其他候选为 `null`。
  - ≤20 张：值是推断世界精确求解的平均值，覆盖全部候选。解完不足 4 个世界时回 `min-worlds`。
  - 41 张以上，或者搜索回落、超时、被取消：显示 017 的值（你们现有的 `NeuralBot.rate('danmcai', …)`）。
- **先后顺序**：
  1. 先算 017 的值（很快），但这时**还不显示数字**。
  2. 只有本回合仍未结束（`coachKey()` 没变、`G.turn === 0`）且候选多于一个时，才发 `client.evaluate`。等待期间显示 `推理搜索中…`。
  3. 搜索返回或回落后，再显示搜索值或 017 的值。
  4. 不在搜索段（或候选只有一个）时，017 的值直接显示。
  5. 本仓库就是这样做的：`grade` 在 `s.values` 设好之前只返回 `推理搜索中…`／`评价中…`。

### 9.2 种子与预热

- 评价的种子也是每局每台设备一个随机 uint32，规则同第 8.2 节。本仓库在评价模块里单独保存一份（`web/src/coach/controller.js` 的 `searchSeeds`），不与牌桌共用。你们也单独用一个 `Map`，以 `G.tok + ':' + G.round` 为键。
- 桌上剩 ≤60 张时（`SEARCH_BOT_V1.hi + 20`）调用 `client.warm('9001')`，避免第一次评价时等加载。

### 9.3 合并、排序、评分

- `s.actions` 就是 `NeuralBot.rate` 返回的 `actions`：每项是一个牌号数组（过牌为 `[]`），与 `values` 一一对应（Clint `bot/neural/neural-bot.js` 的 `rate` 返回 `{actions: state.actions, values}`）。把这份 017 估值存为 `s.base`。
- **合并**：`shown = mergeSearchValues(s.actions, result)`。它按 `actionKey`（54 维牌面计数，同牌面的两张物理牌视为相同）把搜索值对到你们的候选上，对不上的为 `null`。结果不是 `ok`、或者一个值也对不上时，返回 `null`，这时改用 017 的值。
- **用于评分的值**：`s.values = shown.filter(v => v !== null)`。`relativeRating(s.values, 某手的值)` 只在有值的候选之间换算，是相对分，不是胜率。
- **排序**：`rankedCoachActions(s.actions, shown, G.L, 5, G.trick ? G.trick.play : null, source === 'champion' ? undefined : s.base)`。
  - 第 5 个参数是**当前牌权的那手牌**（`G.trick.play`，带 `type/value/n`），不是 `G.trick` 本身；本仓库传的是 `observation.trick?.play`。
  - 第 6 个参数只在显示搜索值时传 `s.base`。显示 017 的值时必须是 `undefined`：这时 `shown` 里不能有 `null`，否则函数抛 `Invalid ranked actions`。
  - 每种出法（点数加牌型，百搭单独算）只留一行。有搜索值的行排在前面，按值从高到低，同值按 017 估值；没进搜索的候选排在所有有值的行之后，彼此按 017 估值排序，不显示分数。
- **玩家选了不在候选列表里的合法出法**：照你们现有的做法单独补算 017 的值（`NeuralBot.rate('danmcai', s.g, ids)`），把它追加到 `s.actions` 和 `s.base`。显示的值这样追加：显示 017 值的回合追加这个值，同时更新 `s.values`；显示搜索值的回合追加 `null`，这一手显示 `未进入推理搜索，不评分`（本仓库 `grade`）。然后重新排序。

### 9.4 状态文字（照搬本仓库 `grade`、`renderTop5`）

| 时机                 | 文字                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| 搜索进行中           | `推理搜索中…`                                                                 |
| 中盘搜索值           | `推理搜索 · {used} 个推断世界打完本局 · 评估 {有值数}/{候选数} 种`            |
| 尾盘搜索值           | `残局推理 · {used} 个推断世界精确求解 · {候选数} 种出法`                      |
| 搜索段里没拿到搜索值 | `推理未完成，用冠军估值 · 已比较 {候选数} 个候选 · 点击选牌，不会自动打出`    |
| 不在搜索段           | `已比较 {候选数} 个候选 · 点击选牌，不会自动打出`（你们现有的文字也可以保留） |
| Top 5 里没进搜索的行 | `未进入推理搜索`（不显示数字）                                                |
| 选中没进搜索的出法   | `未进入推理搜索，不评分`                                                      |
| 有搜索值的评分       | `合理性 N%`，后加 ` · 推理`；分差可忽略时与现在一样加 ` · 候选无明显分差`     |
| 评价名称             | `danMCai-reason-v000855042 · 相对分，非胜率`（本仓库 `COACH_NAME`）           |

占位符的含义：

- `{used}`：评价结果的 `used`。中盘恒为 8（世界数），尾盘是解完的世界数（4–8）。
- `{有值数}`：合并时 `shown` 里非 `null` 的个数。之后补算的出法不改变它。
- `{候选数}`：评价自己的候选列表长度（`s.actions.length`）。补算出法后会变大。**不是** Worker 的 `plays.length`。

### 9.5 `assisted` 规则与关闭评价

- 只有在本回合出牌**之前**，界面上**真的显示过百分比数字**（选牌预览里的 `合理性 N%`，或 Top 5 里的数字），这一手才记 `assisted=true`。
- 以下情况都不算：只打开了评价、`推理搜索中…`、`评价中…`、`未进入推理搜索`、`未进入推理搜索，不评分`、出牌后才评分。
- 超时托管和自动出牌永远不记。收集器也只接受真人动作带 `assisted`。
- 你们的 `coachGrade` 只在返回 `合理性 N%` 的分支设置 `CO.shown`，这个做法可以保留；新增的 `null` 分支不要设置它。你们的 `renderTop5` 在列表渲染后设置 `CO.shown`；接入后列表第一行总有数字，这个做法仍然成立。
- 本仓库的 `markDisplayedRatings` 还会检查数字是否确实在可见区域内；你们的 Top 5 只对 `TOP5_NAMES` 的昵称显示，不要顺带改这份名单。
- 评价被关闭或隐藏（`coachShown()` 变为假，包括 `CO.hidden`）时调用 `client.cancelCoach()`。

## 10. 牌谱收集身份

你们的网站把牌谱直接发到本项目的同一个收集器（Clint `web/src/collection/upload.js` 的 `COLLECT_URL`，与本仓库 `web/src/collection/config.json` 的 `endpoint` 相同）。校验在服务器端，用的是本仓库的 `web/src/collection/validate.mjs`，你们不保存它的副本。它现有的规则已经接受这个身份：数字编号 `^\d{3,}$`，64 位十六进制 `sha256`，`version` 符合 `^[\w.-]{1,80}$`。本仓库测试 `collection records accept the research bot identity without a collector change` 已覆盖。所以收集器和验证器都**不用改**。

```json
{
  "id": "9001",
  "sha256": "442d888ada3b59c56cb1e809bb24a97268f00c3daaa6345c6b53f2f84aca6a24",
  "version": "v000855042-bsearch1-16d76783"
}
```

- `sha256` **不是**任何 ONNX 文件的 SHA，而是搜索清单摘要（`searchBotManifest`，`web/src/ai/model-catalog.mjs`）。这样，搜索做出的决策不会被当成 017 本身的决策。要复算，对下面这一行（`JSON.stringify` 的输出，键顺序不能变）求 SHA-256：

  ```
  {"schema":"danMCai-search-bot-v1","id":"9001","kind":"belief-search","base":{"id":"017","sha256":"462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7","version":"v000855042"},"belief":{"sha256":"16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9","featureVersion":"belief-v1"},"search":{"lo":21,"hi":40,"worlds":8,"k":6,"net":2,"endgameHi":20,"endgameWorlds":8,"minWorlds":4,"tieTolerance":1e-9,"solverMaxNodes":1500000,"worldSeed":"(seed*1009 + ply*7919)>>>0"},"core":"search-v1"}
  ```

  `printf '%s' '<上一行>' | shasum -a 256` 应得到 `442d888a…6a24`。也可以直接用客户端打包导出的 `botIdentity('9001')`。

**哪些地方写哪个身份**：

| 记录位置                                                        | 写什么                                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seats[].bot`                                                   | 本桌选了 `danmcai-reason` 时写 9001 身份；但 `aiSeesAll` 座位写它实际使用的 `recModel('clint')`                                                                                          |
| 电脑出牌 `actions[].model`（`BOT_USED[p]` 为 `danmcai-reason`） | 9001 身份，**包括搜索失败后回落到 017 的出牌**。回落属于这个策略的定义，本仓库也这样记录（主报告 72 节）                                                                                 |
| 电脑出牌（`BOT_USED[p]` 为 `clint`）                            | 照旧 `clint-rule`：017 也失败后的 Clint 规则出牌、`aiMove` 对不上时的 `rulesMove`、`aiSeesAll` 座位的出牌                                                                                |
| 真人超时托管（`actor: 'timeout'`）                              | 照旧 `REC_TIMEOUT`（`clint-rule`，版本 `clintsun1977-timeout`）。你们的托管用 `timeoutPlay` 的固定规则，不搜索。本仓库托管出 017，所以写座位所选身份；两边做法不同，各按实际出牌的策略写 |
| 真人出牌                                                        | `model: null`                                                                                                                                                                            |

**示意代码**（Clint `web/src/collection/record.js`）：

```js
function recModel(id) {
  const m = NeuralBot.models.find((x) => x.id === id);
  if (m && m.identity) return { ...m.identity }; // danmcai-reason → 9001
  if (m && m.file) return { id: m.guandanaiId, sha256: m.sha256, version: m.source.version };
  return { id: 'clint-rule', sha256: null, version: 'clintsun1977-' + VERSION };
}
// recStart：seats 的 bot 按座位给
//   bot: aiSeesAll(p) ? recModel('clint') : recModel(RULES.bot)
```

**`aiSeesAll` 座位**：它看得到全部手牌，现在被记成 `clint-rule`，与不看牌的 Clint 规则混在同一个身份下。本仓库对类似的明牌对局整局不收集（`web/docs/PRIVATE_TABLE.md`）。有这种座位的局是否还收集，由你们的所有者决定，不属于本次替换，但不要把它们记成 9001。

记录仍须通过共享验证器，自检方法见第 14 节第 6 条。你们只收集两名及以上真人的局（`recEligible`），`?test=1` 的局不收集。

## 11. 菜单命名

- 完整名称固定为 **`danMCai-reason-v000855042`**，格式是 `danMCai-reason-v<底座冠军版本>`（`botModelName`）。凡是显示完整名称的地方（`bot/models.json` 的 `label`、`botFail` 的提示、评价名称 `#coachName`）都用它。按钮上的短名可以用缩写，但要能与普通 danMCai 区分，例如 `danMCai-reason`。2026-11-09 之前它在本仓库叫 `danMCai-v000855042+推理搜索`，改名后收集身份不变。
- 所有者要求用它**替换**你们菜单里的普通 danMCai（`danMCai-v000855042`）。017 在内部仍然负责回落和评价回落，但不再作为菜单里的一项。
- 已经保存的旧选择 `danmcai` 应该映射到新条目（第 8.1 节）。
- 菜单和说明里不要叫它“冠军”或“新模型”，也不要写 +0.237；可以写成“带推理搜索的 danMCai（底座：冠军 017）”。

## 12. 不要改的东西

- **Clint 规则机器人路径保持独立**：
  - `bot/clint/clint-bot.js`、`endgame-brain.js`、提示和残局大脑都不要接进推理搜索或它的 017 回落。
  - 推理搜索选出的牌不要再经过 `endgameBrain` 替换。
  - 不要往神经网络这条路径里加 Clint 的启发式规则。
  - 反过来，也不要用推理搜索替换 Clint 规则的出牌。
- 不要改打包后的 Worker、`SEARCH_BOT_V1`、预算语义（超时整次作废）、模型文件或推断网络。
- 不要把其他座位的手牌放进载荷。不要在明牌座位上用推理搜索。
- 不要改共享收集器和验证器。只有 Clint 规则做出的出牌才能写 `clint-rule` 身份；其他出牌不要写成 `clint-rule`，也不要把 9001 写成 017。
- 不要顺带改进还贡、Top 5 名单或房主评价许可。
- 不要用 017 的普通最新导出或步数更大的模型替换底座。底座换了，就是另一个机器人，需要新编号和新证据。

## 13. 分步接入计划

1. 在本仓库包含本文的 `main` 提交上运行 `npm ci`、`node --test web/tests/search-bot.test.mjs`（第 14 节第 1 条），记下完整提交 SHA，并按本文开头确认网页代码与 `296c27e` 相同。
2. 按第 4.1 节取出打包脚本，核对脚本 SHA，然后运行。把输出放到你们仓库的 `bot/reason/`，把输出的 SHA 清单写进你们的说明文档。
3. 在 `web/build.py` 里加上 `bot/reason/` 下文件的 SHA 和字节检查（第 8.1 节）。
4. 在 `bot/models.json` 里新增 reason 条目，不带 `file`。菜单按钮改成新条目，旧选择做映射（第 8.1 节）。
5. 用动态 `import()` 加载 `reason-client.mjs`，整个页面建一个客户端（第 7 节）。
6. 修改 `botId`、`botPreload`、`botStart`：选了 reason 时调用 `reasonDecide`（第 8.3 节）。
7. 修改 `recModel` 和 `recStart`（第 10 节）。
8. 出牌评价按第 9 节接入，关闭评价时调用 `client.cancelCoach()`。
9. 完成第 14 节全部自检，记录结果（日期、两边提交、种子、决策数、回落数、耗时），然后再发布。

## 14. 自检清单

第 1–4、6 条在**本仓库检出**的根目录运行，需要 Node ≥ 20.19 和 `npm ci`。

1. **单元一致性**（不需要模型文件）：`node --test web/tests/search-bot.test.mjs`。在 `296c27e` 上运行，15 项全部通过（`fc2ed46` 上为 13 项；新增两项检查首次加载只等 10 秒、新一手评价请停上一手）。它用确定性的替身网络，在固定种子的中盘和尾盘局面上，要求浏览器核心与 `midgame-search.mjs` 在选择、搜索根、各世界结果和抽到的世界上完全相同；同时检查载荷只含公开信息、超预算整次作废、公开贡牌约束、身份能通过 `validateRecord`、打包后没有 `node:` 导入。
2. **打包和 SHA**：运行第 4.1 节的脚本，核对 ORT 和模型的 SHA 与表中一致；`grep -c 'from "node:' <输出>/assets/*.mjs` 每个文件都应为 0。
3. **构建好的 Worker 与 Node 参考版逐个比较（必须做）**：把你们的部署目录用本地 HTTP 服务提供（`.mjs` 必须是 JavaScript MIME，`.wasm` 是 `application/wasm`；`python3 -m http.server` 可以），然后运行：

   ```bash
   (cd <你们的仓库> && python3 -m http.server 8000 --bind 127.0.0.1) &
   node web/tools/search-latency.mjs --belief=<你们仓库>/bot/reason/models/belief-v1-16d76783.onnx \
     --url=http://127.0.0.1:8000/bot/reason/ --start=731960000 --rounds=60 --out=reason-latency.json
   ```

   这个工具先用 onnxruntime-node 跑冠军自博弈，每局取一个中盘和一个尾盘真实决策，用 Node 研究机器人（`midgame-search.mjs`，求解器只按节点数限制，结果确定）算出预期选择；再在无头 Chrome 里加载 `<url>/assets/search-worker.mjs`，先按电脑预算、再按“手机预算 ÷ 4”逐个比较（50 秒预算下手机代理为每步 12.5 秒、单次求解 0.75 秒；后者短于 Node 的 3 秒，所以代理臂仍按“被时钟停下整次作废”处理，回落会多于真实手机）。它要求本仓库 `web/dist/models/bot-017.onnx` 存在（先 `npm run build`，或把 017 拷到这个位置），默认用 `/Applications/Google Chrome.app/…`，其他系统要加 `--chrome=<路径>`。

   - 通过标准：`completedDifferentFromNode` 必须为 0，电脑预算下的回落应该很少。
   - 本项目正式的 60 局结果（用本仓库自己的构建，93 个决策）见 `ai/research/evaluation/web-search-bot-latency.json`。写本文时，作者也用第 4.1 节的打包输出、按 `bot/reason/` 布局跑过一次小规模检查，结果全部相同，但没有存成证据文件。你们要以自己保存的 `reason-latency.json` 为准。
   - 这些都只是开发种子上的一致性检查，**不是**棋力结果。

4. **更大规模的一致性（可选）**：`node ai/danMCai/belief/web-parity.mjs --belief=<belief.onnx> --champion=<bot-017.onnx> --rounds=100 --per-band=2`。它会比较 Node、浏览器核心＋onnxruntime-node、WASM 和电脑预算四种跑法。它要求推断网络旁边有 `train-report.json`，用来确保种子不与训练集和留出集重叠，而 Release 里没有这个文件，所以需要向所有者要。拿不到就以第 3 条为准。
5. **你们自己的适配**：在页面控制台，或用你们的 Node 测试加载 `reason-client.mjs`，对几个真实局面检查：
   - `payload.hand.length === payload.counts[p]`，`payload.log.length === G.log.length`，`payload.turn === p`，载荷里没有 `hands`；
   - 交换另外两家的暗牌后，载荷不变；
   - 进贡局和抗贡局不出现 `known-cards` 回落（出现说明 `tc`／`rc`／`has` 填错了）；
   - 能一手出完、只有一个候选、明牌座位、41 张以上时，`reasonSearch` 不发请求；
   - 在搜索返回前人为改变 `G.log.length`，结果被丢弃。
6. **牌谱验证**：从房主页面导出一局完整记录（两名以上真人，电脑选 reason），存成 JSON，再运行：

   ```bash
   node --input-type=module -e "import { validateRecord } from './web/src/collection/validate.mjs'; import fs from 'node:fs'; const r = validateRecord(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))); console.log('ok', r.trust);" record.json
   ```

   应输出 `ok unverified_browser`。同时检查：电脑座位的 `bot` 和每个电脑动作的 `model` 都是 9001 身份（Clint 规则回落的动作是 `clint-rule`）；超时动作是 `clintsun1977-timeout`；只有真人动作可能带 `assisted`。

7. **耗时**：在真实桌面浏览器和至少一部手机上，各打完整的单人局（电脑选 reason，普通模式，不加 `?test=1`），在控制台查看 `client.stats`。要求：
   - 牌桌不卡、每一手都合法、没有出现 `botFail` 提示；
   - `searched > 0`，`fallbacks` 里各原因的计数合理（50 秒预算下桌面和手机都应以 0 为主；手机上偶有 `budget` 回落说明设备很慢）；
   - `ms` 的 95 分位低于预算。
8. **整局浏览器冒烟**：
   - 单人局打完一局普通局和一局进贡局；
   - 房主加一名加入者的房间里，只有房主页面为电脑创建搜索 Worker（加入者只在开了评价时才会有）；
   - 出牌评价在 21–40 张、≤20 张、41 张以上三段分别显示正确的状态文字，搜索进行中不显示数字；
   - 关闭评价后，没有评价任务继续运行；
   - `aiSeesAll` 座位不调用搜索；
   - 页面刷新恢复后能继续正常出牌。

## 15. 常见问题

| 现象                                               | 原因与处理                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker 报 `__MODEL_VERSIONS__ is not defined`      | 打包时漏了 `define`。用第 4.1 节的脚本重新打包。                                                                                                                     |
| 取出的打包脚本 SHA 不对或解析失败                  | 手工复制时多带或少带了代码块的边界行。用第 4.1 节的 `awk` 命令重新取出，并确认本文没有在本地被格式化工具改动过。                                                     |
| Worker 启动失败或模块加载失败                      | `.mjs` 的 MIME 不是 JavaScript，或者没用 `{type: 'module'}`；也可能是 `assets/vendor/` 下缺了 ORT 的三个文件。                                                       |
| 模型 404                                           | 目录不是 `X/assets/…` 和 `X/models/…` 的结构，或者文件名改了（必须是 `bot-017.onnx` 和 `belief-v1-16d76783.onnx`）。                                                 |
| 报 `Node file APIs are unavailable in the browser` | 有代码调用了 `sampler.mjs` 读文件的分支，正常网页不会走到这里，说明打包或源码被改过。                                                                                |
| 第一手总是 `loading` 回落                          | 第一次决策最多等 10 秒（`firstLoadWaitMs`）。尽早调用 `client.warm('9001')`（开局或选好机器人时）。                                                                  |
| 很多 `error`，并且 30 秒内不再重试                 | `init` 失败后的冷却（`search-init-wait`）。查看 Worker 的控制台，通常是 404 或 MIME 问题。                                                                           |
| `known-cards` 回落                                 | 进贡、还贡或抗贡记录与公开打出的牌矛盾。检查 `G.trib` 的 `tc`／`rc` 是否是实际交换的牌对象，`G.kang.has` 的 `n` 是否等于大王张数（0–2）。                            |
| `Invalid search payload`                           | `G.turn ≠ p`、`hand.length ≠ counts[p]`、`counts` 不是 4 项、牌号重复或不在 0–107 范围内。                                                                           |
| 搜索结果总对不上你们的牌（本仓库叫 `mismatch`）    | 用了 `index` 而不是 `ids`＋`shape`；或者 `analyze` 的读法不一致。先检查牌号映射。                                                                                    |
| 出现 `botFail` 提示、之后全用 Clint 规则           | 017 本身失败，或者搜索没有自设上限、整个请求超过了 `BOT_WAIT_MS`（50 秒预算下须把它提高到 67 秒＋017 以上）。搜索失败只能回落 017，不能触发 `botFail`（第 8.3 节）。 |
| `Invalid ranked actions`                           | 显示 017 值时传了第 6 个参数，或者 `shown` 里有 `null` 却没传 `s.base`；也可能 `s.actions`、`shown`、`s.base` 长度不一致（补算出法时漏了追加某一项）。               |
| 手机上 `budget` 回落多                             | 每步上限已是 50 秒，回落多说明设备很慢或页面在后台被限速。这时出的是 017 的牌；不要为此改预算语义。                                                                  |
| 页面内存高                                         | 每个 Worker 约 210–220 MB。确认整个页面只有一个客户端；评价不要另建 Worker。                                                                                         |
| 收集器拒收（`invalid_seats`、`invalid_actor`）     | 身份的 `sha256` 填成了文件 SHA，或者 `version` 不对；也可能把 `assisted` 写到了电脑或超时动作上。                                                                    |
| 想直接从 Release 地址加载模型                      | 不要这样做：不能保证浏览器拿到的字节与构建时校验过的一致，跨域行为也不受你们控制。在构建时下载并校验，再从同源地址提供。                                             |

## 16. 出处索引

- 清单与身份：`web/src/ai/model-catalog.json`（`searchBots`）、`web/src/ai/model-catalog.mjs`（`searchBotManifest`、`botIdentity`、`botModelName`、`validateCatalog`）
- 参数与预算：`web/src/ai/search/constants.mjs`
- 搜索核心与评价值：`web/src/ai/search/core.mjs`、`web/src/ai/search/coach.mjs`
- 载荷与公开约束：`web/src/ai/search/payload.mjs`、`web/src/ai/search/known-cards.mjs`
- ONNX 调用：`web/src/ai/search/inference.mjs`
- Worker 与客户端：`web/src/ai/search-worker.mjs`、`web/src/ai/search/client.js`
- 牌桌接入参考：`web/src/ai/controller.js`（`searchRequest`、`searchedPlay`、`decide`）、`web/src/game/turns.js`
- 评价接入参考：`web/src/coach/controller.js`、`web/src/coach/evaluation.mjs`、`web/docs/MOVE_COACH.md`
- 构建：`web/tools/build.mjs`、`web/tools/node-stub.mjs`、`ai/publishing/artifacts.mjs`、`ai/publishing/publish-belief-asset.mjs`
- 收集：`web/src/collection/validate.mjs`、`web/src/collection/record.mjs`、`web/src/collection/config.json`
- 测试与工具：`web/tests/search-bot.test.mjs`、`web/tools/search-latency.mjs`、`ai/danMCai/belief/web-parity.mjs`
- 证据：`ai/research/MODEL_STUDY.md` 第 70–72 节；`ai/research/evaluation/window2-20261109/`（H4）、`ai/research/evaluation/window1-20261109/`（H3）；`ai/research/evaluation/web-search-bot-{9001,parity,latency}.json`
- 本仓库说明：[电脑对手](BOTS.md#研究机器人推理搜索9001)、[模型选择与发布](WEB_MODELS.md)、[出牌评价](MOVE_COACH.md)
