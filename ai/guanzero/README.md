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

网页名称统一使用 `训练任务名-版本数值`，如 `guanzero-adp-gpubatch-44752`。网页只保留最近两代 GuanZero，默认仍为danMCai 门控冠军；[当前菜单](../../web/docs/WEB_MODELS.md) 为唯一版本入口。GuanZero 的训练量与开发结果不能直接等同原论文或独立验收成绩。

## 开发评测对手

默认对手为随机出牌（`random`）、原版规则（`rule`，`original`）、P0（`p0`）、Clint规则机器人（`clint`，`rules-v2`）和 danMCai 现任门控冠军（`champion`）。每类默认 **250 对种子、交换阵营共 500 场完整比赛**，五类合计计划 2,500 场。原版规则与 Clint 分开记录。

```powershell
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=250
# 仅运行实际门控冠军；权重与 accept 门控证据自动核对
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=250 --opponents=champion
```

每批冻结同一 GuanZero 模型，以及清单中现任 danMCai 冠军的版本、完整 SHA、`champion.json` 和 accept 门控依据。神经网络均为候选动作上的贪心评分，不叠加网页风格或残局搜索；这是冻结冠军权重的对战，不等同整套网页策略的验收。双方仅使用自身手牌及公开信息。报告保存实际胜负平、逐场记录、编码／源码指纹和配对种子簇 95% 区间，评测数据不进入训练缓冲区。

### 已运行的冻结训练

不覆盖冻结训练源码或配置，使用独立冻结检出的新版补充进程：

```powershell
node ai/guanzero/training/development-suite.mjs --run=<冻结运行目录> --from-block=3 --guardian-state=<守护状态文件>
```

首次启动冻结当时最新完整导出；之后跟随后续原批次的冻结模型与最终评测。新报告单独写在 `eval/development-500/<快照或批次>/<对手>/`，旧 200 场及旧 `clint/report.json` 保留为历史，不能拼入新样本。新开发种子从 4,200,000,000 起，每批独占 100,000 个种子区间，使用前 250 个；与旧批次种子分开，不能作为未用留出集。每批五类使用相同种子和同一模型，按种子交换阵营。

补充进程以 BelowNormal 优先级、最多两个单线程 CPU 推理会话运行，不使用训练 GPU。面板显示每类实际完成数／500、排队／进行中／完成、具体冠军版本及阶段胜率；置信区间仅在该对手 500 场完成后计算。指纹、种子和冻结权重完全一致时可从已完成的配对断点续跑，变更或损坏则停止并保留现场。`.lock` 防止重复进程；`status.json` 保存错误与状态。仅停止补充进程可创建 `eval/development-500/STOP`，不要误写训练根目录的 STOP。旧的 Clint-only 补评入口保留用于历史协议复现。

### 面板中的评测模型名

评测表以 `实际训练任务名-实际导出版本数值 / 对手` 显示，例如 `guanzero-adp-gpubatch-78087 / 随机出牌`；完成进度和历史样本量单独显示，不把 `block-NNNN` 或“500场协议”作为模型名称。版本对应该行冻结权重，不能直接套用网页当前版本或学习器最新步数。

新面板可用 `--model-identities=<运行目录以外的显示缓存.json>` 只读扫描保留的完整 ONNX，按完整 SHA 保存导出文件名与真实步数，每 30 秒补充映射；缓存不在训练目录中，不改配置、权重、计划或评测报告。已记录的冻结 `model-NNNN` 名称仍可使用。旧批次若只保留权重、版本记录缺失且原导出已删除，后缀改为该权重 SHA 的前 12 位；这不是猜测训练步数，批次编号仍仅保留在证据中。训练与评测继续使用各自冻结检出，面板可独立升级。

## 本地固定窗口续训

恢复前核对模型、RMSprop 状态、分片游标与每个采样槽位的 nextSeed。新目录复制 state.pt 和 actor 状态，同卷可为已关闭父运行的不可变分片建立硬链接。旧分片继续保存在原目录。migration.json 记录父运行、步数和检查点 SHA-256，监督器在创建子运行配置时核验该指纹。

学习器按发布时间和文件名为已发布的一批分片建立 FIFO 索引。每次更新将模型、优化器和样本位置一起原子保存，然后清理耗尽的本地分片和内存游标。索引剩余样本不足一批时重新发现新分片。已索引分片超过 4096 或磁盘可用空间低于 8 GiB 时，采样器暂缓领取下一个种子。

在已准备并验证的独立目录使用 `train:guanzero` 的 `--hours=48 --midpoint-five --midpoint-seed-index=5100 --champion-root=<发布工作树>` 及原训练参数。window.json 固定首次起点、中点和截止时间，恢复沿用原窗口。到中点时先冻结具名导出，再核验发布工作树当前冠军的 accept 依据和完整 SHA。五类对手各 250 对交换阵营种子、500 场完整比赛，进度与结果写在 eval/development-500。本次窗口使用 4,210,000,000 起的开发种子，未来独立窗口应另行分配区间。

## 独立进还贡专项

GuanZero 可使用 [共享专项网络](../shared/tribute/README.md) 的第二输出头；它不是主 LSTM 的权重合并，不干预当前续训。只在进还贡阶段、固定 SHA 底座验收通过后启用，不改变普通出牌策略。

进还贡专项标签的续打教师统一采用 danMCai 真冠军；GuanZero 是单独的接入验收对象，不把其普通导出称作冠军。主训练对手池保持冻结，详见 [专项协议](../shared/tribute/README.md)。

## 每八小时评测

本次本地 io48 窗口以训练起点计时。第 8 小时的批次按追加要求在 Toronto 11 月 6 日 09:38 用当时最新完整导出 138506 启动。接下来在训练第 16、24、32、40、48 小时取样，对应 Toronto 11 月 6 日 14:12、22:12 和 7 日 06:12、14:12、22:12 左右。最后一批等训练正常退出后读取最终完整导出。每批五个对手为随机、原版规则、P0、Clint 和获 accept 的 danMCai 冠军，各 250 对交换阵营、500 场。仅从完整逐场报告计算成绩。

在 Windows 本机，Codex 八小时任务先核对活动 launcher、冻结源码、最新发布清单和冠军。使用独立发布检出执行以下命令。登记器以训练槽位和完整 SHA 去重。第 24 小时交给原监督器，对应种子 4,210,000,000–4,210,000,249。窗口其它批次分别使用各自的种子段，各段起点相隔 100,000。

```powershell
node ai/guanzero/training/register-window-suite.mjs C:/guandan-sampler/work/guanzero/dashboard-launcher.json
```

对已登记且还有未完成报告的批次，先核对 development-500/.lock 的 PID。等待存活评测退出后，在 dashboard-launcher.sourceRoot 指向的原冻结检出执行以下命令，并核对 status.json 的 PID 和逐对手实际进度。第 24 小时只检查原监督器。若错过取样时段，记录漏测原因。同一个八小时任务归档五份完整报告，然后用本批 model.onnx 发布。发布时以计划、报告、Release 和 Pages 的完整 SHA-256 核对身份。[发布参数](../../web/docs/WEB_MODELS.md#guanzero-每八小时评测并发布)。

```powershell
node ai/guanzero/training/development-suite.mjs --run=C:/guandan-sampler/work/guanzero/guanzero-adp-io48 --champion-root=C:/guandan-sampler/work/guanzero-web-release --once
```
