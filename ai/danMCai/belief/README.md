# 手牌推断网络 v1（主线一）

[长期训练计划](../../research/TRAINING_PLAN_LONGTERM_20261109.md)主线一的第一版：根据出牌方能看到的公开信息，估计每张未见牌分别在另外三家（下家、对家、上家）手里的概率，再按精确张数抽出"像真的"的牌局世界，供搜索和标注替换现在的均匀乱猜。所有者明确要求这条线长期保留；早期效果不明显时按"出牌模型还不够强"记录并在后续重测。

本目录只是**工程与开发冒烟**，不是预登记实验或验收结果。它不修改网页冠军 017、菜单、任何冻结运行或出牌策略；接入搜索或出牌网络需另行预登记，并以整局签名升级分验收。

## 目标与边界

- **输入只来自出牌方的公开视角**：自己的牌、每一手的出牌（牌和牌型）与"不要"、各家剩余张数、级牌。`publicView` 只复制这些字段，`features` 拒绝任何带 `hands` 的对象；测试证明在公开信息不变时任意打乱其他三家的暗牌，特征完全不变。
- **监督目标是暗牌位置**：每种牌面的未见张数在三家各几张（0–2）。这是对隐藏信息建模，所有者已明确批准作为推断网络的监督目标；它不是奖励、损失项或门控，不涉及牌权、炸弹等中间信号，也从不进入输入。
- 推断质量指标（对数似然、命中率、世界重合度、真实发牌排名）只说明"猜得准不准"，**不是棋力**；棋力只按整局升级分另行验收。

## 特征（`features.mjs`，belief-v1，1,238 个 uint8 计数）

| 区块           | 大小    | 内容                                                 |
| -------------- | ------- | ---------------------------------------------------- |
| `own`          | 54      | 自己手牌各牌面张数（冠军的 54 面索引 `cardIndex`）   |
| `unseen`       | 54      | 未见张数 = 2 − 自己 − 已出                           |
| `played`       | 3 × 54  | 下家／对家／上家已出牌面                             |
| `counts`       | 4       | 自己与三家剩余张数                                   |
| `out`          | 3       | 三家是否已出完                                       |
| `level`        | 13      | 级牌 one-hot（2–A）                                  |
| `shapes`       | 3 × 148 | 三家出过的牌型桶（领出和跟牌）                       |
| `passOpponent` | 3 × 148 | 三家面对**对手**的当前牌型选择"不要"的次数，按牌型桶 |
| `passPartner`  | 3 × 10  | 三家面对**队友**的当前牌型"不要"的次数，只按类型     |
| `leads`        | 3 × 10  | 三家领出的类型                                       |

牌型桶共 148 个，按 `combinations.js` 的 `(type, value, n)`：单张、对子各 16（2–A、级牌 15、小王 16、大王 17）；三张、三带二各 14（2–15）；顺子 10、连对 12、钢板 13（按起点）；炸弹按张数 {4, 5, 6+} × 点数 2–15 共 42；同花顺 10；天王炸 1。"不要"归到当前牌型，即日志中最近一手出牌；一轮是否结束按与 `advanceRound` 相同的公开规则重放（其余仍有牌的座位都"不要"）。v1 把出牌顺序压缩成计数，序列模型留到后续版本。

## 文件

| 文件           | 作用                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `features.mjs` | 公开视角、特征与目标；牌型桶方案                                                                             |
| `generate.mjs` | 冠军四家贪心自博弈单局（`createRound(seed)`），在张数区间内按 `--every` 抽样记录；按种子块可续跑的二进制分片 |
| `train.py`     | MLP（特征 → 512 → 512 → 54×3）＋固定先验 log(张数)；按未见张数加权的交叉熵；按种子划分验证；导出 ONNX        |
| `sampler.mjs`  | 按推断概率抽完整牌局，精确满足张数和未见牌多重集；输出格式与 `sampleWorlds` 相同，可直接替换                 |
| `metrics.mjs`  | 留出牌局上对比推断与均匀：每张对数似然、首选命中率、抽样世界重合度、真实发牌在均匀世界中的排名               |

