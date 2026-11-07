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
