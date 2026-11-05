# 模型研究与证据

| 文档                                               | 用途                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| [MODEL_STUDY.md](MODEL_STUDY.md)                   | 架构、训练方法、实际正负结果及统计限制的主报告 |
| [CODEX_HANDOFF.md](CODEX_HANDOFF.md)               | 当前状态、硬性约束与后续任务顺序               |
| [CONTINUOUS_TRAINING.md](CONTINUOUS_TRAINING.md)   | 本机持续训练、查看、停止与资源预算             |
| [IMPROVEMENT_PROPOSAL.md](IMPROVEMENT_PROPOSAL.md) | 待验证的改进假设                               |
| [MODEL_TRAINING.md](MODEL_TRAINING.md)             | 历史训练入口和应牌模型复现                     |
| [STRUCTURE_MIGRATION.md](STRUCTURE_MIGRATION.md)   | 本次目录变化与旧运行兼容方式                   |
| [evaluation](evaluation)                           | 机器可读实验结果、发布记录与权重索引           |
| [tools](tools)                                     | 主报告生成与证据维护工具                       |
| [tests](tests)                                     | 报告的统计与证据校验                           |

历史评测 JSON 保持原始内容；其中记录的旧源码路径属于实验当时的指纹，不能因文件移动而改写为新的实验。

近期成果：[v000481076 独立整场评测](evaluation/independent-v481076-rule-20261105/results.json) · [rules-v2 隔离与界面兼容性证据](evaluation/ui-rule-refresh-20261105.json)。后者不包含新版对手的胜率验收。

[Clint 与 danMCai 冠军选择证据](evaluation/champion-selection-20261105/validation.json)记录六项菜单、真实门控来源及兼容性，不是新独立强度验收。

[真人牌谱云端采集验证](evaluation/human-collection-20261105.json)记录合成联机测试、数据隔离及私有导出结果；这是数据基础设施验证，没有新增真人训练或胜率结果。

当前入口：[GuanZero 四类开发对手与冻结补评](../guanzero/README.md)、[Clint 首批逐场结果](evaluation/guanzero-clint-block-0002-20261105.json)、[当前菜单及连字符命名](../../web/docs/WEB_MODELS.md)。这些开发评测、门控晋升和浏览器验证分别记录，不与独立验收混用。

各功能说明按 [贡献指南的文档检查清单](../../CONTRIBUTING.md#文档的职责) 同步；主报告保留历史实验，当前产品入口以功能指南与模型清单为准。

[冠军对 Clint／最新导出](evaluation/champion-clint-latest-20261105)保存本次固定整场评测的事前协议、种子审计与后续实际结果；详见主报告第 21 节。