**训练细节。**最后一层初始化为零，所以未训练的网络恰好等于均匀基线（概率与三家剩余张数成正比），已出完的座位概率约为 0。损失是每张未见牌的交叉熵（没有未见牌的牌面不计）。`--augment-suits=1`（默认）对黑桃／梅花／方块三种花色做随机置换：红桃带逢人配，其余三花色在规则下对称，置换把一副合法发牌变成另一副合法发牌；牌型桶不含花色，不变。生成数据的冠军本身不保证花色对称（输入保留花色，平分时按候选顺序取第一个），所以在冠军自博弈数据上这是对称先验而不是精确恒等：冠军可能有的花色习惯被平均掉，不会被学到。只导出训练结束时的网络，不挑验证最好的检查点。ONNX 输入 `features [batch, 1238]`、输出 `probs [batch, 54, 3]`。

**抽样。**模型把每张未见牌独立地按 `p[牌面][座位]` 加权，在"三家张数恰好等于公开张数"的条件下抽整副牌。用对未见牌的反向动态规划（状态为下家、对家各还需几张，上家取余下）在对数空间算出条件配分函数，再逐张按精确条件分布抽取，所以张数和多重集按构造严格成立。这取代了"IPF／Sinkhorn 拟合边际再近似顺序抽样"：同一座位的权重整体乘常数不改变条件分布，不需要按座位校准。概率均匀时每种合法发牌等可能，与 `sampleWorlds` 分布相同（测试按枚举核对）。冒烟中 48 张未见牌抽 32 个世界约 0.3 毫秒。

## 运行

```bash
# 数据（开发种子只用于冒烟；正式运行先预登记并审计种子）
node ai/danMCai/belief/generate.mjs --seeds=<a>..<b> --out=<目录> --band=21-80 --every=1 --workers=4
# 训练（Apple MPS；数据量小时须加强正则并限制步数，按 train.py 的种子验证集选择）
ai/danMCai/environment/mac/bin/python ai/danMCai/belief/train.py --data=<目录> --out=<模型目录> --minutes=5
# 留出指标
node ai/danMCai/belief/metrics.mjs --belief=<模型目录>/belief.onnx --seeds=<c>..<d> --out=<结果.json>
```

分片元数据 `b<起点>.m.u32` 每行 4 个 uint32（种子、手数、出牌方、全桌张数），种子须在 [0, 2^32) 内；开发种子大于 2^31，旧版 int32 写法会回绕，`train.py` 按块种子范围核对并拒绝。`metrics.mjs` 默认读取模型旁的 `train-report.json`，指标种子与任一训练／验证数据种子范围重叠时拒绝运行（没有报告时须显式 `--train-report=none`）。`--temperature` 抽样按（协议、局种子）每局重新播种，与进程数和分块方式无关。

默认冠军为 `~/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx`（SHA-256 `462afc99…b3f7`，冠军 017 的冻结拷贝），`run.json` 记录完整 SHA；续跑时协议不同会拒绝。生成数据和模型放在忽略的 `ai/danMCai/workspace/` 或 iCloud 之外的 `~/guandan-runtime.noindex/`。

## 开发冒烟（2026-11-08，开发种子，不是验收）

- 生成：种子 3,838,121,000–3,838,121,299，300 局，张数 21–80，`every=1`，4 进程：15,145 行，墙钟 8.0–13.7 秒（两次运行，随机器负载变化），约 **310–485 行／秒／进程**（约 50 行／局）。每行 1,238 + 162 + 16 字节 ≈ 1.4 KB。
- 训练：30 个种子（种子 mod 10 = 0）作验证。只有 270 副训练发牌时网络在 100 步内就开始背发牌（无正则时验证损失从 0.958 升到 2.48），所以冒烟用 lr 3e-4、dropout 0.5／输入 0.2、weight decay 1e-2、花色置换、700 步（MPS 13 秒，约 5.4 万行／秒）。这些设置是在初版元数据回绕时的验证集（实为种子尾数 6 的 30 局）上选的；修正为 uint32 后按真正的尾数 0 验证：每张对数损失 0.893，均匀 0.961；首选命中 0.546，均匀 0.499。ONNX SHA-256 `66874ce2…04f8`。
- 留出指标：种子 3,838,121,300–399，100 局、5,045 个决策、182,785 张未见牌：

| 指标                               | 推断 v1 | 均匀  |
| ---------------------------------- | ------- | ----- |
| 每张对数损失                       | 0.900   | 0.972 |
| 首选座位命中率                     | 0.538   | 0.485 |
| 抽样世界与真实的重合度（8 个世界） | 0.553   | 0.477 |
| 真实发牌在 32 个均匀世界中的排名   | 0.925   | 0.5   |

