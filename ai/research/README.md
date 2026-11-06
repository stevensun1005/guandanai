# 模型研究与证据

| 文档                                               | 用途                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| [MODEL_STUDY.md](MODEL_STUDY.md)                   | 架构、训练方法、实际正负结果及统计限制的主报告 |
| [CODEX_HANDOFF.md](CODEX_HANDOFF.md)               | 当前状态、硬性约束与后续任务顺序               |
| [CONTINUOUS_TRAINING.md](CONTINUOUS_TRAINING.md)   | danMCai 持续训练、查看、停止与资源预算         |
| [IMPROVEMENT_PROPOSAL.md](IMPROVEMENT_PROPOSAL.md) | 待验证的改进假设                               |
| [MODEL_TRAINING.md](MODEL_TRAINING.md)             | 历史训练入口和应牌模型复现                     |
| [STRUCTURE_MIGRATION.md](STRUCTURE_MIGRATION.md)   | 本次目录变化与旧运行兼容方式                   |
| [evaluation](evaluation)                           | 机器可读实验结果、发布记录与权重索引           |
| [tools](tools)                                     | 主报告生成、证据维护与真人出牌对比工具         |
| [tests](tests)                                     | 报告的统计与证据校验                           |

## 真人出牌与模型对比

`node ai/research/tools/compare-human-moves.mjs <导出的整场牌谱.txt> [更多牌谱…]` 逐手比较真人实际出牌与 danMCai 冠军（默认 `selection.danMCaiChampions[0]`）在同一局面的选择。牌谱是网页「牌谱与战况」导出的公开动作文本；只有该玩家 27 张全部出完的局能还原起手牌，其余局跳过并注明。模型只看本人手牌、公开出牌、各家张数与级数，与普通局的推荐口径相同，不使用他人手牌或明牌推演。

- 选项：`--player` 指定比较谁（默认是唯一不叫 下家／对家／上家 的名字）；`--exporter` 指定导出者（不是本人且看不出电脑标签时）；`--model`、`--model-file`（默认 `web/dist/models/`，需先 `npm run build`，并核对目录 SHA-256）；`--clear` 明显分歧阈值（默认 0.5）。
- 输出：`web/artifacts/analysis/human-moves/<玩家>-<模型>.md` 与同名 `.json`（已忽略，不提交、不上传、不进入训练）。报告给出与第一选择／前三的一致率、按差距分档的分歧、领出牌型、炸弹与压队友的取舍、按手牌阶段的一致率及明显分歧列表。
- 解读：数值是候选间的相对分，不是胜率；少量对局只说明习惯差异，不能判定哪方正确，也不是模型强度验收。出牌前看过 Top 5 数字的手不算独立真人判断。还原逻辑由 `ai/research/tests/human-moves.test.mjs` 用模拟对局的真实手牌校验。

历史评测 JSON 保持原始内容；其中记录的旧源码路径属于实验当时的指纹，不能因文件移动而改写为新的实验。

近期成果：[v000481076 独立整场评测](evaluation/independent-v481076-rule-20261105/results.json) · [rules-v2 隔离与界面兼容性证据](evaluation/ui-rule-refresh-20261105.json)。后者不包含新版对手的胜率验收。

[Clint 与 danMCai 冠军选择证据](evaluation/champion-selection-20261105/validation.json)记录六项菜单、真实门控来源及兼容性，不是新独立强度验收。

[真人牌谱云端采集验证](evaluation/human-collection-20261105.json)记录合成联机测试、数据隔离及私有导出结果；这是数据基础设施验证，没有新增真人训练或胜率结果。

当前入口：[GuanZero 四类开发对手与冻结补评](../guanzero/README.md)、[Clint 首批逐场结果](evaluation/guanzero-clint-block-0002-20261105.json)、[当前菜单及连字符命名](../../web/docs/WEB_MODELS.md)。这些开发评测、门控晋升和浏览器验证分别记录，不与独立验收混用。

