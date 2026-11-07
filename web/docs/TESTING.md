# 验证与复现

## Windows A/B 实验面板

`node --test ai/research/tests/windows-ab-controller.test.mjs` 用临时合成文件验证未完全退出的学习器不能进入评测、完整最终权重按 SHA 冻结、再次调用不重置评测截止，以及新增更新计数不含继承步数。它不启动真实训练。

`python ai/research/tests/windows_ab_dashboard_smoke.py http://127.0.0.1:8766/` 只读取已经存在的本机面板，检查三秒刷新、两臂、4 GiB 预算、拒绝写请求，以及桌面／390 像素布局；不会启动、停止或修改训练。真实运行与固定截止见 [Windows 交接](../../ai/research/WINDOWS_RETURN_20261106.md)。

## 公开观战与语音回归

`node --test web/tests/spectators.test.mjs` 检查公开投影不包含手牌、牌堆、种子或辅助状态，并拒绝无效实体牌／座位／张数。`python web/tests/spectators_smoke.py <预览根URL>` 使用三个独立 Chrome 上下文和真实 PeerJS：两名玩家仍占两席，观众无模型下载，不能出牌、占座或用玩家凭证恢复；覆盖玩家刷新恢复后的双路语音、房主禁言／重新允许、第二局数据刷新、房主退出，以及 1440／1024／390 像素布局。音频使用浏览器合成测试设备，不代表真实麦克风品质或跨设备网络验收。所有浏览器局面标为 `kind=test`，不进入真人训练样本。

本轮同时回归原有模型菜单、Clint Worker 与五个神经网络 WASM、复盘记录、房主／个人评价、Top 5、独立明牌工具、房间恢复及云端牌谱。代码与实际记录见 [Clint UI 同步证据](../../ai/research/evaluation/clint-sync-20261106-latest.json)，属于兼容性测试，不是新的模型训练或棋力成绩。

当前菜单和命名以 [WEB_MODELS.md](WEB_MODELS.md) 为准：Clint、GuanZero 最近两代、danMCai 初始版与两代danMCai 冠军。下文带版本号的历史浏览器和风格结果保留原条件，不代表当前菜单或最新检查点成绩。

## PR 自动检查与网页流程评测

PR 自动执行 `npm test`、格式检查、构建、`production_smoke.py` 与 `replay_security_smoke.py`。浏览器在实际产物上加载模型并出牌，另从文件导入恶意结果文本，验证列表、重打原结果和回放只显示文字。PR 不发布网站；主分支推送或手动运行通过检查后才部署 GitHub Pages。CI 使用安装的 Chromium，本地默认使用 Chrome，可通过 `BROWSER_CHANNEL` 更换。

严格 CSP 禁止页面动态执行字符串脚本，仍允许模型 WebAssembly、同源模块 Worker、字体和 PeerJS 信令。浏览器测试的轮询应传 `() => 条件` 函数；不要为测试加入 `unsafe-eval`。

```bash
npm run eval:table -- --pairs=2 --seed=73000104 --styles=balanced,aggressive,conservative,observant,adaptive
npm run eval:table -- --pairs=1000 --seed=73010104 --styles=balanced --opponent=rule
npm run eval:table -- --pairs=1000 --seed=73020104 --styles=observant --opponent=balanced
```

首条是流程检查，后两条是较大规模的开发评测入口，不代表已完成这些场数。默认输出 `web/artifacts/validation/table-evaluation.json`，可用 `--output=` 指定文件。它运行与网页相同的决策准备和 Worker 函数，包含直接出完、风格、跨局公开习惯、条件应牌推理和确定性残局。对手可选当前规则电脑或当前均衡网页流程。模拟进还贡仍由现有自动策略处理；浏览器 UI／网络、跨机器一致性与棋力验收仍需各自检查。