每张对数似然增益 +0.073，按种子簇 95% 区间 [0.059, 0.086]，n = 100 局。按全桌张数：21–40 张 0.697 对 0.793，41–60 张 0.893 对 0.974，61–80 张 0.997 对 1.053。（初版模型在同一留出种子上为 0.901／0.538／0.552／0.920，增益 +0.071。）这只说明管线能学到公开历史里的信息；数据量极小，正式训练前须重新选择正则与步数并预登记。

## 已知限制

- 训练数据来自冠军贪心自博弈，推断的是"冠军这样打时"手牌在哪；对真人或其他对手可能偏差。
- `train.py` 把所有分片读进内存：100 万行约 1.4 GB；在 4 GiB 预算下建议正式运行用 `--every` 抽样，或每次训练不超过约 150 万行。
- v1 只用计数摘要，不含出牌顺序；概率按牌面独立，抽样时只通过张数约束耦合。
- 日志里不带牌型的视角（如 `policyState`）按牌推断牌型；带逢人配的出牌可能有多种合法解释（如三带二的两种主点、连对与钢板），此时 `features` 拒绝猜测并抛错，且这一局之后的决策都会抛错。随机大牌对局中约 9% 的决策受影响；接入搜索时应传入带 `type/value/n` 的公开日志（模拟器 `game.log` 和 `publicView` 都带）。

## 中盘搜索开发检查（P2）

`midgame-search.mjs`：中盘（默认 21–40 张）一步模拟搜索，候选为冠军前 6 名（可过牌时加过牌），每个候选在 8 个世界里由冠军打到底；只有某候选比冠军出法多赢至少 2 个世界且平均更高时才偏离冠军。`--worlds-source=uniform` 与均匀抽样完全一致，`--worlds-source=belief --belief=<onnx>` 改用推断网络抽样；隐藏手牌在搜索中被屏蔽，真实发牌从不参与决策。`--compare=<A>,<B>` 给出同一批牌的配对差和牌副簇 95% 区间。这是开发工具，正式结论需另行预登记。

第三窗口（2026-11-09）新增，均为开发／验收工具，不是结果：

- `--focal-raw-model=<onnx>`：焦点方在 `hi` 张以上的直接决策改用这个 215 维 extras 模型（53 维公开 extras＋`beliefMarginals` 的 162 维，须同时给 `--belief`）；候选、推演、残局求解、世界抽样和对手仍用 `--champion`。拒绝冠军文件本身或 extras 宽度不是 215 的模型；`run.json` 和每行记录模型 SHA-256，每局记录 `rawDecisions`／`rawDiffers`。
- `--mode=raw`：不搜索，焦点方每个直接决策都用该模型（止损检查用）；不能与 `--endgame=pimc` 或 `--worlds-source=belief` 同用。
- `--held-out=1`：只改写报告里“开发种子”的说明并记录 `heldOut`，用于预登记的留出验收。

第四窗口（2026-11-10）新增，仍是工具，不是结果：

