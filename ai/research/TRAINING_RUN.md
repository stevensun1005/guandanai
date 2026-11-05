# 主策略训练记录

本文保存历史训练过程、阶段参数和原始实验口径，不代表当前默认模型或当前运行。现行入口见 [danMCai 持续训练](CONTINUOUS_TRAINING.md)、[GuanZero](../guanzero/README.md) 和 [网页菜单／发布](../../web/docs/WEB_MODELS.md)；最新研究结论以 [主报告](MODEL_STUDY.md) 为准。

这轮训练的目标是让新策略对项目原有规则机器人达到 **80% 以上的胜率**。这是待验证的目标，不是当前模型的成绩。

**当前验收按赢下从打 2 到通过 A 的完整比赛计算，平局也计入总场次。**本文保留各阶段的训练入口、历史协议和已记录结果；当前方法与结论以[模型研究报告](./MODEL_STUDY.md)为准，完成量以[机器可读进展](./evaluation/model-study-progress.json)为准。只有新的独立整场对战确认提升，才考虑更换默认网页权重。早期单把成绩不能直接与整场胜率比较。

## 已公开的有限实验状态

下表对应已合入 `main` 的实验记录，不描述其他工作树中尚未公开的进行中开发。训练量表示实际用于已完成更新的整场轨迹，包含自对弈及有意重复的开局，不等于独立牌副数或独立验收场数。

| 实验                                | 完成更新 | 整场训练轨迹 | 状态                                 |
| ----------------------------------- | -------: | -----------: | ------------------------------------ |
| 整场 PPO／规则对手                  |       16 |        2,048 | 完成                                 |
| 整场 PPO／混合对手                  |       16 |        2,048 | 完成                                 |
| 首轮完整主网                        |        3 |          576 | 因开发对战退步停止；第四次更新未完成 |
| 带保持约束的完整主网                |       16 |        3,072 | 完成                                 |
| 公开／明牌评价 × 新题／重打，小试验 |   每组 4 |   四组共 256 | 完成                                 |
| 相同四组的扩大试验                  |   每组 8 | 四组共 1,024 | 完成                                 |

以上候选均未通过新的独立整场发布验收，默认网页权重未替换。流程检查和历史单把实验另列，不混入本表。检查点入口见[实验成果目录](../danMCai/models/experiments/README.md)及[历史权重索引](./evaluation/model-artifacts.json)。

文中的 `ai/danMCai/data/generated/` 是原训练机器的本地路径，不随克隆自动出现。复现时需按相应脚本重新采样，或根据成果索引取得匹配的检查点；不要把缺少本地文件当成网页运行依赖。

## 早期单把实验口径（已被整场目标替代）

- **对手**：仓库现有 `aiDecide`，完整保留理牌、队友协作、记牌和抽样判断；不是随机出牌机器人。
- **赛制**：两个新模型组成一队，对两个规则机器人。每副牌交换双方，共两局；级牌和先手由固定种子生成。
- **胜负**：先出完牌的玩家所属队伍获胜；同时记录 1／2／3 级的队伍收益。
- **信息**：只能使用自身手牌、公开出牌、剩余张数和级牌。另一队与队友的真实手牌均不可作为模型输入。
- **统计**：以独立牌副为一组计算置信区间，不能把同一副交换座位的两局当成完全独立的样本。
- **范围**：随机级牌的独立单局，不包括连续升级、进还贡和完整打 A 的比赛。整场表现另行验证。

开发对局使用 `21200104` 起的种子；最终验收预留 `21300104` 起的种子，在模型及参数选定之前不读取其结果。训练从 `21100104`、`21110104`、`21120104` 三段互不重叠的种子开始。最终报告必须列出实际模型校验值、对手代码校验值、局数和区间。

## 早期单把残差价值训练

冻结现有主网络的特征提取层，在其最后一层的 512 维表示后接入 53 维公开信息，训练 `565 → 128 → 1` 的残差价值网络。补充输入明确表示当前需要压过的牌、墩主、候选牌型与大小，以及出牌后的手牌结构。

