# 网页电脑：Clint、GuanZero 与 danMCai 冠军

大厅按以下顺序显示六项，内部编号只用于归档与房间同步。GuanZero 名称统一使用 `训练任务名-训练版本数值`，例如 `guanzero-adp-gpubatch-44752`，不再使用“步”字或中间圆点。

| 顺序 | 当前选项                                           | 来源                                        |
| ---- | -------------------------------------------------- | ------------------------------------------- |
| 1    | Clint规则机器人                                    | 独立 rules-v2，不使用神经网络               |
| 2–3  | guanzero-adp-io48-135205／guanzero-adp-io48-120154 | GuanZero 最近两代，归档 016／015            |
| 4    | danMCai-v000000000                                 | 原始 P0，归档 001                           |
| 5–6  | danMCai-v000705434／danMCai-v000293055             | danMCai 最近两代实际门控冠军，归档 012／009 |

**默认使用 danMCai-v000705434。** 冠军依据 `champion/champion.json` 的真实晋升历史、accept 门控与完整权重 SHA，不按步数最大排序，也不代表全局最强或独立验收通过。历史模型退出菜单，Release 和实验记录保留归档。首次采用新菜单会使用新的本地偏好键，默认重置为danMCai 冠军；此后玩家选择继续保存。「全部使用danMCai 冠军」可重置四席。

朋友房间由房主设置，加入者只查看。恢复与转单机保留对应电脑选择。Clint 在 Worker 内只接收自己的手牌和公开信息；Clint 决策不加载 ONNX，神经网络分支不叠加 Clint 规则；实际网络决策（包括玩家超时托管）按需加载相应权重。

## 每四小时同步

2026-11-05 所有者最新要求取代“最新导出直接设默认”：定期同步实际冠军与菜单。机器需开机、联网且 Codex 正在运行；没有冠军、菜单或新完成评测证据变化则跳过。失败时保留当前网站，不覆盖附件。

1. 安全同步 main，有用户草稿时使用干净 detached worktree。
2. 只读检查实际训练运行的 `champion/champion.json` 最后两次晋升及对应 accept 门控，核对导出 SHA；当前 Mac 入口为 `ai/danMCai/runs/mac-20261105`，Windows 原运行只读保留。缺少证据时停止，不能用 `models/latest.json` 替代。
3. 已发布的相同 SHA 直接复用。未发布的冠军运行 `node ai/publishing/publish-web-model.mjs --model=<league冠军文件> --source=<实际运行名> --version=<真实版本> --step=<真实步数>` 准备，然后以相同参数加 `--publish`。核对公网 SHA、ONNX 1／3／129 候选输出及浏览器 WASM。归档不会自动更改冠军；同步清单 `source.champion`、`selection.danMCaiChampions`（现任在前）、匹配的 `defaultId` 和门控证据。
4. 运行 `npm test`、`npm run format:check`、相关 Python 测试、`npm run build` 及浏览器验证；更新研究报告与成果索引，直接推送 main，确认 Pages 部署。

训练检出、运行配置、权重和缓冲区不改动，模型二进制不进 Git。清单 `models` 保留完整不可变归档；`selection.danMCaiChampions` 决定本机两代与默认值。GuanZero 从归档中取最近注册的两代，新代只轮换其自身两项。普通新导出只可归档，不进入danMCai 冠军菜单或覆盖默认值。页面版本包含模型摘要，已开牌局不热切。

部署、开发门控晋升、独立棋力验收是不同结论。保留两代冠军不等于证明所有对手下最强，也不能据此宣称整场 80%。[当前冠军原始记录](../../ai/research/evaluation/champion-selection-mac-20261105/champion.json)及[accept 门控 309](../../ai/research/evaluation/champion-selection-mac-20261105/gate-00309.json)；历史选冠军记录保留原目录。

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

出牌评价固定读取 `selection.danMCaiChampions[0]` 的完整danMCai 冠军，与座位选择的托管／电脑模型无关。冠军经现有流程正式发布后，刷新网页即可同步评价身份，页面显示真实版本；不使用普通最新导出冒充冠军。评分仅做网络动作值的候选范围换算，不更改默认模型、性格或机器人动作。[房主许可与分数说明](MOVE_COACH.md)。

开发评测现含随机、original、P0、Clint 与真实 danMCai 冠军，每类默认 500 场，独立补评、历史样本及进度口径见 [GuanZero](../../ai/guanzero/README.md#开发评测对手)。周期同步也归档新协议各对手已完成的逐场证据，核对 250 对／500 场、模型及冠军 SHA、种子和源码指纹；进行中计数不是完成成绩，不影响网页冠军默认。

## 进还贡专项组件（开发中）

`src/ai/tribute-model.json` 独立于六项主模型菜单，当前默认关闭。共享双头网络只在已批准底座 SHA 的进贡／还贡阶段使用，danMCai 和 GuanZero 各一个输出头；Clint、P0、未验收的新底座和真人选择继续用原流程。Worker 只收到本人手牌和公开贡还上下文，先核对完整权重 SHA，再用单线程 WASM 推理。加载失败或超时回退原贡还，旧房间缺失上下文也回退；不改变打牌网络或评价分数。详见 [专项协议](../../ai/shared/tribute/README.md)。

研究续打教师按 [AGENTS](../../AGENTS.md) 取批次开始时已核验的最新 danMCai 真冠军，普通最新导出不能冒充。专项训练教师与网页接入验收目标分开；此追加要求不改变网页默认模型或菜单。

2026-11-06 窗口结论：未通过预先登记的双头独立门槛，网页保留原贡还行为，候选、数据及负结果保留。 [完整结果](../../ai/research/evaluation/tribute-20261106-final.json)。

## Clint 策略身份

菜单中的 Clint 始终指独立 `rules-v2` 路线；路线名称不固定其全部历史策略。当前源码修订与比较边界见 [规则模块](../src/rule-bot/README.md#公开牌史策略更新) 和 [同步状态](../../ai/research/evaluation/clint-sync-state.json)。更新 Clint 不改六项菜单、冠军默认或神经网络权重。旧开发／独立成绩继续绑定当时的三个规则源码指纹。
