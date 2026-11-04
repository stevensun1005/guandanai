# 修改意见

**审查日期：2026-11-04 · 基线提交 `6cd67be`**

本文是对现有代码的审查意见和改进建议，不是实验报告。文中提出的训练方法、特征和搜索扩展都是**待检验假设**，没有实现，也没有验证；实施后的结果应按 [AGENTS.md](../AGENTS.md) 的约定写入 [模型研究报告](MODEL_STUDY.md)。

审查时 `npm test` 77/77 通过；Python 冒烟测试未运行。每条意见标注依据：

- **已确认**：读代码或临时脚本复现确认。
- **待核实**：根据代码推断，或取决于桌规选择，尚未实测。

## 总体判断

工程与证据记录的规范性较好。主要问题有两类：

1. **模型训练难以推进**：数据量小、整场回报稀疏、开发评测样本小，三者叠加，使训练改动无法与随机波动区分。
2. **联机信任边界**：客人浏览器持有四家手牌。

## 一、安全与规则正确性（优先修复）

### 1. 客人可以看到四家手牌

**已确认 · 严重**

- [session.js:55](../src/game/session.js) 的 `roundEvt` 向所有客人广播整副洗好的牌 `deck`。
- [dealing.js](../src/game/dealing.js) 中每个客户端在本地发出全部 108 张。
- [recovery.js:63](../src/network/recovery.js) 的 `sendSnapshot` 发送 `structuredClone(runtime.game)`，含全部手牌。

任何客人用开发者工具即可读取另外三家的牌。出牌本身由房主校验（[rooms.js](../src/network/rooms.js) `hostGuestAct`），这部分正确。

**修改建议**

- 房主发牌，每位客人只收到自己的牌 ID 与各家张数；其他人的牌在出牌事件中公开，局末剩余牌由房主下发。
- 抗贡判定（[game/tribute.js:24](../src/game/tribute.js) 依赖隐藏手牌中的大王数）改由房主计算后广播。
- 快照按接收座位裁剪。客人端可用占位牌保持手牌长度，`active()` 等依赖张数的逻辑不受影响。
- 在 [ARCHITECTURE.md](ARCHITECTURE.md) 写明信任边界。

### 2. 导入牌谱可执行脚本（存储型 XSS）

**已确认 · 中高**

- [record-schema.js:9](../src/replay/record-schema.js) 的 `text()` 只截断长度，不转义。
- `rec.result` 随后原样插入 innerHTML：[inspector.js:636](../src/replay/inspector.js)、[viewer.js:214](../src/replay/viewer.js)。

恶意牌谱文件导入后可在站点域内执行脚本，读取 localStorage 记录与 sessionStorage 中的座位凭据。玩家昵称也有多处未转义插入（如 [effects/dealing.js](../src/effects/dealing.js)、[ui/table.js](../src/ui/table.js)、[inspector.js](../src/replay/inspector.js)），目前只靠房主在 [rooms.js](../src/network/rooms.js) 过滤字符，被修改过的房主页面仍可注入。

**修改建议**：渲染时统一使用 `esc()` 或 `textContent`；`index.html` 增加 CSP。

### 3. 出牌生成会漏掉普通顺子

**已确认（临时脚本复现）· 中**

[moves.js:53-65](../src/core/moves.js) 的 `genPlays` 每个点数只取第一张。若取出的牌恰好同花，[combinations.js:88](../src/core/combinations.js) 只会把它读成同花顺。例：手牌 ♠3 ♠4 ♠5 ♠6 ♠7 ♥7 只生成 `sflush:3`，不生成 ♠3–♥7 普通顺子。

影响：提示功能（[turns.js](../src/game/turns.js)、[follow-hints.js](../src/hand/follow-hints.js)）和规则机器人（[rule-policy.js](../src/ai/rule-policy.js)）跟顺子时只能拆同花顺炸弹。

**修改建议**：取出的牌全同花时，额外生成一个替换为异色牌的变体。

### 4. 需要按桌规确认的取舍

**待核实（行为已确认，是否为错误取决于规则）**

| 位置                                              | 当前行为                                                    | 需确认                             |
| ------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| [core/tribute.js:11](../src/core/tribute.js)      | 还贡「10 以下」按牌面点数判断，级牌（如打 5 时的 ♠5）算低牌 | 人类玩家是否允许把级牌当低牌还     |
| [game/tribute.js:89,98](../src/game/tribute.js)   | 双下两张贡牌同点时，稳定排序使三游的牌给头游、三游先出      | 很多规则按头游起的座位顺序决定     |
| [combinations.js:88](../src/core/combinations.js) | 同花连牌只能作同花顺，不能作普通顺子                        | 代码注释称有意为之，应写进规则说明 |

炸弹大小顺序、百搭、升级 +3/+2/+1、打 A 条件、抗贡计数、接风均未发现问题。

## 二、AI 与模型

