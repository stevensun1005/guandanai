# 纯规则对手 · rules-v2

此目录只负责纯规则电脑，不参与网页神经网络的动作评分、候选动作生成或 Worker 推理，也不训练网络。

| 文件             | 职责                                       |
| ---------------- | ------------------------------------------ |
| `settings.js`    | 规则参数与启用项                           |
| `arrangement.js` | 规则对手专用拆组与百搭成本，独立缓存       |
| `strategy.js`    | 阶段判断、跟牌、保炸、让队友与公开信息推断 |

`createRuleOpponent(seed)`（`ai/shared/simulation/rule-baseline.mjs`）使用此版本。接口只收到自己的实体手牌、其他玩家的剩余张数和公开牌史。根据过牌、进还贡和已出牌推测剩余分布属于统计抽样与规则推断，不是神经网络或在线学习。

`createRuleBaseline(seed)` 保留 `original`，供历史评测与现有训练复现；不要用新版对手的名称解释旧结果。整场模拟可显式传 `playMatch({ ..., ruleVersion: 'rules-v2' })`，默认仍为历史版本，避免无声改变训练对手池。

单把评测命令 `node ai/local/evaluation/evaluate-trained.mjs --opponent=rule` 默认使用 `rules-v2`，输出记录 `ruleVersion` 及三份源码指纹。可加 `--rule-version=original` 复现旧对手。**该命令是单把评测，不能作为整场胜率证据。**

新版主要包括：按最后出牌者余牌划分阶段；保留唯一炸弹；不炸队友的三带二；只剩一炸与一手其他组合时优先走其他组合（保留对手余牌张数例外）；结合公开信息抽样估计接牌与队友需求。测试覆盖合法性和信息边界，不据此宣称更强。
