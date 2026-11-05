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
