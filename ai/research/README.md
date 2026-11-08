# 模型研究与证据

[冠军起点微调的 10,000 局留出](evaluation/champion-restart-20261107/heldout-results.json)已全部完成：直接对原冠军的升级分 +0.0875 [0.0121,0.1629]；共同 Clint 对手和混合队友的差异仍不明确。网页冠军未变；完整分组、原始证据和限制见主报告第 46.7 节及[原始索引](evaluation/champion-restart-20261107/heldout-manifest.json)。

[共享分析层与等价验证](ANALYSIS.md)记录纯描述标签、D1 过滤边界、可选模拟日志和任意评测队友的接口。验证中的开发协议与后续真实结果分开保存，不改变神经网络排名或网页冠军。

[信念搜索开发设计](evaluation/belief-pretrial-20261107/protocol.design.json)用于阶段 0.3 的补牌、完整 raw 贪心推演、争议比例和调用耗时测量；200 个真实位置预试的计划与实际结果必须分开。真牌参照的 48 次确定性重复仅有一个有效世界，不是 48 个独立样本。

[0.3 实际负结果](evaluation/belief-pretrial-20261107/results.json)：200 位置全部完成，搜索一致率低于原冠军，0.4 门槛失败；延迟达标不能替代有效性。第 49.1 节与逐位置结果保留，不扩大样本补救。下一项只做 0.6 等价学生准备。

阶段 0.1 的[历史整场分歧协议](evaluation/match-objective-divergence-20261107/protocol.json)固定两组 009 网页策略的旧档案；只读规则重放与按牌副簇统计，无新模型对局。运行 `python ai/research/tools/match-objective-divergence.py --protocol=ai/research/evaluation/match-objective-divergence-20261107/protocol.json --out=ai/danMCai/workspace/match-objective-results.json`。结果不得冒称 017 棋力或开启整场训练的授权。

[阶段 0.1 实际结果](evaluation/match-objective-divergence-20261107/results.json)与主报告第 48 节保留两组各 1,000 对的旧证据重放及 95% 簇区间，并指出“败场来自对方 A 的 +2／+3”是现有牌规恒等式，不能作为后续训练门槛。

A/B 评测后获准自主分析并执行后续实验，最终截止 Toronto 11 月 11 日周三中午 12:00；见 [自主研究窗口](AUTONOMOUS_RESEARCH_20261107.md)。计划与完成结果分开，网页冠军不自动改变。

Windows 回迁准备保留在主报告第 42 节及 [原始机器证据](evaluation/windows-return-20261106/)。随后获准的 A→B 各四小时训练与独立评测见 [交接](WINDOWS_RETURN_20261106.md)、第 44 节及 [新证据](evaluation/windows-ab-20261107/)。启动与资源读数不构成新增棋力结果。

| 文档                                                         | 用途                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [MODEL_STUDY.md](MODEL_STUDY.md)                             | 架构、训练方法、实际正负结果及统计限制的主报告                         |
| [CODEX_HANDOFF.md](CODEX_HANDOFF.md)                         | 当前状态、硬性约束与后续任务顺序                                       |
| [CONTINUOUS_TRAINING.md](CONTINUOUS_TRAINING.md)             | danMCai 持续训练、查看、停止与资源预算                                 |
| [IMPROVEMENT_PROPOSAL.md](IMPROVEMENT_PROPOSAL.md)           | 待验证的改进假设                                                       |
| [TRAINING_ROADMAP_20261107.md](TRAINING_ROADMAP_20261107.md) | 更像人、能解释、会配合、以整场为目标的分阶段训练路线（设计，无新结果） |
| [MODEL_TRAINING.md](MODEL_TRAINING.md)                       | 历史训练入口和应牌模型复现                                             |
| [STRUCTURE_MIGRATION.md](STRUCTURE_MIGRATION.md)             | 本次目录变化与旧运行兼容方式                                           |
| [evaluation](evaluation)                                     | 机器可读实验结果、发布记录与权重索引                                   |
| [tools](tools)                                               | 主报告生成、证据维护与真人出牌对比工具                                 |
| [tests](tests)                                               | 报告的统计与证据校验                                                   |

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

[冠军／最终学习器独立整局比较与 Windows 返回](WINDOWS_RETURN_20261106.md)：20,000 局完整交换位置评测、原始证据、匹配 Adam 的恢复包和下一轮建议；主报告第 41 节记录尚不能分出强弱的结论。

[持续循环与缓存微基准结果](evaluation/cache-reuse-20261107/results.json)：16,384 次固定输入请求、实际 DirectML、最大输出差 0；约 1.77 倍的均值耗时比仅限该访问近似，下一项完整采样另验，不是棋力结果。