各功能说明按 [贡献指南的文档检查清单](../../CONTRIBUTING.md#文档的职责) 同步；主报告保留历史实验，当前产品入口以功能指南与模型清单为准。

[冠军对 Clint／最新导出](evaluation/champion-clint-latest-20261105)保存本次固定整场评测的事前协议、种子审计与后续实际结果；详见主报告第 21 节。

[完整对照报告](reports/champion-clint-latest-20261105.md)：两组共 4,000 场已完成，最新冻结导出未显示超越冠军，保留负结果与不确定性。[出牌评价验证](evaluation/move-coach-20261105.json)另记功能兼容性，不是强度证据。

名称与路径统一：[danMCai 迁移证据](evaluation/danmcai-naming-20261105.json) · [兼容说明](STRUCTURE_MIGRATION.md#danmcai-名称与规范路径)。

[Top 5 与独立完整牌面推演](evaluation/coach-top5-private-20261105.json)：记录普通评分、主机／队友／对手分支隔离、数据排除和浏览器兼容性，详见主报告第 24 节。没有新增训练或完整强度比赛，不能据此声称胜率提高。

[MacBook 24 小时交接](MAC_HANDOFF.md) · [迁移与恢复证据](evaluation/mac-handoff-20261105.json)：Windows 正常停机、完整现存运行快照与 Adam 恢复已在 Windows 侧验证，这是 Windows 准备阶段的历史记录。后续 [Mac 真机启动证据](evaluation/mac-continuation-20261105.json)记录 M1 Pro 上的 MPS／Adam／ONNX 实测、内存计数负结果和同一窗口恢复；方法与继承计数见主报告第 26、28 节，完整 24 小时尚未完成。

[Mac 采样吞吐调优](evaluation/mac-throughput-20261105.json)：保留原固定窗口和 4／5 GiB 内存预算，实测两名到四名 CPU 采样器；GPU 计算短探针、操作性吞吐、真实门控结果分别记录，不将更多训练量写成棋力提升。

[Mac 新快照优先门控](evaluation/mac-gate-scheduling-20261105.json)：原窗口内经正常保存切换候选调度，保留历史强者低频检查、P0 退步监控与中断证据；不把少做门控等同于已测得的吞吐或棋力提升。

[进还贡专项协议](../shared/tribute/README.md) · [短测证据](evaluation/tribute-20261106-preflight.json)。开发反事实分与独立棋力结果分开记录。

新增冠军续打与协议继承约定，见根 AGENTS 和 [专项协议](../shared/tribute/README.md)；继承不是新增训练结果。

[Clint 增量同步证据](evaluation/clint-sync-20261106.json)与[当前游标](evaluation/clint-sync-state.json)：双队续局设置、桌面／平板布局、全屏稳定性及 Clint 真人超时；功能验证与普通策略棋力严格分开，详见主报告第 36 节。

[Clint 公开牌史策略修订](evaluation/clint-sync-20261106-1404.json)：四项启发式的隔离、合法性与浏览器验证，新旧对手指纹分开；详见主报告第 37 节，不是新的棋力提升结论。

[进还贡专项 Mac 交接](TRIBUTE_MAC_HANDOFF.md) · [Windows 打包与恢复证据](evaluation/tribute-mac-transfer-20261106.json)：完整数据／Adam 已保留并校验，Mac 专项 MPS 验证仍待执行。

[停机只读审计工具](tools/audit-continuous-stop.py)核对固定窗口、最终网络和 Adam、现存重放分片与采样日志；恢复及本地 ZIP 核验流程见 [Mac 交接](MAC_HANDOFF.md#窗口结束后)。

[Mac 唯一 24 小时窗口最终核验](evaluation/mac-24h-20261106.json)：原截止触发停止、最终学习器与 Adam、现存回放及尾部数据、610 文件本地归档恢复均核对通过，最终冠军复用网页归档 017。完整原始正负门控及尚待独立验证的结论见主报告第 40 节。
