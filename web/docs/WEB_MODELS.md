# 网页电脑：Clint、GuanZero、danMCai 与 danMCai-reason

**2026-11-09 起菜单只有四项**（所有者明确要求），内部编号只用于归档与房间同步。GuanZero 名称统一使用 `训练任务名-训练版本数值`，例如 `guanzero-adp-gpubatch-44752`，不使用“步”字或中间圆点。

| 顺序 | 当前选项                      | 来源                                                                           |
| ---- | ----------------------------- | ------------------------------------------------------------------------------ |
| 1    | Clint规则机器人               | 独立 rules-v2，不使用神经网络                                                  |
| 2    | guanzero-adp-io48-385979      | GuanZero 最新一代（最近注册的一代），归档 026                                  |
| 3    | danMCai-v000855042            | danMCai 现任实际门控冠军，归档 017                                             |
| 4    | **danMCai-reason-v000855042** | 带推理的研究机器人：017 权重＋推断网络 v1 搜索，9001；**默认**，出牌评价也用它 |

顺序沿用此前菜单的约定（Clint → GuanZero → danMCai → 研究机器人），也就是所有者列举四项的顺序；默认项与位置无关，由 `selection.defaultChoice` 决定，新座位一律预选第 4 项。`selectableModels` 生成这四项：Clint、`models` 中最后注册的 GuanZero、`selection.danMCaiChampions[0]`、`searchBots` 中底座为现任冠军的最后一项；没有这样的搜索机器人时只剩三项。清单 `selection.mode` 为 `latest-v2`（原七项菜单 `champions-v1` 只作历史）。

**退出菜单、保留归档。**danMCai 初始版 P0（001，danMCai-v000000000）、上一任冠军 012（danMCai-v000705434）和较早的 GuanZero（025 等）不再提供，权重、Release、清单条目和证据全部保留；`selection.danMCaiChampions` 仍记录最近两任冠军（现任在前），供冠军核验与工具读取，第二项不进菜单。旧房间或牌谱里的这些编号仍能解析（`botModelId`），只是不能再在大厅选择。

**命名。**推理机器人显示为 `danMCai-reason-v<底座冠军版本>`，与 `danMCai-v000855042` 的写法一致；2026-11-09 之前叫 `danMCai-v000855042+推理搜索`，编号 9001 与收集身份（`version: v000855042-bsearch1-16d76783`、清单摘要 `sha256`）都不变，旧牌谱与新牌谱是同一个机器人。

