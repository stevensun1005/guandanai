# 验证与复现

跨局联机：`python tests/multiround_smoke.py` 用同机四个独立 Chrome 上下文和公共 PeerJS 信令连续操作三局，包含非南位房主、升级、进还贡与一次模型超时托管。[已记录结果](evaluation/multiplayer-1.6.1.json) 共 232 手，四端结算一致。它不替代不同设备与不同网络的长时间比赛。

真人与电脑混合：`python tests/multiround_smoke.py http://127.0.0.1:8765/ 3 2` 连续三局，两个独立玩家端加观察、稳健电脑，共 247 手；[记录](evaluation/multiplayer-mixed-1.7.0.json) 检查跨局交换、同步和加入者不下载模型。

交换牌：`python tests/tribute_smoke.py` 同时覆盖普通手牌、全高牌、电脑合法还贡和动画中立即开打，检查两端逻辑交换后仍有完整的 108 张实体牌。

选牌与键盘：`python tests/selection_smoke.py` 在三个窗口尺寸操作方向键、选牌、取消、提示和 P 出牌；检查手牌空格不会过牌，桌面 Esc 能取消拖动。Node 同时覆盖牌型、进还贡与等待回合的反馈规则。

复盘练习：`python tests/practice_smoke.py` 验证明牌练习、出牌、评语、导出与跨浏览器导入、旧记录迁移、损坏数据和本机保存失败提示。记录格式边界与限制见 [复盘指南](PRACTICE.md)。

残局检查：Node 测试使用独立的实体牌子集穷举对照；`python tests/endgame_browser_smoke.py` 将真实自对弈中记录的 15 个残局（包含 7 个 17–24 张局面）交给浏览器 Worker，并检查风格不会覆盖已证明路线。

电脑配置检查：`python tests/bot_setup_smoke.py`，覆盖三个窗口尺寸、四种玩家座位与本机偏好保存。`browser_smoke.py` 还检查房主风格同步及真实 Worker 风格决策。批量棋力与行为验证见 [电脑对手](BOTS.md)。

理牌操作可单独验证：`python tests/hand_tools_smoke.py`。它在 1440×1000、390×844 和 844×390 三种窗口内操作理牌菜单，检查手动成组保留、实体牌完整、撤销与弹层边界。