[完整采样缓存对照预登记](evaluation/cache-e2e-20261107/protocol.json)：同一真实冠军教师、冻结联盟，四进程比较 6／12 有界会话缓存；用途为系统吞吐，不是棋力。

[完整采样对照结果](evaluation/cache-e2e-20261107/analysis.json)：2,048 场开发采样完成，按预登记选择下一新运行的缓存参数，系统观察与棋力严格区分。

[冠军起点完整网络微调](evaluation/champion-restart-20261107/protocol.json)：冠军权重、新 Adam／新回放、四小时预算，随后预登记 10,000 局新牌副评测；GPU 实测与正式学习计数分开。

[冠军网络微调实际启动](evaluation/champion-restart-20261107/startup.json)记录固定截止、真实正式更新／ROCm／DirectML与可用内存；它是启动快照，非最终或独立棋力成绩。

[Clint 配牌练习与训练选择同步](evaluation/clint-sync-20261107-1506.json)记录 `ec58b20` 的功能适配、未照搬项、原有模型／房间兼容及响应测试；不是新的训练或棋力结果。

[Top 5 侧栏与手牌复原验证](evaluation/ui-coach-restore-20261107.json)：桌面预留空间、收起恢复宽度、一键复原／保留成组／撤销重做及普通与明牌联机边界；仅功能测试，不是模型训练或棋力结果。

[按钮多状态与显示辅助标记验证](evaluation/ui-control-layout-20261107.json)：操作区避让、极小窗口滚动、局末结果、真实评分及屏幕内展示标记；属于界面与数据采集兼容性，不是新的棋力或训练结果。

[0.6 协议](evaluation/extras-equivalence-20261107/protocol.json)封存零投影学生、40,000 开发决策与 48 浏览器夹具的等价条件；尚待本批实测，不等于更强。

[0.6 实测](evaluation/extras-equivalence-20261107/results.json)：40,000 决策 argmax 全同／最大差 0，48 WASM 位置 argmax 全同；兼容性通过，训练更新与新棋力验收均为零。下一项仅可另行登记普通 017 剥削臂。

[可选1.6协议](evaluation/exploiter-017-20261107/protocol.json)准备普通017／新Adam／空回放、仅017对手四小时剥削臂与独立10,000局留出；是待验证假设，实际启动／结果另记，不将extras等价当提升。

[1.6实际启动](evaluation/exploiter-017-20261107/startup.json)：原四小时窗UTC19:56–23:56，普通017／新Adam／空回放，真实ROCm更新与DML采样已核验；尚无新独立棋力结果。

[Clint本次增量](evaluation/clint-sync-20261107-2006.json)记录独立明牌残局练习、主动续场、完整合法动作／穷举校验及隐私排除连续性。不是神经网络训练或棋力提升；普通规则三文件、网页冠军和冻结训练不变。

[1.6最终停机与留出启动](MODEL_STUDY.md#512-四小时最终停机与独立留出启动)：v000044731网络／12组Adam一致，累计72,624局，尾部46,655行未摄入；五组10,000局新留出已按冻结协议启动，结果待完成。

[1.6完整留出](evaluation/exploiter-017-20261107/heldout-results.json)：10,000局全部完成；对017升级分−0.071，95%[−0.14361,+0.00161]，剥削信号+0.020，99%[−0.14872,+0.18872]，点门槛false，本次未便宜找到。随后实际启动[新固定队友诊断](evaluation/exploiter-teammate-diagnostic-20261108/protocol.json)，不是重复旧留出。

[Clint本轮界面与恢复证据](evaluation/clint-sync-20261108-0011.json)：图解规则、房主本机恢复、续场入口及显示时序；只验证功能，普通规则指纹／网页冠军不变，不是新的棋力实验。

[单席诊断结果](evaluation/exploiter-teammate-diagnostic-20261108/results.json)：20,000局全部完成，固定017/P0/012队友的焦点差异仍不明确；下一项[冠军队友×对手网格](evaluation/cooperation-grid-20261108/protocol.design.json)另用12,000新牌副／每格4,000对，预登记交互与多重区间，不重跑剥削留出。

[网格真实启动](evaluation/cooperation-grid-20261108/startup.json)：冻结2f82e19／155源码指纹、四工作器、固定05:09:22Z截止；首批真实计数单独封存，不冒充完整结果。

[队友网格完整结果](evaluation/cooperation-grid-20261108/results.json)：192,000局全部完成，12格同时99%区间均跨零且abs(gap)<0.10，不开启队友多样性训练。下一项[表示语料协议](evaluation/representation-corpus-20261108/protocol.design.json)用固定017约100万决策测编码空洞，零梯度。

[表示语料真实启动](evaluation/representation-corpus-20261108/startup.json)：冻结c32a66d／152源码，90,480已保存决策与1,110完整单局的初始快照；约100万是计划量，频率／残差结论待完整结束，不是训练或网页发布。
