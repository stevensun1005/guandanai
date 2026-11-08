# danMCai 分析与等价验证 / Analysis and equivalence

阶段 0 的离线研究入口；不接入网页排序、奖励、损失、门控或冻结训练。`analysis/concepts.mjs` 的牌权、手牌结构、handCost 差、压队友和炸队友均为描述；`feedPartner` 仅指轮次重置后由队友领出下一手，不证明帮助队友或造成胜利。`opponentReceivesLeadAndFinishesWithinTwoActions` 的“两手”指随后两条全局动作记录，不是对手两次出牌机会。

The analysis modules describe observations; they do not choose or rank actions. Tags are not rewards, causal explanations or strength metrics. The D1 adapter validates legality and returns only unassisted human actions from `kind=game`; neural scorers receive the acting hand and public information only. This work does not read or train on actual human records.

`cooperationLabels(initial, moves, {score})` 用 `advanceRound` 重放，Q 差可选，固定为 chosen−pass 的原始相对动作值，不是胜率。`humanRecordLabels(record, {score})` 排除测试、电脑、超时托管及已辅助动作，不返回其他手牌。`sampledOvertakeFrequency` 是输入世界集合的样本频率，不是校准持牌概率；采样世界须由后续独立登记的信念模块生成。

评测 `playRound` 的 `capture` 默认关闭；开启仅增加初始模拟状态和逐手记录。`task.teammate` 可以指定独立模型，旧 `mixed=true` 的 Clint 队友行为保持兼容。Clint 仅在评测独立路径运行，绝不作为神经网络策略或新联赛成员。模型池只在清单指定 extras/history 时调用对应编码，普通模型保留原始批量推理路径。普通网页、房主明牌工具和进还贡专项尚未接入 extras 学生。

Formal development checks are frozen in [shared-analysis protocol](evaluation/shared-analysis-20261107/protocol.json), with separately audited seeds and exact implementation hashes. Run from the repository root:

```powershell
node ai/research/tools/validate-shared-analysis.mjs ai/research/evaluation/shared-analysis-20261107/protocol.json ai/danMCai/workspace/shared-analysis-results.json
```

The protocol checks 100 capture/no-capture outcomes and four complete raw-policy fixtures with byte-level native ONNX output comparisons. These are development equivalence tests, not independent playing-strength games. New artifacts stay in ignored workspace unless reduced to small research evidence. Source hashes refer to the frozen development implementation; later edits require a new protocol rather than rewriting old evidence.

[Actual validation](evaluation/shared-analysis-20261107/results.json): 100 capture/no-capture seeds, zero outcome mismatches; four native-policy seeds, 227 requests byte-identical with maximum absolute error zero. These checks do not establish a playing-strength benefit or universal equivalence. See study section 48.1 for counts and limitations.

## 信念搜索开发 / Belief-search development

`ai/shared/search/belief.mjs` 仅接收己手、公开出牌、剩牌数及公开的进贡牌归属，均匀补齐其余实体牌。过牌不是“没有可压牌”的证明。可选历史似然采用温度至少 0.2 的 softmax；ESS 不足时系统重采样，报告重采样前 ESS 和幸存的不同粒子数，不把重复粒子当作新增信息。

`pimc.mjs` 比较语义去重的冠军前三候选、过牌及合法直接出完动作；每个根使用同一批补牌世界，四家由同一冠军 raw argmax 打到单局最终结果。没有短视叶估值、手工战术加分或 Clint 参与。输出为模拟最终升级分、结局直方图及相对 raw argmax 的配对差和标准误；不是校准概率、最优解或推荐的因果解释。重复世界只计算一次；存在重复时不提供伪独立标准误。

The development reference requests 48 identical true-deal worlds. With deterministic raw continuations these have **one effective unique world**, so they are memoized rather than presented as 48 independent samples. It is a full-information champion continuation reference, not optimal play. `rolloutOracleRound` and the optional research-only `rawArgmax`/`onlyShape` oracle arguments support exact per-root greedy comparisons; the webpage's ordinary full-information tool keeps its previous defaults.