采样混合自对弈和对规则机器人的对局，允许在主策略的前八个候选中小概率探索。每局结束后，按实际队伍结果回填收益：`胜负符号 × (1 + 0.1 × 升级分)`。这是完整对局回报驱动的蒙特卡洛价值学习，不是把教师选牌直接当作正确答案。

胜负在头游产生时就已经确定。因此，只用头游产生前的决策训练争胜策略，之后保留原主策略。训练集和验证集按整局分开，并覆盖自对弈及规则对局的双方座位；不会把同一局的相邻动作拆到不同集合。

预测误差下降不等于胜率提高。候选残差强度必须通过另行运行的开发对局选择，并与原主模型单独对战检查退步。只有最终独立对局达标，才可以把“80%”写成模型成绩。

## 早期单把开发基准

首轮 100 副交换牌局、共 200 局：原主网络获胜 116 局，胜率 **58.0%**，按牌副分组的近似 95% 区间为 **52.30%–63.70%**。这是小规模开发基准，不能替代最终验收。

训练产物先写入忽略提交的 `ai/danMCai/data/generated/`，不自动覆盖网站权重。已完成的训练、浏览器数值、对战与发布状态已记录在下文及研究主报告，原始临时缓冲区仍留在本地。

## 本地实测进展（2026-11-04）

截至这次记录，已完成 30,000 局价值策略采样、40,000 局概率策略训练，以及 12,000 个同局面分支比较样本。分支属于同一副牌的配对比较，不能当成独立新牌局计数。另有本地数值、浏览器与开发对战检查。

在同一组 1,000 副交换牌局、共 2,000 局开发对照中：

| 策略                                 | 对原规则机器人胜率 |
| ------------------------------------ | -----------------: |
| 原主模型                             |             55.90% |
| 第一轮残差模型                       |             57.95% |
| 第二轮残差模型                       |             58.00% |
| 概率策略候选（延长训练第 12 次更新） |             60.60% |
| 同局面分支差值模型                   |             57.55% |

这些是开发成绩，用于选择候选，**没有达到 80% 目标**。最终独立牌局结果另存报告，不能用开发集最高点代替验收。网页当前部署的 1.13.1 只包含激进风格开局炸牌修正，新的学习权重仍在danMCai 实验目录。

## 复现训练与评测

先安装模型依赖和 CPU 训练环境：

```bash
python -m pip install -r ai/environment/requirements-models.txt
python -m pip install torch==2.15.0 --index-url https://download.pytorch.org/whl/cpu
node ai/danMCai/data/tools/collect-policy.mjs --games=4000 --seed=21100104 --opponent=mixed --epsilon=0.15 --temperature=0.35 --inference-script=ai/danMCai/training/policy_learning.py --output=ai/danMCai/data/generated/example-data
python ai/danMCai/training/train_policy.py ai/danMCai/data/generated/example-data --output=ai/danMCai/data/generated/example-model
```

训练概率策略需要指定一个已有的策略模型；每个缓冲区使用同一份行为权重，保存旧概率与价值，更新后采集新牌局：

```bash
python ai/danMCai/training/run-policy-training.py --output=ai/danMCai/data/generated/example-ppo --proposal=ai/danMCai/data/generated/example-model/policy-0.25.onnx --k=4 --cycles=8 --games=1000 --seed=25000104 --opponent=rule
python ai/danMCai/training/export_ppo.py ai/danMCai/data/generated/example-ppo/cycle-08/model/ppo.npz --output=ai/danMCai/data/generated/example-export/strategy.onnx
```

独立对照和浏览器核对：

```bash
node ai/danMCai/evaluation/evaluate-trained.mjs --pairs=1000 --seed=26000104 --inference-script=ai/danMCai/training/ppo_learning.py --model=ai/danMCai/data/generated/example-ppo/cycle-08/model/ppo.npz --output=web/artifacts/validation/example
python web/tests/ppo_browser_smoke.py --checkpoint=ai/danMCai/data/generated/example-ppo/cycle-08/model/ppo.npz --model=ai/danMCai/data/generated/example-export/strategy.onnx --output=web/artifacts/validation/example-browser
```

