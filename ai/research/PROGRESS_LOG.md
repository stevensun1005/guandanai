# 研究进展日志（自 README 移出）

[返回研究索引](README.md) · [模型研究主报告](MODEL_STUDY.md)

2026-11-09 按所有者要求整理根目录 README：原先散落在 [README.md](../../README.md) 与 [README.en.md](../../README.en.md) 中的研究进展、训练窗口、交接、GuanZero 排期、Clint 同步与实验结果段落，以及几段已在 README 中精简的界面说明，原文移到此处保存，只把相对链接改为本文件所在位置。它们是**历史记录**，反映各自写入时的状态，可能已被后续结果取代；当前结论以 [MODEL_STUDY.md](MODEL_STUDY.md) 及其证据为准，当前菜单与默认值以 [WEB_MODELS.md](../../web/docs/WEB_MODELS.md) 为准。

This log keeps, verbatim, the research-progress, training-window, handoff, GuanZero schedule, Clint-sync and experiment-result paragraphs (plus a few interface notes now summarized in the READMEs) moved out of the root READMEs on 2026-11-09. Only relative links were adjusted for this location. They are historical notes; the [research report](MODEL_STUDY.md) and [web model guide](../../web/docs/WEB_MODELS.md) own the current state.

## 中文 README 原段落（2026-11-09 移出）

以下按原 README 中的先后顺序排列。

