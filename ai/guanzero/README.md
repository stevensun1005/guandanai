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

**当前协议（所有者2026-11-10更新）**：只保留danMCai现任门控冠军500场、danMCai-reason200场（250/100对交换阵营，共700场）；Clint退出开发评测。新面板`champion-reason-v4`，reason使用同批冠军种子的前100个。全部必要报告完成才发布同一冻结模型；历史Clint、50场和500场协议保留原计划与实际结果，不改名或拼接冒充新比赛。

直接 `evaluate.mjs` 仅用于普通两组/单组基线；新的两组定时批次必须先登记，再运行本页后述的独立伴随。

```powershell
# 历史rules-only Clint基线，不含残局大脑；当前周期必须用独立伴随
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=250 --opponents=clint,champion
# 仅运行实际门控冠军；权重与 accept 门控证据自动核对
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=250 --opponents=champion
```

每批冻结同一 GuanZero 模型，以及清单中现任 danMCai 冠军的版本、完整 SHA、`champion.json` 和 accept 门控依据。GuanZero和普通冠军组使用贪心网络评分；reason组实际运行冻结的手牌推断、中盘8世界搜索、尾盘PIMC及预算回退（协议v1为桌面3／4秒，v2为每步50秒，见[协议](#danmcai-reason评测协议)），不用普通冠军权重冒充推理。这里测的是本机CPU上的冻结策略，回退率随本机负载变化（v2受影响较小）；不是平板性能验收。双方仅使用自身手牌及公开信息。报告保存实际胜负平、逐场记录、编码／源码指纹和配对种子簇 95% 区间，评测数据不进入训练缓冲区。

### 已运行的冻结训练

不覆盖冻结训练源码或配置，使用独立冻结检出的新版补充进程：

```powershell
node ai/guanzero/training/development-suite.mjs --run=<冻结运行目录> --from-block=3 --guardian-state=<守护状态文件>
```

首次启动冻结当时最新完整导出；之后跟随后续原批次的冻结模型与最终评测。新报告单独写在 `eval/development-500/<快照或批次>/<对手>/`，旧 200 场及旧 `clint/report.json` 保留为历史，不能拼入新样本。新开发种子从 4,200,000,000 起，每批独占 100,000 个种子区间，使用前 250 个；与旧批次种子分开，不能作为未用留出集。每批各对手使用同一模型；当前reason取同批冠军种子的前100个，冠军用全部250个，逐种子交换阵营。

两组同批启动BelowNormal独立进程与单线程CPU ONNX。普通冠军仍从af2a683基线运行，reason从独立新冻结伴随运行。面板分别显示冠军/500、reason/200以及实际胜负平，只有对应组完整完成才计算区间。Clint不再启动；旧报告保留。指纹、配对种子和同一冻结SHA一致才续跑。整批取消用cancelled.json，单独退休Clint的468071批使用下文明确修订，不写训练STOP。

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

**当前安排（所有者2026-11-08更新，11月9日追加reason）**：从11月9日起，每天 America/Toronto **08:00、20:00** 冻结模型；旧10:12／22:12触发取消。按当前250/100对协议两组共700场全部完成后发布本批同一权重，发布时间取决于比赛和验证完成时间。

登记器读取运行目录之外的 `work/guanzero/evaluation-schedule.json`，以 `firstAt=2026-11-09T13:00:00.000Z`、12小时间隔建立日历槽，不能继续按训练起点推算。此有限窗口各槽均核对Toronto本地08:00／20:00。新普通索引5130–5134，种子各为 `3700000000 + index * 100000` 起250对；历史索引与报告保留，最终索引5150单列。重复执行复用同槽，未到首个时间拒绝登记，错过两小时不以新权重补旧槽。不得更改冻结训练配置或窗口来调整评测时间。

在 Windows 本机，Codex 十二小时任务先核对活动 launcher、冻结源码、最新发布清单和冠军。使用独立发布检出执行以下命令。登记器以训练槽位和完整 SHA 去重。第 24 小时交给原监督器，对应种子 4,210,000,000–4,210,000,249。窗口其它批次分别使用各自的种子段，第 36、48 小时分别使用索引 5101、5103。

```powershell
node ai/guanzero/training/register-window-suite.mjs C:/guandan-sampler/work/guanzero/dashboard-launcher.json
```

对已登记且还有未完成报告的批次，先核对 development-500/.lock 的 PID。等待存活评测退出后，在HEAD等于该批 `plan.evaluationRuntime.commit` 的冻结伴随检出执行以下命令（通常即 reason-evaluation-launcher.sourceRoot；切换到v2后，未完成的v1批次仍用保留的 `reason-evaluation-launcher.v1-ce55b74.json` 所指ce55b74检出，见[切换到v2](#切换到v2guanzero本机)），--baseline-root保留原af2a683检出，并核对 status.json 的 PID 和逐对手实际进度。历史第24小时使用登记器的 `--arm-midpoint` 单次等待模式，在第 24 小时前约 30 秒预登记本批对手名单与快照。原监督器到点复用同一具名文件和计划。中点已完成，不再启动等待进程。若错过取样时段，记录漏测原因。同一个十二小时任务按该批冻结名单归档全部报告，然后用本批 model.onnx 发布。发布时以计划、报告、Release 和 Pages 的完整 SHA-256 核对身份。[发布参数](../../web/docs/WEB_MODELS.md#guanzero-每十二小时评测并发布)。

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

当前评测按上述08:00／20:00日历持续至新截止。第48小时是历史中间批次，原有5120等种子槽与报告保留；新日历普通槽5130起，最终5150，与即时5110／5111分开。周三08:00任务完成普通批次后继续跟进10:00正常停训，核对最终完整导出，再登记5150并完成最后一轮冠军500场/reason200场及同权重发布，不等到20:00才登记。Windows恢复任务的重复触发时长和执行时限也延长到新截止，训练STOP与明确错误仍按恢复说明处理。

## danMCai-reason评测协议

**最新v4：`champion-reason-v4`。** 原槽与`plan.pairs=250`不变，`opponents=["champion","reason"]`，`opponentPairs={champion:250,reason:100}`；reason自己的报告是100对/200场及前100个种子，冠军250对/500场。reason策略仍`clint-champion-reason-v2`、50秒推理/60秒出牌/10秒回退预留。新批不冻结或执行Clint。运行外launcher必须指向新独立冻结检出与v4；训练/旧评测源码不更新。

**468071本批退休修订。** 所有者叫停Clint时已有8场，保留其6胜/1负/1平部分进度。原v3计划、冠军500场与reason50场报告不改写；单独`opponent-retirement.json`绑定原计划SHA、模型SHA和两组原始报告SHA，明确只移除Clint要求。该一次性修订只适用于468071/index5132，不是任意批次缺报告都能发布；被整批取消的427033仍不可发布。reason扩为200场适用于新的v4批次；所有者随后明确确认从下一批起200场，本批保留原50场发布，不能把50场标成200场。

**以下v3与v1/v2均为历史协议**，其Clint策略、场数和原始身份按登记时保留。

**历史混合场数面板：`clint-brain-champion-reason-v3`。** `plan.pairs=250` 和总种子槽保持不变，`opponentPairs={clint:25,champion:250,reason:25}`；逐组报告使用自己的pairs、seedEnd、matches，不能把50场填成500场。`plan.reason.protocol`仍为`clint-champion-reason-v2`（50秒搜索规则没有变），面板与reason协议由显式映射校验。新`plan.clint`冻结`rules-v2-brain-v1`、30秒大脑预算、40个世界/0.2级改牌阈值、公开贡还牌重建和静态源码闭包；运行实际网页`decideClintRule(ruleObservation(...), WEB_BRAIN)`，只接收自己的牌与公开信息。每场保存brain调用/完成/回退/改牌/耗时，全组保存汇总。普通冠军仍固定af2a683、纯网络贪心。

所有者已叫停427033旧v2批次：Clint与冠军各500场完整报告保留，reason仅264场进度原样归档，`cancelled.json`明确不可发布。伴随跳过已取消批次，发布器拒绝它，不改旧计划、不补齐或截取前50场冒充新协议。今后如再次取消，只停经身份核对的评测进程，确认退出后写评测取消标记；不触碰训练STOP。

切换新协议使用新的独立冻结检出，把运行外`reason-evaluation-launcher.json`的sourceRoot/commit/opponentPanel切到该检出与v3，并保留af2a683 baselineRoot/commit；不要拉取或编辑旧运行检出。登记器从该冻结检出同时冻结reason和Clint。面板也需独立升级以显示各组不同总数和取消状态。下一正常槽08:00取样，不倒填已取消的20点槽；时刻与周三10点截止不变。

以下是**历史v1/v2的500/500/500场协议与切换步骤**，仅供复现；新批次以上述v3为准。

reason面板有两个协议，对手列表都严格为 `["clint","champion","reason"]`，只有reason组的时间规则不同：`clint-champion-reason-v1`（2026-11-09登记，桌面预算3／4秒，已登记批次保持v1）和 `clint-champion-reason-v2`（所有者2026-11-09要求，每步50秒推理上限，见下文；从新伴随检出接管后登记的批次使用）。历史 `clint-champion-v1` 两组、`random-clint-champion-v1` 三组及未标记的五组保持原名单与原报告，不追加或改写历史成绩。首个新槽为11月9日20:00，后续仍为每天Toronto08:00/20:00；本次不额外启动即时正式500场。

登记器还读取训练运行之外的 `work/guanzero/reason-evaluation-launcher.json`，从其独立冻结源码冻结推理身份；该文件的 `sourceRoot/commit` 标明新伴随检出，`baselineRoot/baselineCommit` 保留af2a683。不更新主训练或旧冻结检出。运行新伴随的 `development-suite.mjs --run=<活动运行> --champion-root=<发布检出> --baseline-root=<af2a683冻结检出> --once`；三组工作器同批启动，各自断点、逐场结果分开保存。锁和活PID阻止重复启动；禁止用旧伴随直接处理含reason的新计划。

每批 `plan.reason` 固定搜索机器人的完整manifest SHA、冠军底座SHA及accept门控、推断ONNX完整SHA/特征版本、搜索参数、预算、执行策略版本与静态源码闭包；v2身份另含 `protocol: "clint-champion-reason-v2"` 和 `move`（每步规则与回退统计项清单），v1身份不含这两项、字节不变。批次面板由伴随冻结的身份决定（`development-suite.mjs` 的 `reasonPanel`）：v1伴随只能登记v1，v2伴随只能登记v2；launcher若写明 `opponentPanel` 而与伴随不符，登记直接停止。工作器和发布器都要求面板与 `plan.reason` 的协议一致。`reason-belief.onnx`与`champion.onnx`一起复制进本批评测目录，二进制不进Git。当前reason为9001／`danMCai-reason-v000855042`，但登记时按真实现任冠军重新解析，不能永久写死编号代替核验。

策略复用网页 `search/core.mjs`、公开信息payload与推断输入：21–40张8世界、冠军前6＋过牌、net=2；≤20张8世界PIMC、至少4个世界完成；其余张数、预算超时或公开贡还信息矛盾回到同一冠军。**v1**：桌面预算中盘3000ms、尾盘4000ms，每次求解3000ms／150万节点／30万表项；时钟在冠军推理之后开始。这是协议v1登记时的网页桌面预算，固定为 `training/reason.mjs` 的 `REASON_V1_BUDGET`，只用于复现已登记的v1批次（由ce55b74伴随运行）。

**v2**（`REASON_V2_BUDGET`、`REASON_V2_MOVE`）：电脑每步与真人一样最多60秒；推理最晚第50秒停，留10秒给回退出牌；失败不连带。Node评测里没有思考停顿和首次加载等待，所以50秒从这一步决策开始（含冠军推理）计，中盘、尾盘同为50,000ms；每次精确求解上限取 min(3000ms, 距截止剩余时间)：剩余≥3秒用共享求解器（超时或节点上限按Node规则跳过该世界），不足3秒时用只限剩余时间的单次求解器（精确值相同、不共用置换表），它被时钟停下即视为到截止，整次作废出冻结冠军017的那一手；节点上限仍按Node规则跳过。每步各有自己的截止与上下文，某步回退不影响下一步照常搜索；非预算类异常仍直接中止评测、保留现场，不伪装成正常比赛。v2报告的 `policy` 为 `guanzero-greedy-vs-frozen-danmcai-reason-move-deadline-50s` 并含 `opponentPanel`，均进入协议指纹；`searchStats` 除v1各项外还记录 `solverDeadlineCapped`（不足3秒而缩短的求解次数）、`maxSearchMs` 及超过3／10／30秒的搜索数，完成时缺项即报错。

**v2耗时与口径估计（未实测，不是结果）**：ce55b74两场真实权重工程冒烟中，1,143个决策里搜索207次（中盘149、尾盘58），搜索合计47.6秒（平均约0.23秒），2次因3／4秒预算回退（约1%）；网页50秒冒烟耗时中位0.155秒、最长4.28秒。多数搜索1秒内完成，不受上限影响，所以预计v2每批reason组只是适度变慢：按该样本，每场推理约24秒；原回退的约1%搜索改为最多算到50秒，最坏每场多约46秒×回退次数（样本中每场约1次）。但最坏情况很长：每次搜索都可能跑满50秒，一场约百次搜索时理论上限超过一小时，一批可能跨过下一个12小时槽，届时按现有规则等待存活PID退出，不重复启动。v2回退更少，结果受本机负载影响小于v1，但耗时仍随负载变化，超过50秒的搜索照样回退并计数。v1与v2成绩分开报告，不能合并或互相替代。

网页机器人2026-11-09起改为每步50秒属于部署变化；v2是按所有者要求另行登记的评测协议，不改动任何已登记的v1批次。执行时仅自身手牌和公开信息可读，搜索前遮蔽其他手牌；进还贡按现有比赛引擎执行，推理器只接收公开贡还记录。

`reason/report.json`保存完整500场、250交换阵营簇、模型/对手/源码/协议指纹及搜索次数、实际偏离冠军次数、各类回退和耗时。回退次数必须报告，异常不得静默伪装成正常reason比赛。旧独立证据仅覆盖对冠军、无进贡的单局；新完整打A含进贡评测是新的开发证据，不能借用旧+0.237当作预期成绩。

发布器对新批次强制三份完整报告全通过，再发布同一suite/model.onnx，无最低胜率门槛。网页菜单与默认按最新WEB_MODELS维护，当前四项、默认reason，开发评测数量不是网页菜单数量。实现、发布策略及本机接入检查保存在研究报告与工程验证记录。

历史本机三组评测源码冻结于 `guanzero-reason-eval-runtime` 的ce55b74（协议v1）；8770只读面板使用 `dashboard-launcher.dashboardSourceRoot` 指向的独立 `guanzero-reason-dashboard-runtime`（28b1317）。面板升级仅换面板检出/进程，不能向评测或训练冻结检出拉代码。面板按 `plan.opponents` 和 `plan.reason.name` 显示，不检查面板标识，v2批次无需升级面板。

### 切换到v2（GuanZero本机）

v2只能通过新的冻结伴随检出启用；不向ce55b74、af2a683、28b1317或训练检出拉代码，不改已登记计划、报告与断点。下文 `<X>` 为推送到 `main`、含 `REASON_V2_BUDGET` 的完整提交SHA，`<活动运行>`、`<发布检出>`、`<af2a683冻结检出>` 同上节。

1. **发布检出**更新到 `<X>` 或更新的 `main`（发布前本来就要更新）。新登记器从冻结身份取面板，launcher仍指向ce55b74时照样登记v1，所以这一步可以先做；发布器同时核验v1、v2批次。核对：`git -C <发布检出> merge-base --is-ancestor <X> HEAD`。
2. **安装新伴随**（新目录，不覆盖旧伴随）：`git -C <发布检出> worktree add --detach C:/guandan-sampler/work/guanzero-reason-v2-eval-runtime <X>`，进入该目录 `npm ci`，确认 `git rev-parse HEAD` 等于 `<X>`，再运行 `node --test ai/guanzero/tests/guanzero-reason.test.mjs`。任一步失败就保持launcher不变（下一槽仍登记v1），记录原因，不登记v2。
3. **检查v1批次**：读 `<活动运行>/eval/development-500/manifest.json`，对每个 `opponentPanel` 为 `clint-champion-reason-v1` 的批次核对三份 `report.json` 是否完整（统一面板或 `status.json`）。
   - 全部完成：直接进行第4步。
   - **有v1批次正在评测或未完成**：不停止、不重启、不改动它；它继续由ce55b74伴随（`development-500/.lock` 的PID）完成，断点只能由ce55b74续跑。新伴随遇到未完成的v1批次会以 “pinned to evaluator ce55b74…” 拒绝，不会接手。第4步可以照常做（登记与评测分开），但第6步要等该v1批次三份报告完成、旧伴随PID退出后再做。旧伴随完成v1后若遇到已登记的v2计划，会以 “Unknown GuanZero opponent panel” 停下，这是预期：确认v1三份报告完整即可，v1按原计划和原报告发布。若v1批次未完成而旧伴随PID已不存活（停机、重启等），在第4步之后也只能在ce55b74伴随目录（`reason-evaluation-launcher.v1-ce55b74.json` 的 `sourceRoot`）用同一命令续跑，不能按切换后的 `reason-evaluation-launcher.sourceRoot` 启动；伴随按清单顺序处理批次，未完成的v1会挡住其后的v2批次，直到v1三份报告完成。
4. **切换launcher**（不在登记进行中操作：`development-500/.window-registration.lock` 不存在时）：把 `C:/guandan-sampler/work/guanzero/reason-evaluation-launcher.json` 原样复制为 `reason-evaluation-launcher.v1-ce55b74.json` 保留，再把原文件改为 `sourceRoot` = 新伴随目录、`commit` = `<X>`，`baselineRoot`／`baselineCommit` 保持af2a683不变，并新增 `"opponentPanel": "clint-champion-reason-v2"` 与 `"effectiveFrom": "<下一槽时间>"`（`opponentPanel` 由登记器核对；`effectiveFrom` 只作记录，代码不读取）。
5. **下一槽登记**照旧在发布检出运行 `register-window-suite.mjs`。核对新 `plan.json`：`opponentPanel` 为 `clint-champion-reason-v2`、`reason.protocol` 相同、`reason.budget` 为 `{midgameMs:50000,endgameMs:50000,solverMs:3000,solverTable:300000}`、`reason.move` 存在、`evaluationRuntime.commit` = `<X>`、`baselineCommit` = af2a683。不符就停下保留现场，不改计划补救。
6. **启动评测**：确认没有存活的旧伴随PID后，在新伴随目录运行 `node ai/guanzero/training/development-suite.mjs --run=<活动运行> --champion-root=<发布检出> --baseline-root=<af2a683冻结检出> --once`。Clint与普通冠军两组仍由af2a683计算，只有reason组按v2运行。
7. **记录**：新增接入证据（旧／新launcher SHA-256、`<X>`、首个v2批次ID与时间、新伴随测试结果）；v1批次报告、计划和已发布记录保持原样，表格按协议分别标注。以后再改预算须登记v3，不就地修改v2。