双模型检查：`python tests/response_browser_smoke.py` 核对 48 个观察／融合实际局面中的主策略、第二网络概率、控制器最终选牌与应牌模型资源失败重试。Node 覆盖条件模型不改变出／过、不读取其他家隐藏牌及张量释放。训练与批量对战命令见 [模型训练](MODEL_TRAINING.md)。

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
python -m pip install -r requirements-dev.txt
python tests/production_smoke.py
python tests/browser_smoke.py
```

测试使用已安装的 Chrome。生产入口检查不启用测试全局变量，使用实际按钮进入单人局并等待电脑推理。双浏览器检查验证开房、邀请、座位、出牌同步、掉线接管、模型失败重试和手机宽度。

也可以传入 GitHub Pages 网址：

```bash
python tests/browser_smoke.py https://stevensun1005.github.io/guandanai/
```

真实联机检查依赖公共信令及外部网络；本地失败时先区分产品问题与网络不可用。

## 模型数值与性能

```bash
python tests/check_encoding.py
python tests/benchmark_model.py
```

数值检查使用独立的 NumPy 路径验证编码与计算。性能检查在同一个浏览器 Worker 中交替运行两个等价图，排除前几轮预热，比较相同手牌和候选动作。

本机 v1.1 测量：166 个候选动作，32 轮交替计算，前 4 轮预热；中位数从 15.5 ms 变为 11.1 ms，批次输入减少 89.8%，该组输出最大差异为 0。这不是所有设备的保证。

## 浏览器检查的边界

- 桌面 Chrome 与手机尺寸模拟不等于所有真实手机验收。
- 自动整场检查，不等于长时间真人比赛或不同物理网络验收。
- 单局对战胜率，不等于从 2 升过 A 的整场胜率。
- 本地模型计算正常，不保证所有 NAT 环境下都能建立 WebRTC。

结果应说明牌局数量、种子范围、对手、运行环境及未验证部分。

## 公开牌谱

`python tests/public_history_smoke.py` 在桌面、手机横竖屏检查查看入口、按玩家筛选、实时记录更新、复制与下载一致、名字作为纯文本呈现、弹窗内快捷键隔离与 Esc 关闭。纯文本牌谱和四家明牌的复盘文件是不同用途；前者不包含隐藏手牌，也不能直接作为明牌练习导入。

## 刷新与断线恢复

```bash
python tests/rejoin_smoke.py
python tests/seat_credentials_smoke.py
python tests/multiround_smoke.py http://127.0.0.1:8765/ 3 4 --rejoin
python tests/multiround_smoke.py http://127.0.0.1:8765/ 3 2 --rejoin
```

第一项用实际 Worker 延迟回复，检查玩家回来后不会收到旧电脑落牌；第二项验证换人、房主占位和主动退出后的旧凭据失效。连续对局分别覆盖三个客人视角、结算恢复和观察／融合双模型电脑。报告与边界见 [房间指南](ROOMS.md)。

Python 开发工具的已验证依赖保存在 `requirements-dev.txt`，模型训练依赖独立放在 `requirements-models.txt`。使用 Python 3.11+；本轮在 3.13 上执行。格式检查：`python -m ruff format --check scripts tests ai/reference`。普通玩家和生产构建不需要这些 Python 包。

## 阶段竞态与整场检查

`python tests/ready_transition_smoke.py` 重放重复的准备消息，并并发调用交换流程，检查两笔还贡只执行一次、最终每家 27 张、旧的同局等待不能改回出牌权。`python tests/resync_smoke.py` 人为阻塞客人的事件队列，核对同一连接恢复后的手牌、记录与房主计时。

完整打 A 的自动检查：

```bash
python tests/multiround_smoke.py http://127.0.0.1:8765/ 50 2 --match --auto
```

它在整场结束时停止，最多运行 50 局或 60 分钟。所有出牌用缩短倒计时触发真实学习策略托管，准备和进还贡仍通过实际页面按钮；这不是模拟真人思考时间的测量。检查跨端每张牌的归属、公开记录、升级与最终结果。停滞时将完整测试局面与最近回合写入 `work/validation/full-match`，用于复现，不能把尚未跑完的检查写成通过。

### 首次整场结果

阶段竞态修复后的版本 `5c154081ef` 已完成一整场：9 局、736 手、543 次实际模型评分，两端升级、归属和结算一致，页面错误为零。[结果 JSON](evaluation/full-match-phaseguard-1.10.0.json)。这场在自动队列同步加入前执行，能单独检查阶段与回调修复；自动同步另用阻塞队列专项检查验证。倒计时经过加速，运行时间约 9.4 分钟，不代表真人一场的时长。

### 最新双模型整场结果

包含自动同步的版本 `e2ea25eeef` 另完成一整场：16 局、1,268 手、946 次实际模型评分。两端结算与实体牌归属一致，页面错误为零；自动队列同步触发次数为零。[结果 JSON](evaluation/full-match-current-1.10.0.json)。与前一场合计 25 局、2,004 手；它们是同机 Chrome 自动托管检查，不替代不同真实设备上的真人比赛。

## 帮助界面

`python tests/help_smoke.py` 在桌面、手机横竖屏核对标签切换、键盘焦点、当前桌规、单人暂停与联机继续计时。还检查了正在推理的电脑等待关闭帮助，以及明牌练习点击帮助正文不会推进回合。[结果](evaluation/help-1.11.0.json)。

### 四端整场结果

四个独立客户端的版本 `fe1e70512d` 完成一整场：12 局、953 手、672 次实际模型评分，四端归属、升级与结算一致，页面错误与自动重新同步次数均为零。[结果 JSON](evaluation/full-match-four-clients-1.11.0.json)。四个玩家座位的出牌通过缩短超时触发学习策略，客人仍通过真实页面完成准备、进还贡；不能把自动托管当作真人行为的测量。

三场整场自动检查共 **37 局、2,957 手、2,161 次模型评分**，包含两个客户端与四个客户端的情形。不同构建中额外的帮助样式与暂停逻辑由独立帮助场景检查覆盖。
