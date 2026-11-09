<div align="center">

# GuandanAI

[English](./README.en.md) · 简体中文

### 掼蛋朋友局 · 打开网页，就坐一桌

四人组队、房间邀请、浏览器内智能对手。电脑和手机都能玩。

[![Deploy](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml/badge.svg)](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml)
[![Version](https://img.shields.io/github/package-json/v/stevensun1005/guandanai?color=ddb050)](./CHANGELOG.md)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-f7df1e?logo=javascript&logoColor=black)
![Runtime](https://img.shields.io/badge/Runtime-Browser_%2B_WebAssembly-4a7c59)

**[立即开局](https://stevensun1005.github.io/guandanai/) · [玩法指南](./web/docs/PLAYING.md) · [下载发布包](https://github.com/stevensun1005/guandanai/releases/latest) · [开发指南](./CONTRIBUTING.md) · [更新记录](./CHANGELOG.md)**

</div>

![实际对局画面](./web/docs/media/table-desktop.png)

<details>
<summary>更多界面：操作帮助与整场战况</summary>

<p align="center"><img src="./web/docs/media/help-mobile.png" width="280" alt="手机上的操作帮助" /> <img src="./web/docs/media/match-history-mobile.png" width="280" alt="手机上的整场战况与公开牌谱" /></p>

</details>

## 一张链接，一桌朋友

1. 打开游戏，输入昵称，选择 **开房间**。
2. 选择自己的座位，点 **复制邀请链接** 发给朋友。
3. 朋友打开链接、输入昵称、选择座位。房主点 **开始**。

没人坐的座位由电脑接管，一个人也能直接开局。朋友刷新原标签页后可恢复座位；房主刷新或误关页面后，同版本、同一浏览器三小时内可自动恢复原房间，朋友再回到原座位。详见 [房间与恢复](./web/docs/ROOMS.md)。

大厅中央「选级」可分别设置两队级数、当前打级方、上一局名次与打 A 失败次数，接着之前的牌局打；打 A 可选「一次机会」桌规。桌面名字牌对称排列，支持无牌背与横竖屏切换；同花顺提示显示总种数与当前组合。详见 [上桌指南](./web/docs/PLAYING.md)。

大厅新增「观战」：输入四位房间号即可只读查看公开出牌与剩余张数，不占玩家座位。房主可在「选项」查看房间号、管理观众语音。[观战说明](web/docs/PLAYING.md#观战朋友的牌桌)

## 已经能做什么

| 体验     | 内容                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 四人掼蛋 | 两副牌、百搭、同花顺、进还贡、接风、升级打 A                             |
| 朋友房间 | 邀请链接、房间号、座位选择、观战、掉线接管与原标签页恢复                 |
| 智能电脑 | 规则机器人、按训练版本选择的神经网络和推理搜索机器人，全部在浏览器后台算 |
| 手牌操作 | 拖动、扫选、成组、一键复原、智能理牌、按花色排序、撤销重做、三种布局     |
| 出牌辅助 | 合法出牌提示、同花顺查找、可选二次确认、可选出牌评价、跨局牌谱与整场战况 |
| 对局氛围 | 音效、全屏、可选语音、表情与快捷语、出牌动画与结果展示                   |
| 静态部署 | GitHub Pages 自动发布，默认模型随网页部署，研究检查点单独归档            |

大厅 **[训练](./web/docs/PRACTICE.md)** 先选「配牌」「牌局」或「残局」：配牌可逐家比较分组；牌局保留四家明牌、逐手评语与复盘；残局提供独立明牌求解、停止、回放与本机导出。分组参考分不等于网络合理性或胜率，记录不自动用于模型训练。

练习桌的操作区位置固定，出完牌也能继续和撤回；已出牌可滚动查看，评语与结算收在左下角。电脑和平板都能保留清楚的牌桌空间。

**可选出牌评价**：房主允许后每位玩家自行开启，右侧 Top 5 列出具体用牌和相对分（牌桌剩 40 张以内时来自推理搜索，其余用冠军估值），点击只选牌、不自动出牌；百分数不是胜率。详见 [出牌评价](web/docs/MOVE_COACH.md)。

## 为浏览器而做

玩家无需安装 Node.js、Python 或桌面客户端。页面加载后，电脑出牌由 Web Worker 和 WebAssembly 在房主浏览器中计算。模型只接收自己的手牌、公开出牌、剩余张数和级数。训练过程、历史单把成绩和适用范围见 [模型训练指南](./ai/research/MODEL_TRAINING.md)。

需要在本机运行电脑时，才下载推理组件和模型；加入朋友房间的玩家无需先等模型加载。资源加载失败时会给出重试入口，不会悄悄切换成另一种电脑策略。

至少两名真人的联机局结束后，房主会自动把结构化牌谱保存到云端（含房间号与开局真人昵称，电脑昵称为null）；支持断网暂存、补传与去重。牌谱可私有导出为 JSON／JSONL，供后续研究人类行为，当前训练不会自动读取。[Clint 的网站](https://clintsun1977.github.io/guandan/)的真人局也以同一格式上传到同一云端（`appVersion` 以 `c1977` 开头）。[采集与导出](./web/collector/README.md)。

## 模型与研究

电脑模型菜单只有四项：Clint规则机器人、最新一代 GuanZero、danMCai 现任门控冠军（danMCai-v000855042）和带推理的 **danMCai-reason-v000855042**。**默认电脑和出牌评价都使用 danMCai-reason-v000855042（编号 9001）**，由所有者 2026-11-09 选定：它以冠军 017 为底，用手牌推断网络 v1 只根据公开信息估计其他三家的牌，在中盘和尾盘对候选出牌做多世界推演；超时或出错时直接出 017 的牌。它不是新训练的冠军；进还贡仍用 017。danMCai 初始版、上一任冠军和较早的 GuanZero 已退出菜单，权重与记录保留归档；之前保存的这些选择自动改回默认。

验证范围：只在对手全是冠军 017、单局、不进贡的电脑端留出测试中每副 +0.237 [0.208, 0.266]；对真人、混合队伍和进贡局尚未测试，网页实际棋力不能直接写成这个数。

[电脑选择与发布](./web/docs/WEB_MODELS.md) · [机器人设计](./web/docs/BOTS.md) · [模型研究主报告](./ai/research/MODEL_STUDY.md) · [研究进展日志](./ai/research/PROGRESS_LOG.md)

## 本地运行

准备 Node.js **20.19+**；项目 CI 使用 Node.js 24。

```bash
git clone https://github.com/stevensun1005/guandanai.git
cd guandanai
npm ci
npm run build
npm run dev
```

打开 **http://127.0.0.1:8765/**。修改源文件后重新构建，再刷新页面。

```bash
npm test              # 规则、输入校验、模型特征和模块边界
npm run format:check  # 代码与文档格式
npm run build         # 完整生产构建
```

Python 用于开发阶段的模型训练、导出和浏览器验证，普通玩家与静态构建都不需要。详见 [贡献指南](./CONTRIBUTING.md)与[验证指南](./web/docs/TESTING.md)。

验证已覆盖三种窗口尺寸、双模型数值、座位恢复与三场完整自动比赛，合计 **37 局、2,957 手**；包含双端和四端。运行环境与结果见 [验证指南](./web/docs/TESTING.md)。

## 看得懂，也改得动

```text
web/                      网页端
  src/                    游戏、界面、联机与浏览器推理
  tools/                  构建、预览与打包
  tests/                  网页与浏览器验证
  docs/                   玩法、操作与部署
ai/                       AI
  danMCai/                danMCai 模型的训练、数据、评测、权重
  guanzero/               GuanZero 的独立训练与评测
  shared/                 公共模拟与固定测试局面
  research/               研究报告、交接与实验结果
  publishing/             网页模型发布与归档
  environment/            Python 依赖清单
```

源代码采用 ES Modules。生产构建负责打包、资源处理与版本标识；`web/dist` 是构建结果，不是开发入口。模块约定见 [架构文档](./web/docs/ARCHITECTURE.md)。

**[网页端 web/](web/README.md) · [AI ai/](ai/README.md) · [danMCai 模型](ai/danMCai/README.md) · [GuanZero](ai/guanzero/README.md)**。按功能寻找文件、运行数据和研究记录，见各目录 README；[旧路径迁移说明](ai/research/STRUCTURE_MIGRATION.md)。

## 发布你自己的版本

PR 会执行测试、格式、构建和真实浏览器出牌／牌谱导入检查；向 `main` 推送并通过检查后发布到 GitHub Pages。Pages 的 Source 选择 **GitHub Actions**。文档和实验检查点的归档推送不触发网站部署。

也可以把 `npm run build` 生成的 `web/dist` 目录完整上传到静态网站。请保留 `assets/` 与 `models/` 的相对位置，不要只上传 `index.html`。

## 常见问题

**朋友刷新还能回来吗？** 可以，在原标签页会尝试恢复原座位，等待期间由电脑接管。主动退出、切换模式，或房主明确退出、超过恢复时限后不能按原局恢复。

**房主能关闭页面吗？** 房主页面负责推进游戏。误关后，同版本、同一浏览器三小时内重新打开会尝试恢复原房间和牌桌；朋友凭原标签页的座位凭据回来，等待期间由电脑接管。明确退出、过期或换设备不恢复，也不会自动迁移房主。

**为什么朋友偶尔连不上？** 联机使用 WebRTC 与公共信令，双方的网络、NAT 和防火墙都会影响连接。双方刷新为相同页面版本后重试。

**为什么电脑有时要想几秒？** 默认的推理搜索机器人在中盘和尾盘做多世界推演，通常不到 1 秒。电脑和真人一样每手最多 60 秒：推理最多到回合开始后 50 秒（电脑和手机相同，含思考停顿和首次加载），留 10 秒给回落，超过就直接出冠军 017 的牌；Clint 电脑的残局大脑同样最多 30 秒且不超过 50 秒，超时出只用规则的出法。一手回落后，下一手照常推理。详见 [机器人设计](./web/docs/BOTS.md)。

**模型有没有偷偷看其他人的手牌？** 模型和推理搜索的输入仅包含当前座位自己的牌和公开信息。房主浏览器承担整桌游戏状态，这与模型的输入范围是两件事。

**支持哪些设备？** 主要验证现代 Chrome 桌面环境与手机尺寸布局；不同浏览器和真实设备的表现仍欢迎反馈。

## 一起把这一桌做好

欢迎带着可复现的场景提 [Issue](https://github.com/stevensun1005/guandanai/issues)，或提交小而明确的改进。UI 变化请附截图，牌型和策略变化请附具体牌局及验证结果。

[贡献流程](./CONTRIBUTING.md) · [机器人设计](./web/docs/BOTS.md) · [模型训练](./ai/research/MODEL_TRAINING.md) · [测试与评估](./web/docs/TESTING.md)

## 文档导航

| 想做什么           | 从这里开始                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开局、理牌或复盘   | [玩法](./web/docs/PLAYING.md) · [明牌练习](./web/docs/PRACTICE.md) · [出牌评价](./web/docs/MOVE_COACH.md)                                                                                    |
| 邀请朋友或恢复座位 | [房间与恢复](./web/docs/ROOMS.md)                                                                                                                                                            |
| 开发、测试或发布   | [贡献指南](./CONTRIBUTING.md) · [架构](./web/docs/ARCHITECTURE.md) · [测试](./web/docs/TESTING.md) · [部署](./web/docs/DEPLOYMENT.md)                                                        |
| 了解电脑和复现训练 | [机器人](./web/docs/BOTS.md) · [电脑选择与发布](./web/docs/WEB_MODELS.md) · [训练入口](./ai/research/MODEL_TRAINING.md) · [历史训练记录](./ai/research/TRAINING_RUN.md)                      |
| 核对模型成绩及计划 | [研究主报告](./ai/research/MODEL_STUDY.md) · [研究进展日志](./ai/research/PROGRESS_LOG.md) · [改进建议及实施状态](./ai/research/IMPROVEMENT_PROPOSAL.md) · [迭代路线](./web/docs/ROADMAP.md) |

GuanZero定时开发评测从2026-11-09晚批起包含Clint、danMCai冠军与danMCai-reason，各500场，完成后发布同一冻结模型。[运行协议](ai/guanzero/README.md#danmcai-reason评测协议)。