- `--opponents=champion|search`（默认 `champion`，行为与记录不变）：`search` 时对手队也用同一套机器决策（`lo`–`hi` 张推断世界搜索、`endgameHi` 以下精确 PIMC），每个座位只看自己的遮蔽视角，世界按同一 `worldSeed(发牌种子, 步数)` 规则生成；`hi` 张以上对手始终是冠军 017 贪心（即现网 9001），从不使用 `--focal-raw-model`。只有 `search` 时每行新增 `opp` 计数（`bandDecisions`、`searched`、`differs`、`endgame*`、`searchMs`、`endgameMs`），`run.json` 记录 `opponents`；`--compare` 把旧运行视为 `champion`。`--opponents=search` 与 `--mode=raw`、或非 `search` 模式带 `--focal-raw-model` 的组合会被拒绝。
- `--deadline=<ISO>`、`--stop-file=<路径,…>`：每副开始前检查，到时或出现 STOP 文件即停，已完成的牌副保留。
- 测试 `ai/danMCai/tests/midgame-search-opponents.test.mjs`：默认路径逐字段复现第三窗口 S1 A 臂 20 副（求解器按墙钟预算，`endgameWorldsUsed` 允许每个残局决策差一个世界）；换位恒等；拒绝组合。用途是第四窗口 S6b（对手也推理的验收）。
- `--opponents=guanzero --opponent-model=<onnx> [--opponent-sha256=<hex>]`（第四窗口 B3，GuanZero 只作评测对手）：对手队座位用 GuanZero 导出模型出牌，打分用网页同一个 `web/src/ai/policy-inference.mjs` `inferPolicy`（`guanzero-v1` 二十步公开历史），各座位只看遮蔽视角。规则同 GuanZero 自己的评测工具 `ai/guanzero/training/evaluate.mjs`：只要有两个以上候选就在全部候选里取最大值（同值取第一个），不先走一手出完、不搜索、不探索；**网页里的 GuanZero 另有一手出完优先和公开残局求解**，所以这里量的是评测口径下的 GuanZero 网络，不是网页机器人。焦点方不变（任一 `--mode`、`--endgame`、`--focal-raw-model`）。`run.json` 记录 `opponentModelSHA256`，每行 `opp` 为 `gzDecisions`、`gzMs`、`gzFinishingAvailable`、`gzFinishingDeclined`。单局、不进贡、双方同级，与 GuanZero 的整场成绩不可比。测试 `midgame-search-guanzero.test.mjs`：前 50 个有选择的存档局面（`ai/shared/fixtures/positions.json`）上与 `createInference` 选择和数值完全一致，并逐一核对一副牌里 GuanZero 的全部实战决策。

## 交接点上界诊断（handover-oracle.mjs，第三窗口 S1）

`handover-oracle.mjs` 估计 40 张交接点以上、以下各丢多少分：A＝现网 9001（直接调用本目录 `midgame-search.mjs` 的决策函数），B＝40 张以上用“看真实发牌”的推演、40 张及以下照常 9001，C＝全程看真实发牌。真实发牌推演读取隐藏手牌，只是上界，不是玩家，也不作训练数据。对手为冠军 017 贪心，单局、不进贡、换位配对；支持 `--deadline`／`--stop-file`，`--summarize=1` 给出 B−A、C−B、A−C 配对差。测试 `ai/danMCai/tests/handover-oracle.test.mjs`（A 臂逐局复现 `midgame-search` 的 `playRound`）。

## 炸弹反事实的 Clint 续打（opening-counterfactual.mjs，未使用）

`opening-counterfactual.mjs --continuation=clint --positions=<rows.jsonl> --select=blind-first:N [--stop-file=…]`：从已存局面重建（不符即停），强制走炸弹或最佳非炸弹后，行动方为 9001、对方为带网页大脑的 Clint，记录每局大脑超时比例（超过 30% 报告为不可靠）。第三窗口 S5 由所有者 23:05 决定不跑（判断 Clint 比 017 弱），代码已测试但未用于任何结果；Clint 仍只作评测。

源码闭包指纹的键统一使用仓库相对路径和正斜杠，Windows与POSIX保持同一字段格式；已冻结实验仍使用原记录与原源码。

## 特征版本 v3

`generate.mjs --features=v3` 在 v1 的计数特征之外，加入每家按顺序的最近 12 个公开动作（过牌、牌型、点数区间、张数、领出／跟牌、压的是队友还是对手、出后剩余张数），以及按点数的"能接却不要"计数。默认仍为 v1，v1 数据、模型和第一窗口的 ONNX 不变；模型的特征版本写在 `train-report.json` 与 ONNX 元数据中，采样、指标和中盘搜索据此自动选择。v3 每行约 3.1 KB，大规模训练需用 `--every` 控制内存。

## 蒸馏学习器（开发）

`distill-learner.py` 在冻结冠军之上训练初值为零的修正量，目标是复现推断世界搜索的选择（仅在搜索偏离冠军处推开，其余保持冠军），只导出最终一步、融合 ONNX 与冠军接口一致。第二窗口开发检查发现：以 8 个世界的搜索最大者为目标、只用冠军的 567 维输入时，验证集上只能复现约 7% 的偏离（接近机会水平），见主报告第 71.1 节。

## 网页研究机器人（9001，浏览器移植）