所有输出目录必须是新目录，避免覆盖已存在的样本。更换模型后应使用新的验收种子。训练、推理和网页运行是分离的：玩家无需安装 Python，实验模型也不会自动替换线上模型。

## 当前局限

- 概率策略在冻结提案的前四个候选之间学习，无法发现提案范围以外的新出法。
- 早期实验以冻结骨干和训练小网络为主，没有宣称完成整个主网络的端到端重训练。
- 公开文本牌谱不包含每个电脑的完整起手，不能据此精确重算某次决策的模型评分。
- 暂未实现完整动作集合上的保守 Q 学习或名次辅助预测；需要独立实验验证，不能把其他游戏的效果直接移植为本项目成绩。

## 首次独立验收

模型在读取验收牌局之前选定，种子 `21300104` 到 `21303103`，共 3,000 副牌交换双方、每模型 6,000 局。

| 模型           |      获胜局数 |   胜率 | 按牌副聚类的 95% 区间 |
| -------------- | ------------: | -----: | --------------------: |
| 原主策略       | 3,354 / 6,000 | 55.90% |         54.80%–57.00% |
| 新概率策略候选 | 3,506 / 6,000 | 58.43% |         57.35%–59.52% |

配对提升 2.53 个百分点，95% 区间 1.17–3.90 个百分点。**80% 验收目标未达到。**开发集的 60.60% 不应当作独立验收成绩。新候选仍未进入默认线上配置。

[机器可读报告](./evaluation/policy-training-heldout-2026-11-04.json)。每局是两名学习策略队友对两名原规则机器人，头游所在队获胜；不是完整打 A 的整场胜率。

随后曾启动额外单把训练，计划 24 次更新、每次 2,000 局，记录在 `ai/danMCai/data/generated/ppo-k4-next/run.json`；该计划在转向整场目标后停止，不能把计划的 48,000 局记为完成量。已有结果保留，后续模型需另选新验收牌局，不能重复使用本次验收集选模。

## 目标修正：按完整比赛学习团队配合

根据玩家进一步明确的目标，先前的“80% 单把头游队胜率”已被替换。新的主指标是**从打 2 到通过 A 的整场队伍胜率**；平局单列，并计入总场次数，不能只统计分出胜负的比赛。历史单把成绩不改写，也不能直接与新指标比较。

训练环境现在完整推进升级、队友名次、下一把进还贡、抗贡和打 A 的失败次数，结算直接使用网页同一份 `web/src/core/match.js`。终局团队获胜、失败、规则定义的平局分别回填 +1、-1、0。没有把“少拆对子”“一定送队友”或“弱牌不能炸”做成策略禁令，也没有为这些具体打法手工加分。它们的好坏由实际后续整场结果体现。

模型在头游出现后继续决策和学习；有机会一次出完时，也保留合法替代动作参与选择。首批 64 场完整训练含 691 把、20,514 条学习决策，其中 3,321 条发生在头游之后。已用这些样本完成参数更新；这是流程与参数更新验证，不是整场棋力提升证明。

```bash
node ai/danMCai/data/tools/collect-matches.mjs --matches=64 --seed=31100104 --output=ai/danMCai/data/generated/full-match-example/data
python ai/danMCai/training/train_ppo.py ai/danMCai/data/generated/full-match-example/data --output=ai/danMCai/data/generated/full-match-example/model
```

这一阶段的整场 Actor 使用神经网络提案的前四个候选，训练没有覆盖所有合法动作；后续完整主网与公开／明牌评价实验改为对生成器提供的全部候选评分。两者不能混为一种训练方法，模型能力也不表示已掌握玩家提出的全部战术。整场检查点包含额外的公开比赛信息，禁止使用旧的单把导出器直接发布。

旧的额外单把训练已停止，已有数据与参数保留。整场规则对抗阶段在 `ai/danMCai/data/generated/full-match-training/run.json` 记录了 16 次完成更新、每次 128 场，共 2,048 条整场训练轨迹。