预试设计与正式冻结协议见 `evaluation/belief-pretrial-20261107/`。最多 400 副新开发牌中，每副只取第八手之后第一个语义 top-2 差 <0.15 的位置，目标 200 位置；同时用完整开发局的所有有选择决策统计争议比例。每次调用均实测总耗时，而不是假定三秒。需要 200 位置完整、20 次真实教师逐手贪心对照无差异、相对全信息参照的一致率高于原始冠军，才可登记 0.4；开发一致率本身不证明棋力提升。未完成或负结果不扩大样本。

All new compute uses a separately registered campaign task, fixed one-hour maximum, its original STOP/deadline and the four/five GiB memory pause/resume budget. Original training, GuanZero, tribute and website model selection remain unchanged. No actual D1 record is read for this pretrial.

**Actual negative result:** all 200 positions completed; belief/reference agreement 34.5% versus raw champion 60.0%, paired difference −25.5pp (95% deal-position CI −33.95 to −17.05). Mean call time 579ms, p95 864ms. The effectiveness gate failed, so search pilot 0.4 is blocked. This is development agreement, not a measured strength or win-rate decline. See [results](evaluation/belief-pretrial-20261107/results.json) and study section 49.1.

## 0.6 零投影学生 / Zero-projection student

`ValueNetExtras` retains all twelve champion backbone parameter groups and adds a zero `[53,512]` projection before the first tanh. The export keeps `values` and adds an `extras` input. This is an equivalent export candidate, not a trained improvement or an optimizer continuation. The ordinary six-layer learner does not use this class.

正式协议与新开发种子见 [0.6](evaluation/extras-equivalence-20261107/protocol.json)。目标 40,000 个真实 raw 冠军有选择决策（不是 40,000 个独立牌副），逐候选最大差 ≤1e-4，非平局 argmax 差异必须为零；再检查六类共 48 个 Chrome WASM 位置。只做发布准备兼容性，不上传 Release、不改冠军。协议冻结时尚无该批实测结果，不宣称通过。

`run-extras-equivalence.mjs --run=<registered-run>` requires a campaign task and original fixed one-hour STOP/deadline; native validation explicitly uses one CPU thread per session. Browser checks use isolated artifacts and a disjoint development seed block. Tribute rejects extras before reading weights; the specialist stays disabled. Ordinary oracle observation context remains incomplete for extras, so this student is not deployable as champion. No online extras training, human-data use, new rewards or calibrated Top 5 is authorized.

Actual 0.6 validation passed: 40,000 native decisions with 1,676,914 candidate values, identical argmax and zero maximum value delta; 48 Chrome WASM positions retained identical argmax, maximum native/WASM delta 2.6226e-6. This finite-sample compatibility result is not a strength result. [Evidence](evaluation/extras-equivalence-20261107/results.json), study section 50.1. No optimizer update or promotion occurred.

冠军队友网格按[第55节](MODEL_STUDY.md#55-冠军队友对手网格预登记)比较同牌混合队与两种纯队的最终升级分，保留三项协方差；过牌／压队友计数仅作描述，不进入任何评分或验收。original与Clint均为隔离评测策略，非神经网络改动。

[表示语料](evaluation/representation-corpus-20261108/protocol.design.json)按独立完整牌副记录原始567特征、53 extras和终局／特权标签；标签不进策略。频率按整副牌簇统计，不能把动作当独立或把语料存在说成残差探针／输入臂有效。

表示语料已完成1,000,022决策／12,282独立完整单局：两槽皆非出牌39.81%，选择行41.11%，都不满足<5%稀少条件。逐文件／终局标签／种子审计通过，零网络更新。下一项只读终局G−Q岭回归与冻结隐藏层探针；战术和特权标签不作损失，不启动extras在线。详情见主报告第56.2／58节及evaluation/outcome-residual-probe-20261108/。