### 5. 开发评测样本过小（最优先）

**已确认**

每次开发评测 128 场。胜率约 72% 时，95% 区间约 ±7.8 个百分点。完整网络相对初始化的提升 2.34pp（区间 [-5.95, 10.63]）无法与随机波动区分。

**修改建议**

- 开发评测改为 ≥1000 组配对种子，或用 SPRT 序贯检验决定接受／回滚。
- 立即锁定一段从未使用的留出种子区间，把区间与哈希提交进仓库，仅用于最终验收。

不先改这一条，后续训练改动都无法判定效果。

### 6. 实验评测对象与线上决策管线不同

**已确认**（[MODEL_STUDY.md](MODEL_STUDY.md) 第 7.5 节已说明）

实验对网络直接评分；线上还叠加风格、残局搜索和直接出完捷径。

**修改建议**：在 Node 中用 onnxruntime-node 直接调用 [worker.mjs](../src/ai/worker.mjs) 的 `decide`，评测与发布对象一致。

### 7. 整场回报过于稀疏

**已确认（现状）· 改进方法为待检验假设**

每场平均约 11 局、约 327 个决策，只有终局一个 ±1 回报。PPO 优势为 `R − V`（[train_ppo.py:277](../scripts/train_ppo.py)），方差很大。

**建议方法**