`--policy=` 可以指定候选 ONNX；若输入布局不同，还须用 `--config=` 指定符合 `MODELS.policy` 格式的部署元数据（例如 `extraFeatures`），不能把训练器的优化参数文件直接当作部署配置。候选模型默认使用当前网页的后处理；若要比较其他部署配置，需在报告中保留完整配置并单独验证。

每个种子交换阵营两次，统计单位为种子簇，平局进入整场胜率分母。报告带原始结算、模型和源码指纹、推理计数、真实耗时及区间。普通顺子修复改变了当前规则对手，旧基线成绩不能直接与新协议比较。已完成的 20 场及额外 2 场均只是[流程证据](../../ai/research/MODEL_STUDY.md#77-共享网页流程的检查不作棋力结论)，不证明风格更强或目标胜率达标。

跨局联机：`python web/tests/multiround_smoke.py` 用同机四个独立 Chrome 上下文和公共 PeerJS 信令连续操作三局，包含非南位房主、升级、进还贡与一次模型超时托管。[已记录结果](../../ai/research/evaluation/multiplayer-1.6.1.json) 共 232 手，四端结算一致。它不替代不同设备与不同网络的长时间比赛。

真人与电脑混合：`python web/tests/multiround_smoke.py http://127.0.0.1:8765/ 3 2` 连续三局，两个独立玩家端加观察、稳健电脑，共 247 手；[记录](../../ai/research/evaluation/multiplayer-mixed-1.7.0.json) 检查跨局交换、同步和加入者不下载模型。

交换牌：`python web/tests/tribute_smoke.py` 同时覆盖普通手牌、全高牌、电脑合法还贡和动画中立即开打，检查两端逻辑交换后仍有完整的 108 张实体牌。

选牌与键盘：`python web/tests/selection_smoke.py` 在三个窗口尺寸操作方向键、选牌、取消、提示和 P 出牌；检查手牌空格不会过牌，桌面 Esc 能取消拖动。Node 同时覆盖牌型、进还贡与等待回合的反馈规则。

复盘练习：`python web/tests/practice_smoke.py` 验证明牌练习、出牌、评语、导出与跨浏览器导入、旧记录迁移、损坏数据和本机保存失败提示。记录格式边界与限制见 [复盘指南](./PRACTICE.md)。

残局检查：Node 测试使用独立的实体牌子集穷举对照；`python web/tests/endgame_browser_smoke.py` 将真实自对弈中记录的 15 个残局（包含 7 个 17–24 张局面）交给浏览器 Worker，并检查风格不会覆盖已证明路线。

电脑配置检查：`python web/tests/bot_setup_smoke.py`，覆盖三个窗口尺寸、四种玩家座位与本机偏好保存，同时核对模式、桌规和座位的辅助技术选择状态。`browser_smoke.py` 还检查房主风格同步及真实 Worker 风格决策。批量棋力与行为验证见 [电脑对手](./BOTS.md)。

理牌操作可单独验证：`python web/tests/hand_tools_smoke.py`。它在 1440×1000、390×844 和 844×390 三种窗口内操作理牌菜单，检查手动成组保留、实体牌完整、撤销、重做、快捷键与弹层边界。纯数据检查覆盖 30 步上限、无操作保留重做、新编辑及手牌变化清理历史。

双模型检查：`python web/tests/response_browser_smoke.py` 核对 72 个观察／融合实际局面（含 24 个近期记忆局面）中的主策略、第二网络概率、控制器最终选牌与应牌模型资源失败重试。Node 覆盖条件模型不改变出／过、不读取其他家隐藏牌及张量释放。训练与批量对战命令见 [模型训练](../../ai/research/MODEL_TRAINING.md)。

## 日常检查

```bash
npm test
npm run format:check
npm run build
```

Node 检查不要求 Python：

- 模块的自由变量必须有明确的浏览器环境或导入来源。
- `core` 规则不得依赖 DOM、界面和会话状态。
- 双副牌、百搭、牌型大小、炸弹层级和候选出牌合法性。
- 重复实体牌、伪造牌型、非本人手牌和非法先手过牌。
- 834 个固定状态的特征编码快照。

## 真实浏览器

先启动本地预览，另开终端：

```bash
python -m pip install -r ai/environment/requirements-dev.txt
python web/tests/production_smoke.py
python web/tests/browser_smoke.py
```

测试使用已安装的 Chrome。生产入口检查不启用测试全局变量，使用实际按钮进入单人局并等待电脑推理。双浏览器检查验证开房、邀请、座位、出牌同步、掉线接管、模型失败重试和手机宽度。

也可以传入 GitHub Pages 网址：

```bash
python web/tests/browser_smoke.py https://stevensun1005.github.io/guandanai/
```

表情与快捷语：`python web/tests/emote_smoke.py http://127.0.0.1:8765/` 用电脑和手机两种尺寸的真实 PeerJS 联机，检查表情按钮在右下角「理牌」右边、面板在按钮正上方且不超出窗口，表情页只有 5 个表情，快捷语在另一页且只有 8 句、不含出牌暗示；快捷语气泡出现在发送者名字旁且不超出窗口，双方都调用中文朗读且音调不同；客人送鲜花给房主时礼物先飞行再落在双方页面的正确座位；房主给电脑扔炸弹、客人给另一台电脑送卡布奇诺后，电脑按回礼表回应且双方都看到；伪造的自由文字、未知编号、缺少或指向自己的收礼座位、非礼物带收礼座位都被房主丢弃；冷却期内重复发送只显示第一条；打开屏蔽开关后不显示他人表情和礼物；表情不写入出牌记录。截图在 `web/artifacts/validation/emotes/`。Node 部分 `web/tests/emotes.test.mjs` 检查清单、只认预设编号、收礼座位校验、回礼表和按座位冷却。

真实联机检查依赖公共信令及外部网络；本地失败时先区分产品问题与网络不可用。

## 模型数值与性能

```bash
python ai/danMCai/tests/check_encoding.py
python ai/danMCai/tests/benchmark_model.py
```

数值检查使用独立的 NumPy 路径验证编码与计算。性能检查在同一个浏览器 Worker 中交替运行两个等价图，排除前几轮预热，比较相同手牌和候选动作。

本机 v1.1 测量：166 个候选动作，32 轮交替计算，前 4 轮预热；中位数从 15.5 ms 变为 11.1 ms，批次输入减少 89.8%，该组输出最大差异为 0。这不是所有设备的保证。

## 持续训练

```bash
node --test ai/danMCai/tests/continuous-training.test.mjs
python ai/danMCai/tests/continuous_learner_test.py
```

Node 部分随 `npm test` 运行，覆盖种子区间、探索规则、PFSP、SPRT，以及一场真实比赛的标签与 int8 分片往返。Python 部分检查 P0 载入再导出与原 ONNX 输出逐位一致、重放缓冲、目标混合、一次真实更新与续跑。端到端运行方式见[持续训练指南](../../ai/research/CONTINUOUS_TRAINING.md)。这些检查只说明流程与数据正确，不说明训练有效。

## 浏览器检查的边界

- 桌面 Chrome 与手机尺寸模拟不等于所有真实手机验收。
- 自动整场检查，不等于长时间真人比赛或不同物理网络验收。
- 单局对战胜率，不等于从 2 升过 A 的整场胜率。
- danMCai 模型计算正常，不保证所有 NAT 环境下都能建立 WebRTC。

结果应说明牌局数量、种子范围、对手、运行环境及未验证部分。

## 公开牌谱

`python web/tests/public_history_smoke.py` 在桌面、手机横竖屏检查查看入口、切换历史局、整场统计、按玩家筛选、实时记录更新、单局与整场下载、名字作为纯文本呈现、弹窗内快捷键隔离与 Esc 关闭。结算页入口关闭后恢复原按钮焦点。纯文本牌谱和四家明牌的复盘文件是不同用途；前者不包含隐藏手牌，也不能直接作为明牌练习导入。

1.12.0 的核心构建 `08754318bf` 经过四个独立客户端三局检查：85、60、96 手，共 241 手；四端每局的实体牌、升级、名次和累计公开记录一致，包含四次原座位刷新恢复。页面错误与自动同步次数为零。[结果](../../ai/research/evaluation/match-history-1.12.0.json)。纯数据检查另覆盖记录替换、200 局上限、隐藏手牌排除和四种座位旋转。新增的 `deal.test.mjs` 固定生成四王手牌，确认不会触发额外重洗。

## 刷新与断线恢复

```bash
python web/tests/rejoin_smoke.py
python web/tests/seat_credentials_smoke.py
python web/tests/multiround_smoke.py http://127.0.0.1:8765/ 3 4 --rejoin
python web/tests/multiround_smoke.py http://127.0.0.1:8765/ 3 2 --rejoin
```

第一项用实际 Worker 延迟回复，检查玩家回来后不会收到旧电脑落牌；第二项验证换人、房主占位和主动退出后的旧凭据失效。连续对局分别覆盖三个客人视角、结算恢复和观察／融合双模型电脑。报告与边界见 [房间指南](./ROOMS.md)。

Python 开发工具的已验证依赖保存在 `ai/environment/requirements-dev.txt`，模型训练依赖独立放在 `ai/environment/requirements-models.txt`。使用 Python 3.11+；本轮在 3.13 上执行。格式检查：`python -m ruff format --check scripts tests ai/danMCai/reference`。普通玩家和生产构建不需要这些 Python 包。

## 阶段竞态与整场检查

`python web/tests/ready_transition_smoke.py` 重放重复的准备消息，并并发调用交换流程，检查两笔还贡只执行一次、最终每家 27 张、旧的同局等待不能改回出牌权。`python web/tests/resync_smoke.py` 人为阻塞客人的事件队列，核对同一连接恢复后的手牌、记录与房主计时。

完整打 A 的自动检查：

```bash
python web/tests/multiround_smoke.py http://127.0.0.1:8765/ 50 2 --match --auto
```

它在整场结束时停止，最多运行 50 局或 60 分钟。所有出牌用缩短倒计时触发真实学习策略托管，准备和进还贡仍通过实际页面按钮；这不是模拟真人思考时间的测量。检查跨端每张牌的归属、公开记录、升级与最终结果。停滞时将完整测试局面与最近回合写入 `web/artifacts/validation/full-match`，用于复现，不能把尚未跑完的检查写成通过。

### 首次整场结果

阶段竞态修复后的版本 `5c154081ef` 已完成一整场：9 局、736 手、543 次实际模型评分，两端升级、归属和结算一致，页面错误为零。[结果 JSON](../../ai/research/evaluation/full-match-phaseguard-1.10.0.json)。这场在自动队列同步加入前执行，能单独检查阶段与回调修复；自动同步另用阻塞队列专项检查验证。倒计时经过加速，运行时间约 9.4 分钟，不代表真人一场的时长。

### 最新双模型整场结果

包含自动同步的版本 `e2ea25eeef` 另完成一整场：16 局、1,268 手、946 次实际模型评分。两端结算与实体牌归属一致，页面错误为零；自动队列同步触发次数为零。[结果 JSON](../../ai/research/evaluation/full-match-current-1.10.0.json)。与前一场合计 25 局、2,004 手；它们是同机 Chrome 自动托管检查，不替代不同真实设备上的真人比赛。

## 帮助界面

`python web/tests/help_smoke.py` 在桌面、手机横竖屏核对标签切换、键盘焦点、当前桌规、单人暂停与联机继续计时。还检查了正在推理的电脑等待关闭帮助，以及明牌练习点击帮助正文不会推进回合。[结果](../../ai/research/evaluation/help-1.11.0.json)。

### 四端整场结果

四个独立客户端的版本 `fe1e70512d` 完成一整场：12 局、953 手、672 次实际模型评分，四端归属、升级与结算一致，页面错误与自动重新同步次数均为零。[结果 JSON](../../ai/research/evaluation/full-match-four-clients-1.11.0.json)。四个玩家座位的出牌通过缩短超时触发学习策略，客人仍通过真实页面完成准备、进还贡；不能把自动托管当作真人行为的测量。

三场整场自动检查共 **37 局、2,957 手、2,161 次模型评分**，包含两个客户端与四个客户端的情形。不同构建中额外的帮助样式与暂停逻辑由独立帮助场景检查覆盖。

### 近期习惯的跨局检查

构建 `85cc00f19d` 的双端混合对局完成三局、256 手，观察与融合电脑实际进行 89 次后台决策，其中 56 次携带近期习惯统计；两端每局历史与结算一致，四次座位恢复正常，页面错误和自动同步次数为零。[结果](../../ai/research/evaluation/multiplayer-habits-1.13.0.json)。习惯桶与权重的纯数据检查另外覆盖队友过牌排除、牌型区分、旧局衰减、近四局上限及网络特征保持不变。

## 练习桌布局

`python web/tests/table_layout_smoke.py` 覆盖 1440×1000、1280×720 和 1024×768 触屏。通过真实入口开始练习，每个窗口至少走六手实际神经网络出牌，再用独立的显示状态检查长记录滚动、自己出完牌后的操作、评语和局末总结。操作按钮不互相重叠，理牌结束／继续／下一局位置一致，触屏高度至少 44 像素；页面错误为零。[结果](../../ai/research/evaluation/table-layout-1.14.0.json)。这些显示状态不计作真实比赛或模型胜率证明。

## GuanZero 与真人牌谱的当前检查

GuanZero 的默认评测包含 `random,rule,p0,clint`，其中 `rule` 明确为历史 `original`，Clint 为 `rules-v2`。相关 Node 检查覆盖对手版本、非法参数、补充报告拒绝覆盖及同模型／同种子合并；Python 验证历史编码与模型推理。

```bash
node --test ai/guanzero/tests/*.test.mjs
python -m unittest discover -s ai/guanzero/tests -p "*test.py"
```

云端采集检查覆盖合格局筛选、人工／电脑／托管来源、离线队列、服务端重放、去重、测试数据隔离与私有导出；具体已完成记录见 [采集 README](../collector/README.md) 及 [研究报告](../../ai/research/MODEL_STUDY.md)。不将合法重放视为真人身份验证，也不把数据采集当成训练或强度验收。

固定整场 2v2 使用 `node ai/danMCai/evaluation/evaluate-fixed.mjs --protocol=<固定协议> --run=<忽略目录>`；测试入口包括 `node --test ai/danMCai/tests/fixed-evaluation.test.mjs` 和 `python ai/danMCai/tests/independent_summary_test.py`。先冻结权重、登记配对种子与来源指纹，完成后才用 `python ai/danMCai/evaluation/summarize_independent.py --protocol=... --run=... --output=...` 汇总；测速局与正式局分开，不将截断计为平局。

出牌评价：`node --test web/tests/coach.test.mjs` 验证许可、私牌边界、百分数数学与辅助样本过滤；`python web/tests/coach_smoke.py --solo-only` 检查真实冠军 WASM、缓存、非法牌、关闭竞态、错误重试与三种尺寸，CI 同步运行。完整 `python web/tests/coach_smoke.py <预览URL>` 使用两个浏览器上下文及真实 PeerJS，检查房主许可、个人选择、辅助标记与重连。它们是功能兼容性测试，不计作棋力样本。

Top 5：`coach_smoke.py` 检查开局开关、最多五种方案、点击只选牌、展示辅助标记与三种尺寸不遮挡按钮。`private_table_smoke.py` 使用真实 PeerJS 验证本机资格、同名加入者不启用、队友明牌推演、规则与网络对手普通输入、关闭恢复，以及构造结算探针的采集排除；不是完成棋力比赛。

## GuanZero 开发评测

两类对手（138506 保留五类，186280 保留三类）及每类 500 场完整比赛的运行协议见 [GuanZero](../../ai/guanzero/README.md#开发评测对手)。相关 Node 测试覆盖冠军 accept／SHA 校验、250 对计数、指纹一致的断点续跑、阶段结果与历史结果隔离；另用真实 ONNX 完整比赛验证冠军推理接线。兼容性测试不能替代这 500 场开发成绩，也不能把开发成绩称为独立验收。

评测名称的回归检查验证：命名导出必须与完整 SHA 匹配，`block-0003` 不解析成训练版本 3，也不套用当前最新导出；缺失版本的旧权重显示 SHA 后缀。显示缓存强制放在训练目录之外。

## 进还贡专项

`npm test` 包含共享阶段驱动的旧基线逐项对照、守恒、观察隐私、旋转、双头及独立配对统计；`npm run test:python` 包含共享网络拟合、优化器恢复、协议拒绝和导出数值对照。GPU 环境另外运行 `python -m unittest discover -s ai/shared/tests -p "*test.py"`，不把 CPU 跳过写成 GPU 通过。

在专用短测运行上执行 `node ai/publishing/finalize-tribute.mjs --run=<短测目录> --preflight`，用该候选的临时本机构建验证 Chrome WASM、两个输出头、真实贡还动画／早还贡、108 张牌及 Clint 隔离，最后恢复清单，不发布。浏览器结果是兼容性，不是独立胜率。截止后的正式留出评测不可被提前拿来选检查点。

生产 UI 冒烟在需要过牌时也执行合法过牌，避免自动测试因只会点出牌而停在真人回合；网络空闲不替代实际应用初始化完成。

## Clint 增量适配检查

```bash
node --test web/tests/start-state.test.mjs
python -X utf8 web/tests/clint_sync_smoke.py
```

后者自建临时预览服务并关闭，须先构建；覆盖 6 次尺寸切换、3 次全屏进出且 viewport meta 零写入、双队级数／名次／失败次数、无牌背、Clint 超时与神经网络消息隔离，并串行运行 UI、贡还、准备去重、真实 PeerJS 恢复、练习布局、Clint 混合模型、独立房主工具和冠军 Top 5 回归。截图和详细日志保留于忽略的 `web/artifacts/validation/`；可提交的摘要见 [同步证据](../../ai/research/evaluation/clint-sync-20261106.json)。Chrome 尺寸模拟和全屏通过不代表 iPad Safari 真机通过，也不是完整棋力评测。

GuanZero 菜单回归按当前归档编号独立核对最近两代，并模拟再新增一代，检查仅替换较旧一项。现任冠军默认、两代门控证据、Clint 与 P0 的检查继续单独执行。

## Clint 2026-11-06 公开牌史策略

`node --test ai/shared/tests/clint-20261106.test.mjs` 检查最小散单、自然级牌拆对、首单保大王与公开贡牌／队友已应牌例外、队友失去牌权后的领出类型及私牌置换不变性。另以开发种子 9,204,200–9,204,207 完成 8 个规则自对弈单局、687 次动作，逐手验证牌型与持牌合法性；这是回归覆盖，既无强弱对手对照，也不模拟整场通过 A，不计作独立强度验收。

`clint_bot_smoke.py` 在真实 Worker 验证四个新增策略局面，并保留全规则零 ONNX 下载与五种网络的 WASM 兼容性检查。完整浏览器入口仍为 `clint_sync_smoke.py`，包含联机恢复、响应尺寸、Top 5 和房主独立工具。公开牌史策略的 Node 局面是受控合成数据，不冒充完整合法重放。
