# GuanZero 模型

与danMCai 模型分开的训练路线。网络接收当前观察、候选动作和公开出牌历史，方法与实测以[研究报告第 13 节](../research/MODEL_STUDY.md#13-guanzero从随机初始化开始的-dmc-对照实验)为准。

| 找什么                 | 位置                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| 网络结构、优化器与导出 | [training/model.py](training/model.py)                                                                         |
| 训练启动与进程管理     | [training/run.mjs](training/run.mjs)                                                                           |
| 学习器                 | [training/learner.py](training/learner.py)                                                                     |
| 采样器                 | [training/actor.mjs](training/actor.mjs)                                                                       |
| GPU 推理服务及客户端   | [training/inference.py](training/inference.py)、[training/inference-client.mjs](training/inference-client.mjs) |
| 公开历史编码           | [training/history.mjs](training/history.mjs)、[training/history_reference.py](training/history_reference.py)   |
| 评测                   | [training/evaluate.mjs](training/evaluate.mjs)                                                                 |
| 训练面板               | [training/dashboard.mjs](training/dashboard.mjs)、[training/dashboard](training/dashboard)                     |
| 测试                   | [tests](tests)                                                                                                 |

新运行默认放在 `ai/guanzero/runs/`，大权重和缓冲区不进入 Git。根目录使用 `npm run train:guanzero` 或 `npm run train:guanzero:dashboard`。

另一台电脑若仍在训练，先保留当前冻结源码检出，再升级目录；不要在运行中把新路径代码直接覆盖进去。[具体迁移步骤](../research/STRUCTURE_MIGRATION.md)。

网页名称统一使用 `训练任务名-版本数值`，如 `guanzero-adp-gpubatch-44752`。网页菜单 2026-11-09 起只保留最新一代 GuanZero（新代替换旧代，旧代归档），默认为 danMCai-reason（现任冠军加推断搜索）；[当前菜单](../../web/docs/WEB_MODELS.md) 为唯一版本入口。GuanZero 的训练量与开发结果不能直接等同原论文或独立验收成绩。

## 后续训练方案（待验证）

参考danMCai长期计划的[GuanZero适用性评审](../research/GUANZERO_NEXT_STAGE_REVIEW_20261109.md)：先明确短历史中的pass/补位与座位，再验证手牌推断和训练对手分布，最后考虑独立尾盘修正。当前已有20槽历史与单次消费FIFO，不能把其他模型的诊断直接当作本机瓶颈。该文档是新试验建议，尚未启动新运行。

## 开发评测对手

从2026-11-09晚批开始，默认三对手：Clint规则机器人（`clint`，`rules-v2`）、danMCai 现任门控冠军（`champion`）、该冠军上的 danMCai-reason（`reason`）。每类默认 **250 对种子、交换阵营共 500 场完整比赛**，三类合计 **1,500场**。同一批共用同一份GuanZero冻结权重和种子。历史五对手计划继续独立保存 original 和 P0 的成绩。

直接 `evaluate.mjs` 仅用于普通两组/单组基线；新的三组定时批次必须先登记，再运行本页后述的独立伴随。

```powershell
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=250 --opponents=clint,champion
# 仅运行实际门控冠军；权重与 accept 门控证据自动核对
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=250 --opponents=champion
```

每批冻结同一 GuanZero 模型，以及清单中现任 danMCai 冠军的版本、完整 SHA、`champion.json` 和 accept 门控依据。GuanZero和普通冠军组使用贪心网络评分；reason组实际运行冻结的手牌推断、中盘8世界搜索、尾盘PIMC及桌面预算回退，不用普通冠军权重冒充推理。这里测的是本机CPU上的冻结桌面策略，回退率随本机负载变化；不是平板性能验收。双方仅使用自身手牌及公开信息。报告保存实际胜负平、逐场记录、编码／源码指纹和配对种子簇 95% 区间，评测数据不进入训练缓冲区。

### 已运行的冻结训练

不覆盖冻结训练源码或配置，使用独立冻结检出的新版补充进程：

```powershell
node ai/guanzero/training/development-suite.mjs --run=<冻结运行目录> --from-block=3 --guardian-state=<守护状态文件>
```

首次启动冻结当时最新完整导出；之后跟随后续原批次的冻结模型与最终评测。新报告单独写在 `eval/development-500/<快照或批次>/<对手>/`，旧 200 场及旧 `clint/report.json` 保留为历史，不能拼入新样本。新开发种子从 4,200,000,000 起，每批独占 100,000 个种子区间，使用前 250 个；与旧批次种子分开，不能作为未用留出集。每批各对手使用相同种子和同一模型，按种子交换阵营。

三组在同一批次分别启动BelowNormal独立进程、CPU单线程ONNX会话。Clint与普通冠军继续从原af2a683冻结评测器调用；reason从独立的新冻结伴随检出运行，不使用训练GPU。统一只读面板显示每类实际完成数／500、排队／进行中／完成、具体对手版本及实际胜负平；置信区间仅在该对手 500 场完成后计算。指纹、种子和冻结权重完全一致时可从已完成的配对断点续跑，变更或损坏则停止并保留现场。`.lock` 防止重复进程；`status.json` 保存错误与状态。仅停止补充进程可创建 `eval/development-500/STOP`，不要误写训练根目录的 STOP。旧的 Clint-only 补评入口保留用于历史协议复现。

### 面板中的评测模型名

评测表以 `实际训练任务名-实际导出版本数值 / 对手` 显示，例如 `guanzero-adp-gpubatch-78087 / 随机出牌`；完成进度和历史样本量单独显示，不把 `block-NNNN` 或“500场协议”作为模型名称。版本对应该行冻结权重，不能直接套用网页当前版本或学习器最新步数。

新面板可用 `--model-identities=<运行目录以外的显示缓存.json>` 只读扫描保留的完整 ONNX，按完整 SHA 保存导出文件名与真实步数，每 30 秒补充映射；缓存不在训练目录中，不改配置、权重、计划或评测报告。已记录的冻结 `model-NNNN` 名称仍可使用。旧批次若只保留权重、版本记录缺失且原导出已删除，后缀改为该权重 SHA 的前 12 位；这不是猜测训练步数，批次编号仍仅保留在证据中。训练与评测继续使用各自冻结检出，面板可独立升级。

## 本地固定窗口续训

恢复前核对模型、RMSprop 状态、分片游标与每个采样槽位的 nextSeed。新目录复制 state.pt 和 actor 状态，同卷可为已关闭父运行的不可变分片建立硬链接。旧分片继续保存在原目录。migration.json 记录父运行、步数和检查点 SHA-256，监督器在创建子运行配置时核验该指纹。

学习器按发布时间和文件名为已发布的一批分片建立 FIFO 索引。每次更新将模型、优化器和样本位置一起原子保存，然后清理耗尽的本地分片和内存游标。索引剩余样本不足一批时重新发现新分片。已索引分片超过 4096 或磁盘可用空间低于 8 GiB 时，采样器暂缓领取下一个种子。

在已准备并验证的独立目录使用 `train:guanzero` 的 `--hours=48 --midpoint-five --midpoint-seed-index=5100 --champion-root=<发布工作树>` 及原训练参数。window.json 固定首次起点、中点和截止时间，恢复沿用原窗口。到中点时先冻结具名导出，再核验发布工作树当前冠军的 accept 依据和完整 SHA。新批次四类对手各 250 对交换阵营种子、500 场完整比赛，进度与结果写在 eval/development-500。本次窗口使用 4,210,000,000 起的开发种子，未来独立窗口应另行分配区间。

## 独立进还贡专项

GuanZero 可使用 [共享专项网络](../shared/tribute/README.md) 的第二输出头；它不是主 LSTM 的权重合并，不干预当前续训。只在进还贡阶段、固定 SHA 底座验收通过后启用，不改变普通出牌策略。

进还贡专项标签的续打教师统一采用 danMCai 真冠军；GuanZero 是单独的接入验收对象，不把其普通导出称作冠军。主训练对手池保持冻结，详见 [专项协议](../shared/tribute/README.md)。

<a id="每八小时评测"></a>

## 每十二小时评测

历史安排：本次本地 io48 窗口最初以训练起点计时。第 8 小时的批次按追加要求在 Toronto 11 月 6 日 09:38 用当时最新完整导出 138506 启动。改为十二小时周期时，已启动的 138506 作为首批。接下来在训练第 24、36、48 小时取样，对应 Toronto 11 月 6 日 22:12、7 日 10:12 和 7 日 22:12 左右。最后一批等训练正常退出后读取最终完整导出。138506 按登记时的五组完成；186280 按三组完成；后续两个对手为 Clint 和获 accept 的 danMCai 冠军，各 250 对交换阵营、500 场。仅从完整逐场报告计算成绩。

**当前安排（所有者2026-11-08更新，11月9日追加reason）**：从11月9日起，每天 America/Toronto **08:00、20:00** 冻结模型；旧10:12／22:12触发取消。三组各500场全部完成后发布本批同一权重，发布时间取决于比赛和验证完成时间。

登记器读取运行目录之外的 `work/guanzero/evaluation-schedule.json`，以 `firstAt=2026-11-09T13:00:00.000Z`、12小时间隔建立日历槽，不能继续按训练起点推算。此有限窗口各槽均核对Toronto本地08:00／20:00。新普通索引5130–5134，种子各为 `3700000000 + index * 100000` 起250对；历史索引与报告保留，最终索引5150单列。重复执行复用同槽，未到首个时间拒绝登记，错过两小时不以新权重补旧槽。不得更改冻结训练配置或窗口来调整评测时间。

在 Windows 本机，Codex 十二小时任务先核对活动 launcher、冻结源码、最新发布清单和冠军。使用独立发布检出执行以下命令。登记器以训练槽位和完整 SHA 去重。第 24 小时交给原监督器，对应种子 4,210,000,000–4,210,000,249。窗口其它批次分别使用各自的种子段，第 36、48 小时分别使用索引 5101、5103。

```powershell
node ai/guanzero/training/register-window-suite.mjs C:/guandan-sampler/work/guanzero/dashboard-launcher.json
```

对已登记且还有未完成报告的批次，先核对 development-500/.lock 的 PID。等待存活评测退出后，在 reason-evaluation-launcher.sourceRoot 指向的新冻结伴随检出执行以下命令，--baseline-root保留原af2a683检出，并核对 status.json 的 PID 和逐对手实际进度。历史第24小时使用登记器的 `--arm-midpoint` 单次等待模式，在第 24 小时前约 30 秒预登记本批对手名单与快照。原监督器到点复用同一具名文件和计划。中点已完成，不再启动等待进程。若错过取样时段，记录漏测原因。同一个十二小时任务按该批冻结名单归档全部报告，然后用本批 model.onnx 发布。发布时以计划、报告、Release 和 Pages 的完整 SHA-256 核对身份。[发布参数](../../web/docs/WEB_MODELS.md#guanzero-每十二小时评测并发布)。

```powershell
node ai/guanzero/training/development-suite.mjs --run=C:/guandan-sampler/work/guanzero/guanzero-adp-io48 --champion-root=C:/guandan-sampler/work/guanzero-web-release --baseline-root=C:/guandan-sampler/work/guanzero-io48-runtime --once
```

## 自动恢复

本机 io48 使用独立 Windows 计划任务 `GuanZero-io48-Recovery` 运行 `training/watchdog.mjs`。任务每分钟触发并以 IgnoreNew 保护单实例；运行中的恢复器每 15 秒核对监督器。训练监督器负责学习器、推理服务和采样进程的重启。系统登录后也可触发任务。

监督器意外退出时，恢复器核对同一运行目录的进程身份，等候 30 秒后清理确实失去监督器的同运行采样／学习进程。随后读取完整 state.pt，核对模型、优化器、步数、使用样本和游标，再从原冻结检出启动 run.mjs。该入口再次校验冻结源码。失败使用有上限的重试间隔。

原始 config.json 与 window.json 在恢复期间按完整 SHA 核验。训练根目录 STOP、学习器明确错误和原固定截止均结束自动恢复。故障耗时计入现有窗口。需要人工停止时，可禁用计划任务或使用训练原有 STOP 流程。恢复器状态和日志位于 work/guanzero/watchdog-io48，训练数据由原运行目录保存。

隔离模拟进程实测检查点继承、监督器存活时跳过、进程退出后恢复及 STOP 分支。本机当前运行通过只读健康检查接入，实际任务状态与首次进度另记研究证据。

## 授权延长窗口

所有者于11月7日明确延长当前io48运行至 Toronto 11月11日周三上午10:00，即15:00UTC。window.json保留原起点与已完成中点，extension记录旧截止和授权时间。监督器读取启动时的截止，因此延期通过一次检查点停机恢复切换生效。原始训练配置、优化器和采样游标继续沿用。

当前评测按上述08:00／20:00日历持续至新截止。第48小时是历史中间批次，原有5120等种子槽与报告保留；新日历普通槽5130起，最终5150，与即时5110／5111分开。周三08:00任务完成普通批次后继续跟进10:00正常停训，核对最终完整导出，再登记5150并完成最后一轮三对手各500场及同权重发布，不等到20:00才登记。Windows恢复任务的重复触发时长和执行时限也延长到新截止，训练STOP与明确错误仍按恢复说明处理。

## danMCai-reason评测协议

新批次面板标识 `clint-champion-reason-v1`，对手列表严格为 `["clint","champion","reason"]`。历史 `clint-champion-v1` 两组、`random-clint-champion-v1` 三组及未标记的五组保持原名单与原报告，不追加或改写历史成绩。首个新槽为11月9日20:00，后续仍为每天Toronto08:00/20:00；本次不额外启动即时正式500场。

登记器还读取训练运行之外的 `work/guanzero/reason-evaluation-launcher.json`，从其独立冻结源码冻结推理身份；该文件的 `sourceRoot/commit` 标明新伴随检出，`baselineRoot/baselineCommit` 保留af2a683。不更新主训练或旧冻结检出。运行新伴随的 `development-suite.mjs --run=<活动运行> --champion-root=<发布检出> --baseline-root=<af2a683冻结检出> --once`；三组工作器同批启动，各自断点、逐场结果分开保存。锁和活PID阻止重复启动；禁止用旧伴随直接处理含reason的新计划。

每批 `plan.reason` 固定搜索机器人的完整manifest SHA、冠军底座SHA及accept门控、推断ONNX完整SHA/特征版本、搜索参数、桌面预算、执行策略版本与静态源码闭包。`reason-belief.onnx`与`champion.onnx`一起复制进本批评测目录，二进制不进Git。当前reason为9001／`danMCai-reason-v000855042`，但登记时按真实现任冠军重新解析，不能永久写死编号代替核验。

策略复用网页 `search/core.mjs`、公开信息payload与推断输入：21–40张8世界、冠军前6＋过牌、net=2；≤20张8世界PIMC、至少4个世界完成；其余张数、预算超时或公开贡还信息矛盾回到同一冠军。桌面预算中盘3000ms、尾盘4000ms，每次求解3000ms／150万节点／30万表项。执行时仅自身手牌和公开信息可读，搜索前遮蔽其他手牌；进还贡按现有比赛引擎执行，推理器只接收公开贡还记录。

`reason/report.json`保存完整500场、250交换阵营簇、模型/对手/源码/协议指纹及搜索次数、实际偏离冠军次数、各类回退和耗时。回退次数必须报告，异常不得静默伪装成正常reason比赛。旧独立证据仅覆盖对冠军、无进贡的单局；新完整打A含进贡评测是新的开发证据，不能借用旧+0.237当作预期成绩。

发布器对新批次强制三份完整报告全通过，再发布同一suite/model.onnx，无最低胜率门槛。网页菜单与默认按最新WEB_MODELS维护，当前四项、默认reason，开发评测数量不是网页菜单数量。实现、发布策略及本机接入检查保存在研究报告与工程验证记录。