**默认使用 danMCai-reason-v000855042（9001）。** 2026-11-09 所有者明确指示“直接设成默认”，并要求“出牌建议也默认改为带推理的机器人”：`selection.defaultChoice` 为 9001，[出牌评价](MOVE_COACH.md#数值来源默认-danmcai-reason2026-11-09-起)在搜索范围内显示它的搜索值。这是部署决定，不是新的棋力验收。`defaultId` 仍是现任冠军 017（danMCai-v000855042），它在菜单中可选，并供进还贡、明牌工具、真人超时托管、搜索回落和评价的冠军值使用。冠军依据 `champion/champion.json` 的真实晋升历史、accept 门控与完整权重 SHA，不按步数最大排序，也不代表全局最强或独立验收通过。

本地选择保存在 `guandan-bot-choices-v2`，只记与默认不同的座位，未改动的座位跟随默认。**已保存但已退出菜单的选择（001、012、旧 GuanZero）在载入时回到默认 9001**（`botChoiceId`），下次保存时从存储中去掉。旧键 v1 每次改动都写入全部四席，其中的 `017` 分不清是主动选择还是当时的默认，所以迁移时按旧默认处理、改为 9001；其他仍在菜单中的 v1 选择（Clint、当前 GuanZero）保留。「全部恢复默认」把四席重置为 9001；想用 017 的玩家重新选一次即会保存。GuanZero 轮换到新一代后，选了旧一代的座位同样回到默认。

第 4 项不是新训练的模型，也不是冠军；见下方[研究机器人](#研究机器人推理搜索)。

朋友房间由房主设置，加入者只查看。恢复与转单机保留对应电脑选择。Clint 在 Worker 内只接收自己的手牌和公开信息；Clint 决策不加载 ONNX，神经网络分支不叠加 Clint 规则；实际网络决策（包括玩家超时托管）按需加载相应权重。

## 研究机器人：推理搜索

2026-11-09 所有者要求把“有推理能力”的研究机器人放进游戏。`model-catalog.json` 的 `searchBots` 只有一项：编号 **9001**，显示为 **danMCai-reason-v000855042**（同日由 `danMCai-v000855042+推理搜索` 改名）。它在冠军 017（`462afc99…`）之上加手牌推断网络 v1（`belief-v1-16d76783.onnx`，SHA-256 `16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9`，3,931,285 字节），按电脑端留出测试过的同一套规则搜索：

- 牌桌剩 21–40 张：冠军前 6 名＋过牌，8 个推断世界里各自用冠军贪心打完本局；某一手比冠军首选至少多赢 2 个世界且平均分更高才改，平手听冠军。
- 剩 ≤20 张：同一推断网络抽 8 个世界逐个精确求解，至少 4 个世界解完，取平均最高，平手听冠军。
- 其他时候、只有一个候选或能一手出完：与 017 相同。

**它是菜单与出牌评价的默认，但不是冠军。**新玩家的电脑空位默认 9001（`selection.defaultChoice`），出牌评价在牌桌剩 40 张以内时显示它的搜索值；进还贡和明牌工具仍用 017，`defaultId` 仍是 017。`selection.danMCaiChampions` 不含 9001；冠军同步与 `publish-web-model` 只改 `models`，不改此项。冠军更换时 `validateCatalog` 会拒绝底座不是现任冠军的 `defaultChoice`，须单独决定：删掉该字段回到新冠军，或为新冠军另建并验证一个新编号搜索机器人。

**证据范围。**只在“对手全是冠军 017、单局、不进贡”下验证：留出 H4 3,000 副每副 +0.237 [0.208, 0.266]（主报告 71.2）。对真人、真人队友、混合队伍或进贡局都没测过，网页成绩不能写成 +0.237。进贡局会用公开的贡牌、还牌和抗贡信息约束抽样，但这部分本身未经验证。

**预算与回落。**搜索在单独的 `search-worker.mjs` 里运行。按所有者 2026-11-09 的电脑出牌时间规则（“机器人和真人一样是最多60s出牌时间 推理时间最多50s 留出来10s为了万一没推理出来回退出牌用 上一手没成功下一手依然会推理”，`web/src/ai/turn-timing.mjs`），时间从房主上该座位回合开始算（含思考停顿和首次加载）：搜索最迟在 50 秒停下（预算是到 50 秒的剩余时间；中盘、尾盘、电脑、手机相同，此前电脑 3／4 秒、手机 3.5 秒），求解每次 3 秒且不超过剩余时间（与 Node 相同；手机此前 1 秒；被剩余时间截住没解完则整次作废），置换表电脑 30 万项、手机／平板／4 核及以下 10 万项；Worker 硬超时为回合开始后 52 秒；首次加载最多等 10 秒。超时、出错、模型未加载或公开信息矛盾都整次放弃，改出 017 的牌（搜索时已并行算好），不显示“牌桌准备失败”；下一手照常搜索，不会因一次回落而一直回落。Clint 的残局大脑同样遵守：上限 30 秒且不超过 50 秒，超时出只用规则的出法。电脑座位的搜索只有房主（或单机本机）计算，加入者收到出牌事件；出牌评价的搜索在各玩家自己的设备上进行，与电脑搜索共用同一个 `search-worker`，电脑出牌优先（见 [出牌评价](MOVE_COACH.md#对局与资源边界)）。

**一致性。**在预算内完成时，与 Node 研究机器人做同样的决定：主报告第 72 节记录 Node／浏览器逐个比较、回落率和耗时。

**收集身份。**牌谱座位记为 `{id: "9001", sha256: <清单摘要>, version: "v000855042-bsearch1-16d76783"}`。`sha256` 是 `searchBotManifest`（底座 ID／SHA、推断网络 SHA 与特征版本、搜索参数、`search-v1`）JSON 的 SHA-256，不是某个 ONNX 文件，因此记录不会把搜索决定当成纯 017。收集器无需改动。每局随机搜索种子不记录，云端牌谱不能重放搜索。身份按座位、每把固定：搜索超时回落时出的 017 牌仍记为 9001，因为回落是该策略定义的一部分；记录也不区分哪一步回落了。

**更换任何一部分都要新编号。**底座、推断网络、搜索参数或核心代码改变时，新增 `searchBots` 项与新证据，不改旧项。`validateCatalog` 检查：底座存在、非 GuanZero、有冠军门控；推断文件为固定 Release；参数必须等于 `SEARCH_BOT_V1`；编号不与 `models` 冲突；`defaultId` 不得是它，菜单默认 `selection.defaultChoice` 只能是现任冠军或底座等于现任冠军的搜索机器人，并且必须在四项菜单里。推断网络 Release `web-belief-v1-16d76783` 由 `node ai/publishing/publish-belief-asset.mjs --bot=9001 --file=<belief.onnx> --publish` 创建（不覆盖已有 tag，并核对公网 SHA）。

<a id="guanzero-每八小时评测并发布"></a>

## GuanZero 每十二小时评测并发布

本机 io48 每天 America/Toronto 08:00、20:00 取一次快照（自2026-11-09起，旧10:12／22:12取消）。周三10:00固定截止另取最终完整导出，具体日历槽见训练指南。按所有者2026-11-09晚最新要求，Clint（含残局大脑）50场、danMCai冠军500场、danMCai-reason 50场全部完成后，无论输赢，都发布本批实际对战的权重。使用评测目录 `model.onnx` 和 `plan.json` 的版本、步数，在准备和发布两次命令中传入相同的 `--evaluated-suite=<批次目录> --model=<批次目录/model.onnx> --source=guanzero-adp-io48 --version=<plan.modelVersion> --step=<对应步数> --config=<GuanZero配置>`。发布器在创建 Release 前按冻结批次名单核对全部报告：新v3三组共600场（25/250/25对），旧v1/v2各500场仍按原计划；历史两组仍两份、138506五份、186280三份、双方权重、冠军 accept 依据和实际胜负平。机器发布证据保存各对手报告的 SHA-256。上网后的文件再次核对同一个完整 SHA。四席菜单默认由 `selection.defaultChoice` 决定（现为 9001，未设置时为 danMCai 现任冠军），GuanZero 发布不改变它。[本机运行与时间表](../../ai/guanzero/README.md#每十二小时评测)。

## danMCai 冠军定期同步

2026-11-05 所有者最新要求取代“最新导出直接设默认”：定期同步实际冠军与菜单。机器需开机、联网且 Codex 正在运行；没有冠军、菜单或新完成评测证据变化则跳过。失败时保留当前网站，不覆盖附件。

1. 安全同步 main，有用户草稿时使用干净 detached worktree。
2. 只读检查实际训练运行的 `champion/champion.json` 最后两次晋升及对应 accept 门控，核对导出 SHA；当前 Mac 入口为 `ai/danMCai/runs/mac-20261105`，Windows 原运行只读保留。缺少证据时停止，不能用 `models/latest.json` 替代。
3. 已发布的相同 SHA 直接复用。未发布的冠军运行 `node ai/publishing/publish-web-model.mjs --model=<league冠军文件> --source=<实际运行名> --version=<真实版本> --step=<真实步数>` 准备，然后以相同参数加 `--publish`。核对公网 SHA、ONNX 1／3／129 候选输出及浏览器 WASM。归档不会自动更改冠军；同步清单 `source.champion`、`selection.danMCaiChampions`（现任在前）、匹配的 `defaultId` 和门控证据；`selection.defaultChoice`（当前为建在 017 上的 9001）不能自动沿用到新冠军，须按所有者决定删除或换成新冠军上另行验证的搜索机器人。新冠军上没有搜索机器人时，菜单只剩三项，出牌评价也退回冠军值。
4. 运行 `npm test`、`npm run format:check`、相关 Python 测试、`npm run build` 及浏览器验证；更新研究报告与成果索引，直接推送 main，确认 Pages 部署。

训练检出、运行配置、权重和缓冲区不改动，模型二进制不进 Git。清单 `models` 保留完整不可变归档；`selection.danMCaiChampions[0]` 决定菜单中的冠军与 `defaultId`（第二项只作冠军记录），`selection.defaultChoice` 决定新玩家菜单默认。GuanZero 从归档中只取最近注册的一代，新代替换旧代。普通新导出只可归档，不进入danMCai 冠军菜单或覆盖默认值。页面版本包含模型摘要，已开牌局不热切。

部署、开发门控晋升、独立棋力验收是不同结论。保留两代冠军不等于证明所有对手下最强，也不能据此宣称整场 80%。[当前冠军原始记录](../../ai/research/evaluation/champion-selection-mac-20261106/champion.json)及[accept 门控 330](../../ai/research/evaluation/champion-selection-mac-20261106/gate-00330.json)；历史选冠军记录保留原目录。

每次命名或发布策略变化同步中英文 README、相关目录 README、机器人／部署指南与 CHANGELOG。新增 Clint 开发评测证据亦随周期归档，不以有无新权重决定是否更新研究文档。

## 另一台电脑如何加入 bot

先拉取最新 `main`，不要事先抢占归档编号。`--version` 必须填写真实训练检查点名称（如 `v000091092`），它保留在来源记录中；GuanZero 的网页名称由 `source.run` 与 `source.step` 生成。用 `--source=实际训练任务名 --step=实际导出步数`，不要把归档编号当作模型名。在自己的机器运行：

```powershell
node ai/publishing/publish-web-model.mjs --model=D:/your-run/model.onnx --source=guanAI --version=your-checkpoint --config=D:/your-run/web-config.json
# 检查准备结果后，以同样参数加 --publish
```

`web-config.json` 的普通价值网络配置：

```json
{ "stateFeatures": 513, "actionFeatures": 54 }
```

与仓库 GuanZero 编码一致的 LSTM 网络配置：

```json
{ "stateFeatures": 513, "actionFeatures": 54, "history": "guanzero-v1" }
```

输入分别为 `state: [1,513]`、`actions: [N,54]`，LSTM 另需 `history: [1,5,216]`，输出 `values: [N,1]`。动作批次必须动态，所有权重包含在单个 ONNX 内。支持既有 `extraFeatures: 53/61`、提案 Actor 的 `rerankCandidates` 等配置；它们必须与实际导出匹配。不同编码、输入或算法需新增适配器和数值／浏览器检查，不能仅改编号假装兼容。

完成后提交清单及证据，推送 `main`。上传时发现编号冲突就停止并重新同步；不得覆盖他人的 Release、编号或训练数据。没有新模型文件时，只保留接入文档，不创建空占位编号。

## 文件职责

| 文件                                          | 用途                                                          |
| --------------------------------------------- | ------------------------------------------------------------- |
| `web/src/ai/model-catalog.json`               | 编号、默认值、SHA-256、Release 地址、网络配置与来源的唯一清单 |
| `web/src/ai/model-catalog.mjs`                | 校验清单、解析编号和缺省选择                                  |
| `ai/publishing/publish-web-model.mjs`         | 冻结、验证、上传及记录；不自动提交或推送                      |
| `ai/publishing/artifacts.mjs`                 | 构建时获取权重并验证 SHA-256                                  |
| `ai/research/evaluation/web-model-NNN.json`   | 每次真实发布的机器可读证据                                    |
| `ai/research/evaluation/model-artifacts.json` | 权重与网页模型成果索引                                        |

历史风格代码与 `web/src/ai/models.mjs` 的 P0／R1 配置仍服务于可复现研究；大厅、控制器及房间协议使用独立的编号清单，不在编号选择后叠加性格偏好。

## 可选评价的模型

2026-11-09 起出牌评价默认使用菜单中的 danMCai-reason（底座为 `selection.danMCaiChampions[0]` 的搜索机器人，现为 9001）：牌桌剩 21–40 张显示其推断世界推演值、≤20 张显示精确求解值，其余或未完成时显示冠军 `selection.danMCaiChampions[0]` 的网络动作值；与座位选择的托管／电脑模型无关。冠军或推理机器人经现有流程正式发布后，刷新网页即可同步评价身份，页面显示真实名称；不使用普通最新导出冒充冠军。评分只做候选范围内的相对换算，不更改默认模型、性格或机器人动作。[来源、预算与房主许可](MOVE_COACH.md)。

开发评测当前为Clint（含残局大脑）50场、真实danMCai冠军500场、danMCai-reason 50场，共600场；逐组核对25/250/25对、完整SHA、门控、种子和源码指纹。被所有者取消的批次不可发布；历史500场、rules-only Clint与原版机器人保留原标签。详见[GuanZero](../../ai/guanzero/README.md#开发评测对手)。

## 进还贡专项组件（开发中）

`src/ai/tribute-model.json` 独立于主模型菜单，当前默认关闭。共享双头网络只在已批准底座 SHA 的进贡／还贡阶段使用，danMCai 和 GuanZero 各一个输出头；Clint、P0、未验收的新底座和真人选择继续用原流程。Worker 只收到本人手牌和公开贡还上下文，先核对完整权重 SHA，再用单线程 WASM 推理。加载失败或超时回退原贡还，旧房间缺失上下文也回退；不改变打牌网络或评价分数。详见 [专项协议](../../ai/shared/tribute/README.md)。

研究续打教师按 [AGENTS](../../AGENTS.md) 取批次开始时已核验的最新 danMCai 真冠军，普通最新导出不能冒充。专项训练教师与网页接入验收目标分开；此追加要求不改变网页默认模型或菜单。

2026-11-06 窗口结论：未通过预先登记的双头独立门槛，网页保留原贡还行为，候选、数据及负结果保留。 [完整结果](../../ai/research/evaluation/tribute-20261106-final.json)。

## Clint 策略身份

菜单中的 Clint 始终指独立 `rules-v2` 路线；路线名称不固定其全部历史策略。当前源码修订与比较边界见 [规则模块](../src/rule-bot/README.md#公开牌史策略更新) 和 [同步状态](../../ai/research/evaluation/clint-sync-state.json)。更新 Clint 不改菜单、默认或神经网络权重。旧开发／独立成绩继续绑定当时的三个规则源码指纹。

本机GuanZero周期发布持续至所有者授权的2026-11-11 10:00 Toronto训练截止，最后评测与部署在最终完整导出后执行。[活动窗口](../../ai/guanzero/README.md#授权延长窗口)。

## 研究用零 extras 导出

阶段 0.6 可在忽略目录准备保留冠军主干、53×512 全零投影的双输入 ONNX，仅运行发布工具的准备流程，**不传 `--publish`**。它不是新冠军、已训练模型或已发布归档；网页清单与 baseline 均须 SHA 不变。普通 oracle 的 extras 上下文未补齐，进还贡续打明确拒绝此模型。方法与实测分开记录于[分析指南](../../ai/research/ANALYSIS.md)。