1. 用模拟或动态规划估计整场局面胜率表 $V(\text{双方级数}, \text{打 A 失败次数}, \text{当前打哪方的级})$。
2. 每局结束给予奖励 $V(s') - V(s)$。这是基于势函数的奖励塑形，不改变最优策略。
3. 整场问题由此分解为每局约 30 个决策的单局问题；可同时引入 GAE 与真正的状态价值 Critic。

### 8. 训练数据量相差数个数量级

**已确认（现状）**

16 个周期共 2048 场、约 2.2 万局。同类 DMC 方法通常使用 1e8 帧以上数据。瓶颈在采样：[match_learning.py](../scripts/match_learning.py) 每个决策都通过 stdin 与 JS 交换一次 JSON。

**修改建议**：多局并发、批量推理，或在 JS 进程内推理、按批传回轨迹；目标吞吐提高 10–100 倍。

### 9. 完整网络退步的可能原因

**待核实**

保持约束 $\lambda\,\mathbb E[(Q_\theta - Q_{\theta_0})^2]$ 只作用于被采样动作，未选候选的排序可以自由漂移，与「验证均方误差下降但实战全败」相符。

**修改建议**

- 对全部候选施加相对 $\theta_0$ 的 softmax 蒸馏或 KL 约束。
- 以按 Q 值的 Boltzmann 探索替代对全部候选的 ε=0.05 均匀探索。

### 10. 对手池过窄

**已确认（现状）**

外部对手只有项目自身的规则机器人；「对规则机器人 80%」依赖该机器人的强度。

**修改建议**：建立联赛对手池（P0、P0+残局、各 PPO Actor、规则机器人变体、加噪声版本），用 Bradley-Terry 或 Elo 统一报告。

### 11. 观察缺少的信息

**已确认（现状）**

[encoding.mjs](../src/ai/encoding.mjs) 未编码：

- 进还贡信息（收贡方知道收到的牌，进贡方知道还回的牌）；
- 当前轮牌权归属；
- 本轮已连续过牌的家数。

**修改建议**：沿用 628 维扩展方式追加特征，需要重新训练并做配对对照。

### 12. 残局搜索只覆盖剩两家

**已确认（现状）· 改进为待检验假设**

[endgame.js](../src/ai/endgame.js) 仅在剩两家且对方手牌可唯一推出时运行。

**建议方法**：剩三家时按公开信息与张数抽样补全未知手牌，对样本做完全信息搜索（PIMC），设预算上限，用配对种子评估。

### 13. 进贡与还贡只用规则

**已确认**

- 进贡时同点多花色直接取第一张（[rule-policy.js:510](../src/ai/rule-policy.js)），未考虑是否拆掉同花顺。
- 还贡（`aiReturnCard`）只看自身手牌代价，不考虑送给对手的牌是否有用。

**修改建议**：先用 `handCost` 比较不同花色的进贡损失，再考虑还贡对收牌方的价值；长期可纳入学习。

### 14. 性格与难度

**已确认（现状）**

现有证据显示几种性格之间没有可测出的强弱差别（[MODEL_STUDY.md](MODEL_STUDY.md) 第 7.4 节）。

**修改建议**：保留性格作为风格；另设「新手／普通／高手」难度，例如按温度采样或控制失误率。

### 15. 预训练权重来源与许可

**待核实**

`ai/policy.onnx`、`ai/policy.ckpt` 与 [ai/reference/client0.py](../ai/reference/client0.py) 看起来来自外部掼蛋比赛客户端（使用 zmq/ws4py，注释含外部作者路径）。仓库没有署名和许可说明，[MODEL_STUDY.md](MODEL_STUDY.md) 第 3.1 节也说明预训练过程不可复现。

**修改建议**：补充来源与授权说明，或确认使用权。

### 16. 代码整理

**已确认**

- [controller.js](../src/ai/controller.js) 含生产中不会进入的实验分支（`MODELS.policy.extraFeatures === 53`）。
- [worker.mjs](../src/ai/worker.mjs) 遇到任何错误都清空模型会话，输入错误也会导致重新加载模型。
- `policy.ckpt` 与 `policy.onnx` 各约 5.4 MB，都在 Git 中；可改用 Git LFS 或 Release 资源。

## 三、工程质量

### 17. CI 与测试覆盖

**已确认**

- [pages.yml](../.github/workflows/pages.yml) 只在 push 到 main 时触发，没有 `pull_request`。
- `*_smoke.py`（多人、断线恢复、进贡、重新同步等）、Python 单元测试和 `check_encoding.py` 均不在 CI 中运行。
- 无单元测试：`hostGuestAct`、`applyEvt`（[events.js](../src/game/events.js)）、进贡流程、接风与名次（[round.js](../src/game/round.js)）。`rules.test.mjs` 仅 6 个用例，`match.test.mjs` 仅 2 个。

**建议补充的规则用例**

- Q-K-A-2-3 被拒绝；AA2233、AAA222 被接受；
- 百搭补同花顺；
- 三张加两张百搭可读成炸弹或三带二，`readPlay` 的选择；
- 王对作三带二的对子；
- 同花顺对 5 张、6 张炸弹；
- 打 A 时对手先出完；
- 打 A 失败后的 `reset`／`keep` 两种模式。

**修改建议**：抽出纯函数 `authorizeGuestAction(state, seat, e)` 和纯状态归约函数并单测；增加 `pull_request` 触发；定时运行一个无头多人冒烟测试。

### 18. 一局流程重复实现

**已确认**

- [scripts/lib/simulation.mjs](../scripts/lib/simulation.mjs) 重写了推进、接风与名次补全；
- [scripts/lib/match-simulation.mjs](../scripts/lib/match-simulation.mjs) 重写了进贡与抗贡；
- [src/ai/candidates.js](../src/ai/candidates.js) 是第三套出牌生成器，独立于 `genPlays`。

目前行为一致，但训练环境与线上游戏可能悄悄分叉。

**修改建议**：抽出纯函数模块 `core/round-flow.js`，游戏与脚本共用。

### 19. 其他

| 问题                                                                                                                                               | 位置                                                                          | 依据   | 建议                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | -------------------------------------- |
| 「非法」与「暂不能执行」都返回 `false`：房主静默丢弃机器人动作，客人端事件队列卡到 8 秒重新同步                                                    | [events.js](../src/game/events.js)、[recovery.js](../src/network/recovery.js) | 已确认 | 返回 applied／defer／reject 并记录拒绝 |
| 房主标签页切到后台时定时器被节流，全桌时钟和机器人变慢                                                                                             | [clock.js](../src/game/clock.js)                                              | 待核实 | 按真实时间截止计算，并提醒房主         |
| 房间码 4 位，可被猜中入座，无踢人功能                                                                                                              | [rooms.js](../src/network/rooms.js)                                           | 已确认 | 加长房间码，增加踢人                   |
| 客人可无限期暂停                                                                                                                                   | [events.js](../src/game/events.js)                                            | 已确认 | 暂停时长上限                           |
| `build` 不清空 `dist/`，旧文件会被发布                                                                                                             | [build.mjs](../scripts/build.mjs)                                             | 已确认 | 构建前清空                             |
| `node --test tests/*.test.mjs` 在 Windows + Node 20 可能失败                                                                                       | [package.json](../package.json)                                               | 待核实 | 改用显式文件列表或提高 Node 下限       |
| 45 个模块用 `export let` + `initialize()`，常量也如此                                                                                              | 如 [rule-policy.js](../src/ai/rule-policy.js)                                 | 已确认 | 常量和纯函数改为 `const` 导出          |
| 大文件：`replay/session.js` 797 行、`hand/layout.js` 735 行、`replay/inspector.js` 710 行、`styles/replay.css` 1326 行、`styles/table.css` 1309 行 | —                                                                             | 已确认 | 按职责拆分                             |
| 没有 linter                                                                                                                                        | —                                                                             | 已确认 | 引入 ESLint                            |

## 建议顺序

1. **第一步（工作量小）**：修复 1–3，补 17 的 PR 触发与规则用例，补 15 的来源说明。
2. **第二步**：先改评测（5、6、10），再改训练。
3. **第三步**：训练方法（7、8、9），然后特征（11）、残局扩展（12）、进还贡（13）。

第二、三步每完成一个有结论的实验，都应把正结果、负结果和协议变化写入 [MODEL_STUDY.md](MODEL_STUDY.md)。