2026-11-09 所有者要求把推断世界搜索放进游戏。网页菜单最后一项 `danMCai-reason-v000855042`（原名 `danMCai-v000855042+推理搜索`）使用本目录的推断网络 v1（`16d76783…`）和 `midgame-search.mjs --worlds-source=belief --endgame=pimc --endgame-hi=20 --endgame-worlds=belief` 的同一规则。本目录的研究源码保持字节不变：浏览器代码在 `web/src/ai/search/`（`core.mjs` 是 `searchDecision`／`endgameDecision` 的副本，加了时间预算），只复用 `sampleBeliefWorlds`、`publicView`、`featuresFor` 与求解器。

- `web/tests/search-bot.test.mjs`（`npm test`，无需模型）：用确定性替身网络，在固定种子的中盘与尾盘局面上要求浏览器核心与本目录 Node 函数的选择、根节点、各世界结果和世界完全相同。
- `web-parity.mjs`（本地，需要模型）：冠军自博弈的开发种子局面上比较 Node 研究机器人、浏览器核心＋onnxruntime-node、浏览器核心＋onnxruntime-web WASM，以及按电脑预算运行的回落率和耗时；结果写入 `ai/research/evaluation/web-search-bot-parity.json`。

```bash
node ai/danMCai/belief/web-parity.mjs --belief=<belief.onnx> --rounds=100 --per-band=2 --out=ai/research/evaluation/web-search-bot-parity.json
```