## 四席自对弈与历史版本对抗

新增 `--opponent=self`：四个席位都由同一份冻结的当前模型按各自信息出牌，各队按最终整场结果获得学习标签。一个模型不能看到其他席位的私牌。

`--opponent=mixed --opponent-model=历史检查点` 按三种对手轮换：当前模型自身、冻结的历史版本、原规则机器人。对历史模型的决策不写入当前模型的学习缓冲区；对规则对手的独立评测也不会用于梯度更新。指标记录双上／双下、孤立头游及头游后决策数量，这些只是分析统计，没有变成打法禁令或手工奖励。

6 场流程检查覆盖三种对手各 2 场，共 69 把、2,566 条决策。已逐条核对整场胜负标签：自对弈中四席均有样本；历史／规则对抗仅当前模型一队的两席有样本，随后完成两轮参数更新。这不属于胜率提升报告。

```bash
python ai/danMCai/training/run-policy-training.py --output=ai/danMCai/data/generated/match-selfplay-example --proposal=ai/danMCai/data/generated/policy-cycle1/model/policy-0.25.onnx --actor=ai/danMCai/data/generated/full-match-training/cycle-04/model/ppo.npz --objective=full-match --opponent=mixed --opponent-model=ai/danMCai/data/generated/full-match-training/cycle-02/model/ppo.npz --cycles=16 --games=128 --seed=34100104 --eval-every=2 --eval-pairs=64 --eval-seed=35110104
```

该混合对抗阶段的记录为 `ai/danMCai/data/generated/match-selfplay-training/run.json`，已完成 16 次更新、每次 128 场，共 2,048 条整场训练轨迹；每两次更新后在另一组固定开发牌局中对原规则机器人评测。实际各周期结果及指纹见研究报告的证据快照。

## 完整主网络的逐步解冻

新的实验分支不再只更新 73,602 参数的策略头。完整价值网络使用 `628 → 512 → 512 → 512 → 512 → 512 → 1`，共 **1,373,185 个参数**。输入包含原有状态、候选动作和公开的当前牌型／整场进度；不读取其他玩家的真实私牌。

训练仍从已有主网初始化，新增信息的权重初始为零，随后按实际整场结果继续训练，不属于从随机参数开始重新训练。

| 阶段   | 本轮放开的参数 | 训练量计划 |
| ------ | -------------: | ---------- |
| 后层   |        294,401 | 前两轮     |
| 中后层 |        819,713 | 第三、四轮 |
| 全网   |      1,373,185 | 第五轮起   |

新网络对所有生成的合法动作评分，并以小概率从全部合法动作中探索；不再限制为旧策略前四个候选。不同对手仍包含四席自对弈、冻结历史模型和原规则机器人。

首次 12 场／125 把检查产生 4,785 条决策，完成三个解冻阶段。全解冻优化确实改变了第一层至输出层的参数；但这次小样本验证没有改善，因此选中检查点保留了之前较好的参数。`last-optimization.npz` 保存最后一次优化结果作研究，`full.npz` 保存按验证集选择的结果；不能把“所有层做了更新”直接当成棋力提升。

### 三路并行训练

```bash
python ai/danMCai/training/full_model.py --initialize=ai/danMCai/data/generated/complete-example/initial
python ai/danMCai/training/run_full_training.py --output=ai/danMCai/data/generated/complete-example/training --initial=ai/danMCai/data/generated/complete-example/initial --opponent-model=ai/danMCai/data/generated/full-match-training/cycle-04/model/ppo.npz --cycles=16 --matches=192 --workers=3 --seed=37100104 --eval-seed=38100104 --eval-pairs=64 --eval-every=2
```

首轮目录 `ai/danMCai/data/generated/complete-network/training/` 在首次两次更新、384 场训练后的回测出现退步：虽然验证均方误差下降，更新后的网络对两种对手的各 128 场开发比赛均未获胜。停止目录实际保留三次完成更新、使用 576 场；第四次更新未完成，不计入完成训练。导出与本地推理数值一致，因此没有用较低预测误差代替对战验收，也没有把这些权重设为默认模型。