[持续研究实时面板](http://127.0.0.1:8767/)跟随每一项短测和长训更新。后续由实际评测结果决定下一项短测或长训，获准持续研究至 **11 月 11 日周三中午 12:00 Toronto**；固定截止、预登记、内存与报告要求见 [自主研究窗口](AUTONOMOUS_RESEARCH_20261107.md)。

Windows A／B 已获准顺序各训四小时，随后进行独立整局评测；[历史 A/B 面板](http://127.0.0.1:8766/)显示实际进度与资源，启动证据和固定截止见 [Windows 交接](WINDOWS_RETURN_20261106.md)。网页冠军保持不变，训练进度不构成棋力提升结论。

电脑及手机操作区会为按钮预留空间：少牌不让操作列盖住成组工具，矮窗口可切成两列，局末按钮留在结果卡内。

进还贡专项训练采用独立共享网络，固定窗口、公开信息边界与融合验收见 [专项说明](../shared/tribute/README.md)。该模块尚未启用到网页，当前模型菜单和默认冠军不变。 [专项 Mac 数据交接](TRIBUTE_MAC_HANDOFF.md)提供独立迁移包与后续适配步骤。

Clint 规则对手独立维护：单张顺走、级牌与王的取舍、公开牌史配合的当前说明见 [Clint 策略](../../web/src/rule-bot/README.md#公开牌史策略更新)。神经网络模型保持自己的决策。

大厅依次提供 **Clint规则机器人、GuanZero 最近两代、danMCai 初始版及最近两代冠军**，最后另有一项研究机器人 **danMCai-v000855042+推理搜索**：在冠军 017 之上用手牌推断网络猜对手的牌，再按电脑端留出测试过的规则搜索（对冠军对手、单局、不进贡每副 +0.237；对真人和进贡局未测，超时即出 017 的牌），不是新训练的冠军，也不是默认，见 [研究机器人](../../web/docs/BOTS.md#研究机器人推理搜索9001)。默认使用**danMCai 现任门控冠军**，点「全部使用danMCai 冠军」可重置。冠军依据训练系统实际门控晋升，不按步数最新替代，不代表独立棋力验收。本机 GuanZero 每天多伦多时间 08:00、20:00 冻结一代，两对手各打完 500 场后将同一份权重发布到网页。旧权重保留归档。GuanZero 使用 `guanzero-adp-gpubatch-44752` 这样的名称。具体版本与默认值见 [电脑选择与发布](../../web/docs/WEB_MODELS.md)。 Mac 续训产生的冠军同样须经真实 accept 门控与 SHA 核对，再按[发布指南](../../web/docs/WEB_MODELS.md)同步到默认模型和出牌评价。

**[模型研究报告](MODEL_STUDY.md)** 记录网络结构、学习算法、完整比赛目标、正负实验结果及证据局限。定期发布最新权重不等于已证明棋力提升；开发集成绩不等于独立验收。

项目目标是持续提高整体棋力，成为帮助你复盘和提高掼蛋水平的训练伙伴。80% 仅是历史特定对手实验的阈值，不是总体目标；多对手表现、配合和复盘教学效果分别验证，尚未实现或验证的能力不作承诺。

GuanZero 开发评测已包含Clint 和真实 danMCai 门控冠军，每类默认 500 场完整比赛（250 对交换阵营种子）。面板区分已完成数量、阶段胜率与历史 200 场结果；[运行与协议](../guanzero/README.md#开发评测对手)。

GuanZero 评测面板使用“训练任务名-真实版本 / 对手”标识冻结模型，进度单独显示；旧记录缺少可核对版本时显示 SHA 后缀，详见 [面板命名](../guanzero/README.md#面板中的评测模型名)。

137 万参数的完整主网已完成逐层解冻实验；公开／明牌评价与新题／重打的四组对照完成了 256 条小试验、1,024 条扩大试验的整场训练轨迹。重打开局不等于独立新牌副，这些训练量也不是胜率验收场数。完成的研究代码、结果及检查点入口均在 `main`；截至已公开记录，尚未通过新的独立整场 80% 验收。当前网页默认由实际冠军晋升记录决定，历史有限实验与普通最新导出不自动替换它。最新方法与结论以[模型研究报告](MODEL_STUDY.md)及其证据快照为准。

开发评测可运行 `npm run eval:table -- --pairs=1000 --opponent=rule`：它复用网页真实决策模块，覆盖风格、公开记忆、直接出完和残局。实际已完成的样本、统计边界与复现命令见[研究报告](MODEL_STUDY.md#54-网页决策流程的整场评测)，不把流程检查当作棋力进步。该旧整场入口的 `rule` 仍是原版规则；Clint 的 GuanZero 评测使用 `--opponents=clint`，两者成绩不混用。

GuanZero 与danMCai 分开训练，支持 GPU 合批推理和只读实时面板。GuanZero 开发评测包含Clint（rules-v2）与 danMCai 冠军；同一冻结模型、固定种子交换阵营，旧检出可独立补评 Clint。已完成结果和使用方式见 [GuanZero](../guanzero/README.md)，不能把开发胜率当成独立验收。

固定双队整场评测支持冠军同队对 Clint 同队、冠军同队对最新冻结导出同队；协议、独立种子与实际结果见[研究报告第 21 节](MODEL_STUDY.md#21-2026-11-05冠军对-clint-与最新导出的固定整场评测)。部署与胜率结论分开记录。

**可选出牌评价**：房主开房时先允许，每位玩家再自行开启；用当前 danMCai 冠军选牌预评、显示右侧 Top 5 并保留上一手。百分数是模型相对分，不是胜率。详见[出牌评价](../../web/docs/MOVE_COACH.md)。

出牌评价支持在单人或房间大厅选择本人是否开启；推荐列出具体用牌，点击只选牌，不会自动出牌。百分比是模型动作值的相对分，不是胜率，详见[出牌评价](../../web/docs/MOVE_COACH.md)。

训练换电脑：[MacBook 接手指南](MAC_HANDOFF.md)提供原生环境、带校验的模型／优化器／回放迁移和固定 24 小时启动流程。Windows 成果保留；本次 M1 Pro 已通过真实 MPS／Adam／ONNX 预检并在独立冻结检出完成本次唯一 24 小时窗口；最终停止、检查点与数据恢复核验见交接。采样并发可经具名协议按实测调优，保留日常使用内存和原固定截止。本次门控按授权优先新快照，普通旧快照不补赛，保留少量前冠军及 P0 退步检查；见[调度指南](CONTINUOUS_TRAINING.md#新快照优先的门控调度)。固定窗口、内存兼容修正及最终结果见交接指南；训练完成不等于独立棋力验收。

固定窗口结束后的检查点、现存回放和归档恢复可用[只读停机审计](CONTINUOUS_TRAINING.md#固定窗口的停机核验)。

本次 Mac 窗口的最终冠军已完成网页核对，对应周期发布检查随本轮收尾结束；新训练窗口须另行授权。[最终记录与交接](MAC_HANDOFF.md)。

Windows 返回包、匹配检查点与 Adam 的恢复、已完成的 Mac 独立比较及新的 Windows A／B 实验见 [Windows 交接](WINDOWS_RETURN_20261106.md)。Mac 原窗口保持停止；新的两臂另有固定截止，结果尚待实际完成的独立评测。

GuanZero 支持从模型、优化器和样本游标续训，在本轮固定窗口每 12 小时冻结模型，分别对两个对手各打 500 场。见 [GuanZero 训练说明](../guanzero/README.md)。 后续历史表达、手牌推断与训练对抗的[适用性评审](GUANZERO_NEXT_STAGE_REVIEW_20261109.md)已记录，具体方案尚待对照验证。

研究中需要神经网络续打时，采用批次启动时已核验的 danMCai 门控冠军；教师切换与数据继承见 [专项协议](../shared/tribute/README.md)。

GuanZero 固定窗口支持独立 Windows 自动恢复任务。监督器退出后校验检查点并继续训练，操作与截止规则见[恢复说明](../guanzero/README.md#自动恢复)。

本机 GuanZero 延长至多伦多时间 **2026-11-11 10:00**，后续评测每天多伦多时间08:00、20:00取样，全部完成后发布同权重，自动恢复按[活动窗口](../guanzero/README.md#授权延长窗口)执行。
阶段 0 研究的历史整场分歧统计与执行边界见[研究成果索引](README.md)及主报告第 48 节；这是 009 的旧证据再分析，不是网页冠军 017 的新成绩。本台 Windows 新训练只安排 danMCai。
danMCai 冠军起点微调已完成新 10,000 局留出：直接对原冠军的升级分有正向证据，对 Clint 与混合队友的改善仍不明确。详见[分组报告与限制](MODEL_STUDY.md#467-最终学习器-10000-局独立留出完成)；网页仍用 017，不将实验候选自动上线。

阶段 0.6 只验证[extras 零投影学生](ANALYSIS.md)：保留冠军主干并检查数值／浏览器等价，不是训练提升，不发布或更换网页冠军。

下一批[danMCai专项实验](CONTINUOUS_TRAINING.md#可选-16仅冠军的四小时剥削臂)仅以017为固定对手，检验针对性提升与对P0／012的迁移；计划、实测、网页发布分开，保留现冠军。

本批danMCai四小时剥削臂与10,000局独立留出已完成，本次未便宜找到剥削信号；现以新牌副诊断单席换入／固定队友表现，零训练更新，网页017不变。[完整结果与限制](MODEL_STUDY.md#513-10000局留出完成本次未便宜找到剥削信号)；[8767实时进度](http://127.0.0.1:8767/)。

Clint本次界面增量加入四类分页图解规则书、选级内继续上一场、收牌结束后才亮出牌键、局末保留本局级数和同花顺去重；本项目六项模型菜单与017默认保持不变。[实现与验证](MODEL_STUDY.md#54-clint增量规则书房主恢复与交互时序)。

单席／固定队友20,000局诊断已完成，差异仍不明确。下一项[冠军017队友网格](MODEL_STUDY.md#55-冠军队友对手网格预登记)预登记12,000新牌副／每格4,000对及同时区间，按最终升级分分析；无新训练或网页冠军替换。

[队友网格](MODEL_STUDY.md#552-完成192000局未达到队友交互条件)已完成192,000局，未达交互条件。下一项为冠军017表示语料与编码频率诊断，零梯度、无Clint／真人训练，网页冠军不变。

表示语料已完成1,000,022决策／12,282独立完整单局：两槽皆非出牌39.81%，选择行41.11%，都不满足<5%稀少条件。逐文件／终局标签／种子审计通过，零网络更新。下一项只读终局G−Q岭回归与冻结隐藏层探针；战术和特权标签不作损失，不启动extras在线。详情见主报告第56.2／58节及evaluation/outcome-residual-probe-20261108/。

表示残差已完整结束：extras单独R²0.00577，但冻结隐藏层上增量0.01572，保守关闭条件false；零网络更新。下一项按新协议做017首次raw整场基线＋网页策略对照，计划11,000场、四CPU工作器、最多2h，仅评测不训练或发布。实际进展以主报告58.1／59及独立整场证据为准。

017首次独立整场基线已完成11,000场／117,508单局，主raw对Clint比分+0.6275 [0.5960,0.6590]，对012及网页减raw差异仍不明确；逐对手胜负平、名次和指纹见主报告59.2。下一项60节仅登记200根Q差分布与6,000对新决策轨迹，不做强制偏离／校准或网页发布，不改单局训练目标。

独立决策轨迹已完成：200根预试＋6,000对主轨迹共12,400单局，1,049,781动作完整重放，707,735神经动作与保存top1一致；零网络更新。下一项按61节新协议做10,000对基线／一次合法第2–5名动作干预，终局Δ与重要性加权分析，不输出校准文件、不部署实时Top5、不换冠军。

终局偏离10,000对全部完成；selfβ0.738725 [0.498932,0.977585]与Clintβ0.665375 [0.421155,0.919781]有正信号但未过事前Q单位条件，不向上四舍五入救条件。下一项62节只用self数据做离线保序拟合，Clint／mixed／P0仅作新留出评测，禁止接入实时Top5或神经网络训练。

self-only离线拟合已完成（1,906展示层样本／3,393字节，零网络更新）；新4,000根／最多8,000单局独立验证已实际启动，冻结600cf4d，原截止2026-11-08T05:32:22.062896Z。当前只核验启动与完整记录前缀，预测改善结论待完成；不得重拟合、扩样或接入实时Top5。主报告62.1及coach-calibration-20261108证据保留协议、映射SHA与进程状态。

Clint增量e7538a1→2b2a824已逐项适配：手机姓名栏居中、局内手牌高度稳定（含最后一张与隐藏选择提示行）、发牌飞向可见姓名牌、大厅署名及去除采集短说明。保留017默认和已有模型偏好；该次同步时未新增本站标签；随后所有者已明确授权本站也采集房间号／真人昵称，现与Clint来源统一；规则与神经网络路径均未修改。证据见`ai/research/evaluation/clint-sync-20261108-0435.json`。

所有者追加要求：本站新联机记录也保存room与开打时真人seats[].name（电脑null），与Clint清理／长度规则一致。旧牌谱不回填，研究样本去除明文标签，单人／练习／明牌／测试与assisted边界不变；不新增训练或换冠军。实现与验证见`ai/research/evaluation/collection-labels-20261108.json`。

4,000新根／8,000单局离线校准验证已结束，self与Clint改善区间均跨0、主条件false；保留负结果，不重拟合或上线映射。继续1.5的仅模拟self离线复盘CLI：已封存轨迹转成原Q排序＋描述，拒绝D1／其他模型，不搜索、不预测升级分、不训练。主报告62.2／65与simulated-review-export证据给出范围。

离线self复盘转换已完成，功能／数据完整性审计见主报告65.1。当前后续训练受既有门槛或授权限制，已询问新的研究方向；不重复实验、不自动进入阶段2。原总截止和只读安全跟进继续，完整复盘数据留在忽略目录。

2026-11-08：所有者新授权Windows danMCai自主连续训练至周三10:00 Toronto，09:45停新增计算；首批公开extras／置零输入、两种子四小时对照仍处开发预登记，不是棋力结果。网页017不变，旧冻结运行／真人数据继续隔离。见[主报告](MODEL_STUDY.md)第66节。

本批容量修正：初始10k根/槽短运行已主动封存（1825更新），不作四小时棋力结果；正式v2每槽50k，同一训练种子两输入臂共享新训练根，两个训练种子互斥，旧pilot不继承。完整协议及停止证据见主报告66.1–66.2，历史设计与失败保留。

正式v2已从冻结c506a03启动，首臂注册13:36:24.535–17:36:24.535Z，实际GPU更新已核验；四臂队列自动接续，当前只有首臂已启动，独立棋力结果尚无。面板8767及新15:00Z／14:45Z截止保护正常。详见主报告66.3和startup-v2证据。

所有者追加允许训练产生新研究冠军；新批按预登记门控、完整SHA和独立评测登记后可明确从其继续。当前四臂不热改、研究冠军不等同网页发布，网页017/[017,012]及周三10:00截止不变。尚无新冠军通过；见主报告66.4及champion-authorization证据。

2026-11-08 Clint增量：电脑版/平板的对家洗牌与切牌提示移到姓名牌下方，左右接风提示移到姓名牌靠牌桌一侧，横排成组标签移到牌组右下；姓名旁不再显示闭麦文字，麦克风按钮与语音权限保留。手机提示按实际姓名牌居中，原接风路径保留。六项模型菜单、017默认、昵称/房间号采集、房间恢复和冻结训练不变。机器证据见主报告63.1。

## English README paragraphs (moved 2026-11-09)

In their original README order.

### Table assistance and hand reset

On desktop windows at least 800 pixels wide and 700 pixels tall, Top 5 uses a reserved sidebar with its own scrolling. Collapsing it restores table space while keeping selection ratings. Controls reserve their own space as cards and timers change; short desktop windows use a smaller action column or a two-column grid. Round-result actions stay inside the result card. Windows shorter than 700 pixels use a scrollable layout instead of overlapping overlays. The **复原** button restores loose cards to rank order, preserves manual groups and supports undo. In four-hand practice it restores the suggested grouping instead. See the [playing guide](../../web/docs/PLAYING.md) and [coach guide](../../web/docs/MOVE_COACH.md).

The [continuous research dashboard](http://127.0.0.1:8767/) follows the current task. The A/B evaluation is complete. Evidence guides sequential short diagnostics and full-network training experiments, with authorization ending **Wednesday, November 11 at noon Toronto time**. See the [autonomous research window](AUTONOMOUS_RESEARCH_20261107.md) for deadline protection, memory limits and reporting.

The owner has authorized sequential four-hour Windows A/B training windows followed by preregistered independent round evaluation. The [historical A/B dashboard](http://127.0.0.1:8766/) shows measured progress and resources; see the [Windows handoff](WINDOWS_RETURN_20261106.md) for fixed deadlines, evidence and recovery boundaries. The website champion stays unchanged. Training progress is not evidence of stronger play.

Tribute/return learning is an independent two-head specialist. See its [protocol and integration requirements](../shared/tribute/README.md). It is not enabled on the website yet; the champion menu is unchanged. The [specialist Mac handoff](TRIBUTE_MAC_HANDOFF.md) covers the separate checkpoint/data package and pending MPS adaptation.

Clint’s standalone rules include single-card following, level-card/joker priorities and partner lead-type inference from public history. See the [rule module](../../web/src/rule-bot/README.md#公开牌史策略更新); neural policies remain independent.

Online rounds with at least two people are archived as structured, pseudonymous records after completion. The host uploads once, with offline retry and deduplication. Private JSON exports and human-action JSONL preparation are available; collected data is not automatically fed into active training. See [collection and export](../../web/collector/README.md).

The menu contains Clint rules, the latest two GuanZero generations, danMCai P0 and the last two danMCai gate champions, plus one research bot, **danMCai-v000855042+推理搜索** (id 9001): champion 017 with the hand-inference network and the belief-world search tested offline (+0.237 per deal pair vs champion-017 opponents, single rounds without tribute; untested against humans or with tribute; a budget overrun plays 017's move). It is not a newly trained champion and not the default; see [the research bot](../../web/docs/BOTS.md#研究机器人推理搜索9001). The default is the **current danMCai gate champion**. GuanZero names use the format `guanzero-adp-gpubatch-44752`; the catalog and selection guide own the actual current versions. Gate promotion is development selection, not independent strength acceptance. The local GuanZero run freezes a checkpoint at 08:00 and 20:00 America/Toronto daily and publishes those exact weights after all two opponents have played 500 matches each. Historical weights remain archived. See [selection and publishing](../../web/docs/WEB_MODELS.md). Neural decisions do not apply Clint heuristics. Champions from the Mac continuation follow the same accepted-gate and SHA checks before updating the default and move-feedback model.

The **[model research report](MODEL_STUDY.md)** documents the shared networks, actual learning algorithms, full-match objective, positive and negative results, and evidence limits. Completed experiments are updated with checkpoint hashes and seed-level outcomes; development peaks are kept separate from independent acceptance tests.

The project aims to keep improving overall playing strength and become a training partner that helps its owner review games and improve. An 80% win rate is only a historical threshold against specific opponents, not the overall goal. Performance across opponents, partnership play and teaching value require separate evidence; planned abilities are not claimed as implemented or validated.

GuanZero development evaluation now includes Clint and the accepted danMCai champion. Each opponent defaults to 500 complete matches (250 paired seeds with sides swapped). The dashboard separates live progress from completed results and historical 200-match batches. See the [evaluation protocol](../guanzero/README.md#开发评测对手).

GuanZero evaluation rows use the training run and actual frozen export version, with the opponent and progress shown separately. Old snapshots without verifiable version records use a SHA suffix. See [dashboard model names](../guanzero/README.md#面板中的评测模型名).

The complete 1.37-million-parameter network has undergone staged unfreezing experiments. Four-arm studies of public or training-only privileged critics and fresh or repeated openings completed 256 pilot and 1,024 extended full-match training trajectories. Repeated openings are not independent new deals, and training counts are not acceptance-test counts. Published code, evidence and checkpoint access are in `main`; the public record has not validated an independent 80% full-match win rate, and those historical experiments do not determine the current web default. The current default follows actual danMCai champion promotions. The [research report](MODEL_STUDY.md) and its evidence snapshot own the latest methods and conclusions.

`npm run eval:table -- --pairs=1000 --opponent=rule` evaluates complete matches through the same preparation and decision functions used by the web controller and Worker, including styles, public history, finishing shortcuts and endgame search. See the [research report](MODEL_STUDY.md) for completed sample sizes and limitations; pipeline smoke checks are not evidence of improved playing strength. This legacy full-match entry uses the original rules for `rule`; the GuanZero evaluator selects Clint explicitly with `--opponents=clint`.

GuanZero is a separate training route with batched GPU inference and a read-only live dashboard. Its development opponents are Clint (`rules-v2`) and the danMCai gate champion. Paired seeds and frozen-model fingerprints keep the results traceable; the legacy trainer can add Clint through an isolated supplement process. See [GuanZero](../guanzero/README.md). Development results are not independent acceptance tests.

Fixed full-match evaluation supports two champion seats against two Clint seats or two seats of a frozen latest export. [Protocols and evidence](evaluation/champion-clint-latest-20261105/) keep paired seeds, model fingerprints, draws and uncertainty separate from deployment decisions.

**Optional move feedback:** the host first permits it for the room, then each player independently opts in. The current danMCai champion rates selected moves and retains the last played move. Percentages are relative model-value scores, not win probabilities. [How it works](../../web/docs/MOVE_COACH.md).

Move feedback can be selected before solo play or in an allowed room. A responsive Top 5 panel shows actual cards and relative scores; clicking selects cards without playing them. Percentages are relative action-value scores, not win probabilities. See [move feedback](../../web/docs/MOVE_COACH.md).

Moving training to a MacBook: the [Mac handoff](MAC_HANDOFF.md) covers native dependencies, checksummed model/Adam/replay transfer and one fixed 24-hour window. Windows artifacts remain intact. This M1 Pro passed real MPS/Adam/ONNX probes and completed its single authorized window in an isolated frozen checkout; the handoff records the final stop and verified checkpoint/data restoration. Sampler concurrency can be tuned through a named, measured protocol change while preserving desktop memory headroom and the original deadline. The authorized gate schedule now prioritizes the newest snapshot, skips the ordinary historical backlog, and retains up to two former champions at a three-hour interval plus the existing P0 regression checks; see the [scheduling guide](CONTINUOUS_TRAINING.md#新快照优先的门控调度). The handoff records the fixed deadline, memory-accounting correction and final results; completing training does not establish independent playing strength.

A [read-only stop audit](CONTINUOUS_TRAINING.md#固定窗口的停机核验) checks final weights, optimizer state, retained replay and restored archives after a fixed window ends.

The final champion from this Mac window has been verified on the website, and the window-specific publication check has ended. A new training window requires separate authorization; see the [final handoff](MAC_HANDOFF.md).

The fixed paired single-round comparison is complete and found no clear strength difference between the champion and final learner. Training remains stopped. See the [Windows return handoff](WINDOWS_RETURN_20261106.md) for the checked model/Adam/replay bundle and next-experiment recommendations.

GuanZero can resume its optimizer and sample cursor in a fixed training window and evaluate a frozen checkpoint every twelve hours in the current fixed window (extended to November 11, 2026 at 10:00 America/Toronto), playing 500 matches against each of two opponents. See the [training guide](../guanzero/README.md). The [next-stage review](GUANZERO_NEXT_STAGE_REVIEW_20261109.md) proposes controlled experiments on history encoding, hand inference and training opponents; these are plans, not validated improvements.

Research continuation games use the verified danMCai champion frozen at batch start. Teacher changes and inherited work are tracked in the [specialist protocol](../shared/tribute/README.md).

A dedicated Windows watchdog can resume the fixed GuanZero training window after a supervisor exit. See [recovery](../guanzero/README.md#自动恢复) for checkpoint checks, the stop control and the original deadline.

The owner extended the local GuanZero run through **2026-11-11 10:00 America/Toronto**. Twelve-hour evaluations and same-checkpoint publishing continue under the [authorized window](../guanzero/README.md#授权延长窗口).
Stage-zero match-objective analysis is documented in the [research index](README.md) and study section 48. It reanalyses historical model 009, not new results for web champion 017. New training on this Windows machine is limited to danMCai.
The champion-start danMCai experiment completed 10,000 fresh heldout rounds. Its direct comparison with the original champion improved signed upgrade points; common-Clint and mixed-teammate contrasts remain inconclusive. See [grouped evidence and limitations](MODEL_STUDY.md#467-最终学习器-10000-局独立留出完成). Web champion 017 is unchanged; experimental weights are not automatically published.

Stage 0.6 prepares a [zero-projection extras student](ANALYSIS.md), retaining the champion backbone for numerical and browser equivalence checks. This is not online training, a strength improvement or a website promotion.

The next optional [danMCai experiment](CONTINUOUS_TRAINING.md) tests a four-hour champion-only exploiter with fresh Adam, then separate held-out comparisons against 017, P0 and 012. This hypothesis does not imply improvement or authorize replacing the website champion.

The four-hour exploiter and its 10,000-round heldout are complete: no cheap target-specific signal was found. A new preregistered single-seat/fixed-teammate diagnostic uses fresh deals, with no training or website promotion. [Results and limits](MODEL_STUDY.md#513-10000局留出完成本次未便宜找到剥削信号); [live progress](http://127.0.0.1:8767/).

The practice menu now includes a separate **open-hand endgame solver** with bounded computation, replay and local JSON export; it never trains a model or changes ordinary bot decisions. **Continue previous match** restores only between-round progress and anonymous match/seat IDs, preserving round numbering and private-tool collection exclusion. It does not restore unfinished hands or replace room reconnection. [Practice](../../web/docs/PRACTICE.md) · [Collection boundaries](../../web/collector/README.md).

The latest Clint UI adaptation adds an illustrated four-section rulebook, continuation inside level selection, delayed play controls during card collection, and deduplicated straight-flush hints. The six-item model menu and default champion017 remain unchanged. [Scope and verification](MODEL_STUDY.md#54-clint增量规则书房主恢复与交互时序).

The 20,000-round single-seat/fixed-teammate diagnostic is complete; differences remain inconclusive. The next [champion017 cooperation grid](MODEL_STUDY.md#55-冠军队友对手网格预登记) preregisters12,000 fresh deals,4,000 paired deals per cell and simultaneous interaction intervals. It evaluates final-round upgrade points without new training or website promotion.

The192,000-round [cooperation grid](MODEL_STUDY.md#552-完成192000局未达到队友交互条件) is complete; no cell met the preregistered interaction condition. The next representation-corpus diagnostic uses only fixed champion017, without gradients, Clint/human training or website promotion.

The representation corpus completed 1,000,022 decisions from12,282 independent complete single rounds. Both nonplay slots occur in39.81% of all decisions and41.11% of choice decisions, exceeding the5% rarity condition. The next preregistered diagnostic fits only final-round G−Q statistical ridge probes on deal-held-out data and frozen hidden features: no tactical targets, neural updates, extras online training or website promotion. See research report sections56.2 and58.

The completed residual probe found extras-only R²0.00577 but partial R²0.01572 beyond the frozen hidden representation; the preregistered conservative closure condition is false. No neural updates or strength acceptance. Next is the first017 raw-argmax whole-match baseline, separately compared with the web policy:11,000 planned matches under a new two-hour protocol, CPU only, no training or promotion. See research report58.1/59.

The independent017 whole-match baseline completed11,000 matches/117,508 rounds. Raw vsClint match score is+0.6275,95%root-clusterCI[0.5960,0.6590]; comparisons with012 and web-minus-raw differences remain uncertain. Opponents and protocols remain separate. Next is a new200-root descriptive Q-gap study followed by6,000 fresh trajectory pairs, with no neural updates, calibrated liveTop5 or promotion. See research report59.2/60.

The decision corpus completed12,400 rounds (200 preliminary roots plus6,000 main pairs);1,049,781 actions replayed and707,735 neural choices matched recorded top1 indices. No neural updates or calibration claim. Next:10,000 fresh baseline/one-legal-deviation pairs with final-round upgrade differences and recorded importance weights; no calibrated UI export or champion change. See report60.3/61.

The10,000 final-outcome deviation pairs completed. Self beta0.738725[0.498932,0.977585] andClint0.665375[0.421155,0.919781] show positive signals but fail the preregistered Q-unit interval condition. Next is an offline self-only monotone fit with fresh-root numerical validation; Clint/mixed/P0 labels stay evaluation-only. No calibrated liveTop5, neural training or promotion. See report61.2/62.

The self-only offline fit completed with1,906 display-layer cases and a3,393-byte statistical map, with zero neural updates. Fresh4,000-root validation is running from frozen600cf4d until its original2026-11-08T05:32:22.062896Z deadline. Startup and completed-prefix audits passed; forecast improvement remains untested pending completion. No refit, sample expansion, calibrated live Top5 or champion publication follows. See MODEL_STUDY62.1 and coach-calibration-20261108 evidence.

Clint changes e7538a1→2b2a824 align phone name plates, preserve the hand area through the last card, land deal animations on visible player plates, update the lobby attribution and remove its collection blurb. The017 default, model preferences and all rule/neural policies remain unchanged. Following that sync, the owner explicitly requested local room/name collection too; both sites now attach those optional labels. Evidence: `ai/research/evaluation/clint-sync-20261108-0435.json`.

Owner-authorized local collection now snapshots the room and human nicknames at play start, with null computer names. Labels are cleaned and bounded as on Clint, retained in private raw records and excluded from prepared sample fields. Historical records remain unchanged; this does not authorize human-data training or a champion change.

Fresh4,000-root/8,000-round offline calibration validation did not establish lower error: both self/Clint primary intervals cross zero. The map stays offline with no refit or sample expansion. Next is the bounded simulated-self review CLI only: archived Q ranks plus descriptions, no new games, inference, human/D1 input, search, calibrated values or promotion. See MODEL_STUDY62.2/65.

The offline self-simulation review converter and integrity audit are complete (MODEL_STUDY65.1). Further training remains limited by existing gates/authorization; a new direction has been requested. Do not rerun completed studies or enter phase2 automatically. Original campaign deadline monitoring continues; full review data stay ignored locally.

2026-11-08: New owner authorization permits autonomous Windows danMCai training until Wednesday 10:00 Toronto, with compute stopping at 09:45. The public-extras versus zero-input two-seed experiment is in preparation, not a strength result. Web champion017, frozen runs and human-data isolation remain unchanged. See the model study section66.

Capacity correction: the original10k-roots/slot engineering pilot was stopped and preserved at1825updates, without a strength claim. Formalv2 uses50kroots/slot; input arms share new training roots within each training seed, while the two training-seed repeats are disjoint. No pilot weights, Adam or replay are inherited. Protocol changes remain in study66.1–66.2.

Formalv2 training has started from frozenc506a03, with the first arm registered13:36:24.535–17:36:24.535Z and actualGPUupdates verified. The four-arm queue advances automatically; only the first arm has started, and strength remains unevaluated. Dashboard8767 and the earlier15:00Z/14:45Z cutoff are active. See study66.3 and startup-v2 evidence.

The owner additionally permits training a new research champion and explicitly continuing future batches from it after preregistered gates, fullSHA provenance and independent evaluation. Current frozen arms, webchampion017/[017,012] and the Wednesday10:00 cutoff remain unchanged. No new champion has yet passed. See study66.4 and champion-authorization evidence.

ClintUIincrement2026-11-08: partner shuffle/cut hints sit below the nameplate, desktop/tablet side-seat follow-lead labels face the table, and horizontal group labels sit at the lower right. Muted badges are removed from plates; microphone controls and permissions remain. Phone hints center on the actual plate. Model menu/default017, collection, recovery and frozen training are preserved. See study63.1 for evidence.

## 菜单段落的提交版原文 / Committed menu paragraphs (added 2026-11-09)

上面两节收录的“大厅依次提供……”与 “The menu contains……” 两段，是清理前工作区里已加入研究机器人说明的改写版，不是 Git 中已提交的原文。下面补存提交 `3170dcc`（清理前的 HEAD）中两段的原文，只按本文件位置调整相对链接。它们描述 2026-11-09 之前的七项菜单与冠军默认，均已被四项菜单（Clint、最新 GuanZero、danMCai 现任冠军、默认 danMCai-reason）取代，见 [WEB_MODELS.md](../../web/docs/WEB_MODELS.md)。

The two menu paragraphs above were the reworded working-copy versions (already mentioning the research bot), not the committed text. The committed originals from `3170dcc` (HEAD before the cleanup) follow, with only relative links adjusted; both describe the pre-2026-11-09 seven-entry menu and champion default, since replaced by the four-entry menu.

大厅依次提供 **Clint规则机器人、GuanZero 最近两代、danMCai 初始版及最近两代冠军**。默认使用**danMCai 现任门控冠军**，点「全部使用danMCai 冠军」可重置。冠军依据训练系统实际门控晋升，不按步数最新替代，不代表独立棋力验收。本机 GuanZero 每天多伦多时间 08:00、20:00 冻结一代，两对手各打完 500 场后将同一份权重发布到网页。旧权重保留归档。GuanZero 使用 `guanzero-adp-gpubatch-44752` 这样的名称。具体版本与默认值见 [电脑选择与发布](../../web/docs/WEB_MODELS.md)。 Mac 续训产生的冠军同样须经真实 accept 门控与 SHA 核对，再按[发布指南](../../web/docs/WEB_MODELS.md)同步到默认模型和出牌评价。

The menu contains Clint rules, the latest two GuanZero generations, danMCai P0 and the last two danMCai gate champions. The default is the **current danMCai gate champion**. GuanZero names use the format `guanzero-adp-gpubatch-44752`; the catalog and selection guide own the actual current versions. Gate promotion is development selection, not independent strength acceptance. The local GuanZero run freezes a checkpoint at 08:00 and 20:00 America/Toronto daily and publishes those exact weights after all two opponents have played 500 matches each. Historical weights remain archived. See [selection and publishing](../../web/docs/WEB_MODELS.md). Neural decisions do not apply Clint heuristics. Champions from the Mac continuation follow the same accepted-gate and SHA checks before updating the default and move-feedback model.

### Windows extras窗口截止归档（2026-11-11）

四臂各4小时训练已完成，共472,461次新增更新；独立留出0局，后续训练没有接续，未产生新研究冠军，连续训练至周三的要求没有兑现。四份最终权重／13组Adam／回放／215源码的只读停止审计重新通过；14:45Z STOP与15:00Z临时防睡眠释放已核对，windows-a-b到期跟进已删除，ai/clint-ui保留。不延期补跑、不改网页清单。完整SHA、计数与限制见 [closeout evidence](evaluation/extras-input-ablation-20261108/closeout-20261111.json)；主报告66.5保留原计划与未完成事实。

### Windows extras window closeout (2026-11-11)

Four four-hour training arms finished with 472,461 new optimizer updates. Independent heldout evaluation completed zero rounds, and subsequent training was not started: no new research champion was established, and continuous training through Wednesday was not fulfilled. Read-only final-network/13-state Adam/replay/215-source audits passed again. The 14:45Z STOP and 15:00Z temporary-awake release were verified; only the expired windows-a-b follow-up was deleted, preserving ai/clint-ui. No deadline extension or website catalog change. Full hashes, counts and limitations: [closeout evidence](evaluation/extras-input-ablation-20261108/closeout-20261111.json); study66.5 preserves the original plan and missing work.