2026-11-09 所有者指示把它设为网页新玩家默认（清单 `selection.defaultChoice`；冠军 017 仍可选并供进还贡），随后又要求出牌评价也默认用它：评价在牌桌剩 40 张以内显示同一搜索的值（`web/src/ai/search/coach.mjs`）。这是部署，不是验收：棋力证据仍只有冠军对手、单局、不进贡的 H3／H4 留出结果。详见 [BOTS.md](../../../web/docs/BOTS.md#研究机器人推理搜索9001) 与主报告第 72 节。

## 推理机器人对 Clint 的整场评测工具（开发工具，不是结果）

`reason-match-eval.mjs` 用整场规则（从 2 打到 A、进贡／还贡、打 A 三次失败记平局）评测网页上部署的 `danMCai-reason-v000855042`（菜单 9001）对 Clint规则机器人（`rules-v2`）。所有者 2026-11-09 要求 500 场；本文件只提供工具，正式运行由协调者预登记种子后执行，本节不含任何胜率。

- **配对与对局引擎**沿用 GuanZero 开发套件（[ai/guanzero/README.md](../../guanzero/README.md)）：每个种子打两场，推理机器人先坐 0/2 再坐 1/3，250 个种子 = 500 场。直接复用 `createMatchRound`、`advanceRound`、`advanceMatch`（aFail `draw`）、`playMatch` 的每局种子。与 `playMatch` 不同之处：按发牌与进贡后的手牌重建网页牌桌上公开的进贡记录（`trib`）和抗贡记录（`kang`），使 Clint 的公开推断和搜索的“已知牌”与网页一致；不重建且用 `--clint=rules-only` 时逐局结果与 `playMatch` 完全相同（测试核对）。
- **Clint 对手默认是网页上部署的 Clint 座位**（`--clint=web`）：AI Worker 的 `decideClintRule(ruleObservation(game, p))`，即 `strategy.js` 的规则出法再经同步来的**残局大脑**（`endgame-brain.mjs`，四家都 ≤12 张时抽样未见牌并精确求解，网页单次上限按“60 秒出牌、50 秒推理”规则为 30 秒，此前 10 秒；评测器用 `WEB_BRAIN` 的 30 秒），只读自己手牌与公开信息；随机数用开发套件给 Clint 的同一种子流（局种子 ^ 0x6a09e667）。关掉残局大脑时与开发套件 `createRuleBaseline(…, 'rules-v2')` 逐局相同（测试核对）。`--clint=rules-only` 是开发套件原接法，**不含残局大脑**，只用于与历史 GuanZero Clint 评测对照，不能称为“最新 Clint”。每场记录残局大脑的调用、采用、超时保留规则出法与改变出法次数及用时。
- **推理机器人**按 `controller.js`、`search/client.js`、`search-worker.mjs` 的部署逻辑：完成牌或唯一候选直接出；牌桌 21–40 张或 ≤20 张时，`searchPayload`→`restoreGame`（屏蔽他人手牌、公开已知牌）→`searchBotDecision`，使用**电脑预算**（中盘 3 秒、尾盘 4 秒、求解器单次 3 秒、每进程一个常驻求解器、表 30 万）；超预算、已知牌矛盾、错误、超过硬时限（丢弃求解器表）或回复与牌桌不符时改用冠军 017（`decideTablePolicy`，含公开二人残局证明），按原因计数；其余局面直接用 017。进贡／还贡：网页进贡专家未启用，所有电脑都出 `tributeOptions()[0]`／`aiReturnCard`，与开发套件的基线选择相同。唯一与网页不同的是搜索种子：网页每局用加密随机数，这里用局种子的固定散列 `searchSeedOf`（不读牌），以便复现。
- **时间预算让结果依赖机器负载与进程数**（推理机器人的搜索预算与 Clint 残局大脑的 30 秒上限都是墙钟时间）：每场记录搜索次数、偏离冠军次数、各原因回落数和用时；汇总报告回落率。默认用 onnxruntime-web WASM 单线程（与浏览器同一运行时），`--ort=node` 可换原生运行时。
- **输出**：`protocol.json`（协议、模型与源码 SHA、Clint 指纹、种子文件 SHA）、`seeds.json`、`pairs.jsonl`（每完成一对种子追加一行，含两场的胜者、最终级数、局数、打 A 失败次数、逐局记录、搜索与回落统计、用时）、`progress.json`、`report.json`（胜／负／平、胜率与按种子对聚类的 95% 自助区间、净胜场、最终级数差、双方座位分开的结果、回落与用时汇总）。协议不同或目录里有不明内容时拒绝写入；按已完成的种子对续跑；`<out>/STOP` 或 `--deadline` 停止派发并中止未完成的对局。源码指纹是本工具静态导入闭包的全部文件（含 `web/src/rule-bot/` 与网页运行时），任何改动都会使续跑拒绝。

```bash
nice -n 10 node ai/danMCai/belief/reason-match-eval.mjs --out=<目录> --seeds=<a>..<b> --workers=6 \
  [--deadline=<ISO 时间>] [--belief=<belief.onnx>] [--champion=<bot-017.onnx>] [--ort=wasm|node] [--clint=web|rules-only]
node ai/danMCai/belief/reason-match-eval.mjs --summarize --out=<目录>
```

测试 `ai/danMCai/tests/reason-match-eval.test.mjs`（`npm test`，无需模型）用替身网络覆盖进贡记录重建、与 `playMatch` 逐局一致、网页 Clint 关掉残局大脑时与开发套件逐局一致、残局大脑实际启用、预算与硬时限回落、协议拒绝与续跑、汇总统计。

## 真人面板评分（panel-scorer.mjs、arm-replay.mjs，第三窗口 S7）

`panel-scorer.mjs` 在固定的真人留出面板上给模型打分（只作描述，不作门控）：1,458 个未辅助真人决策、269 个领出局面和可精确求解的关键局面（§67 的 115 个及 S7a 扩充部分）。输出早炸率、小牌上压王、拆牌代价、与真人一致率、领出接不回来的组合牌比例、精确求解正确率，以及手牌推断 v1 在真人局面上的对数损失，并给出两个模型的配对差。215 维模型的输入与 `midgame-search.mjs --focal-raw-model` 完全一致，只从出牌方自己的手牌和公开信息计算（遮蔽他人手牌，读取即报错）；只有推断对数损失的真值读取四家手牌，不进入任何模型。`--parity=1` 检查包装初始模型与 017 在全部面板局面选牌一致。私有牌谱只读，输出不含记录号、房间号和昵称。`arm-replay.mjs` 按各臂设置重放 S6 的牌局，用于统计残局手牌结构。测试 `ai/danMCai/tests/panel-scorer.test.mjs`（无私有牌谱时跳过对齐测试）。

## 029-reason推断适配新窗口（2026-11-13晚）

`train.py --initial-onnx`可完整复制v1权重与输入归一化，用新AdamW适配（不是匹配Adam续训）；`--epochs`固定数据遍数，`--deadline`/`--stop-file`/`--pause-file`支持新窗口截止与内存保护；最终checkpoint含匹配优化器。旧参数默认行为保持。新029贪心/搜索样本、GPU预检及三组独立整局比较见[协议](../../research/evaluation/reason-029-20261114/README.md)，准备/推断误差/棋力分别记录。网页和旧冻结检出不变。