后续全层试验降低更新步幅，并增加对初始网络输出的保持约束。保持约束参与损失计算，不限制任何合法出法；整场团队胜负仍是学习标签。在已有 192 场训练样本上，全部 1,373,185 个参数参与优化，每一层的权重均实际改变。

该全层候选的开发测试为：原规则机器人 128 场中获胜 95 场（74.22%），初始网络在相同牌局获胜 92 场（71.88%）。配对提升 2.34 个百分点，95% 区间为 -5.95 到 10.63 个百分点，**尚不能确认实战提升，也未达到 80% 目标**。这是已用于选模的开发牌局，不能充作最终留出验收。

对冻结历史模型的另外 128 场，候选获胜 61 场（47.66%），初始网络获胜 67 场（52.34%）。因此该候选没有被选为发布版本。[完整开发报告](./evaluation/full-network-development-2026-11-04.json)保留对手、种子、模型校验值和区间。

后续目录 `ai/danMCai/data/generated/complete-network/training-guarded/` 已完成 16 次更新、每次 192 场，共 3,072 场完整比赛，分三个采样进程。训练种子从 `37200104` 开始，不重复已停止实验的训练牌局。全部开发结果见研究报告自动生成区，尚未通过新的独立整场验收。

每两轮对两种固定对手分别回测：原规则机器人及冻结的历史模型。各用同牌交换双方，并按独立牌局种子计算区间，和初始化模型在同一批牌局的成绩比较。评测牌局与训练种子分开。

训练父模型也受对战筛选：对规则机器人的开发胜率必须提高，且对历史模型不下降，才保留为后续训练起点；否则自动回退到此前保留的检查点。开发集小幅波动不构成发布依据，最终验收另用未参与选模的种子。

开发回测显示收益后，仍需要新的留出完整比赛、浏览器数值和实际牌局检查。训练程序不会修改 `MODELS`、复制新模型到线上资源或自动发布网页。当前默认网页模型仍保持原样。

### 检查训练与浏览器

```bash
python -m unittest discover -s tests -p 'full_training_test.py' -q
python web/tests/policy_browser_smoke.py --complete-match --model=ai/danMCai/data/generated/complete-network/smoke-middle/policy.onnx --output=web/artifacts/validation/complete-network-browser
```

逐层冻结／解冻、实际梯度更新、损坏数据拒绝和 ONNX 导出已检查。浏览器通过生产推理模块核对 48 个牌局位置、7,922 个动作，选择全部一致，最大数值误差小于 0.000001；这证明运行兼容，不是胜率报告。

## 明牌评价与开局重打的四组对照

`ai/danMCai/training/run-team-study.py` 训练公开信息的完整 Actor，并比较公开／明牌 Critic 与是否重打开局。正式小试验在 `ai/danMCai/data/generated/asymmetric-pilot/`，已完成四组各 4 周期、每周期 16 场，共 256 条训练轨迹；扩大试验 `asymmetric-next/` 已完成四组各 8 周期、每周期 32 场，共 1,024 条训练轨迹。流程检查另有 48 场，不能当作胜率证据。每两周期使用与训练分开的开发种子，对规则与冻结历史模型分别评测。具体架构、超参数、正负结果与统计边界见[研究报告](./MODEL_STUDY.md#76-明牌评价与重打首次小试验)。

```bash
python ai/danMCai/training/run-team-study.py --output=ai/danMCai/data/generated/asymmetric-pilot --initial=ai/danMCai/data/generated/complete-network/initial --opponent-model=ai/danMCai/data/generated/match-selfplay-training/cycle-14/model/ppo.npz --cycles=4 --games=16 --epochs=2 --seed=61000104 --eval-seed=62000104 --eval-pairs=16
```

所有训练代码、实验记录与本轮完成的检查点合入 `main`。历史权重较多，通过[成果目录](./evaluation/model-artifacts.json)连接到 GitHub 实验附件；网页只加载默认清单，不加载研究 Critic 或未验收候选。
