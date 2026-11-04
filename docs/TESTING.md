# 验证与复现

残局检查：Node 测试使用独立的实体牌子集穷举对照；`python tests/endgame_browser_smoke.py` 将真实自对弈中记录的 8 个残局交给浏览器 Worker，并检查风格不会覆盖已证明路线。

电脑配置检查：`python tests/bot_setup_smoke.py`，覆盖三个窗口尺寸、四种玩家座位与本机偏好保存。`browser_smoke.py` 还检查房主风格同步及真实 Worker 风格决策。批量棋力与行为验证见 [电脑对手](BOTS.md)。

理牌操作可单独验证：`python tests/hand_tools_smoke.py`。它在 1440×1000、390×844 和 844×390 三种窗口内操作理牌菜单，检查手动成组保留、实体牌完整、撤销与弹层边界。

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
python -m pip install numpy onnx playwright
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
- 对局按钮与若干次同步出牌，不等于长时间多人比赛验证。
- 单局对战胜率，不等于从 2 升过 A 的整场胜率。
- 本地模型计算正常，不保证所有 NAT 环境下都能建立 WebRTC。

结果应说明牌局数量、种子范围、对手、运行环境及未验证部分。
