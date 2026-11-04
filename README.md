<div align="center">

# GuandanAI

[English](README.en.md) · 简体中文

### 掼蛋朋友局 · 打开网页，就坐一桌

四人组队、房间邀请、浏览器内智能对手。电脑和手机都能玩。

[![Deploy](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml/badge.svg)](https://github.com/stevensun1005/guandanai/actions/workflows/pages.yml)
[![Version](https://img.shields.io/github/package-json/v/stevensun1005/guandanai?color=ddb050)](CHANGELOG.md)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-f7df1e?logo=javascript&logoColor=black)
![Runtime](https://img.shields.io/badge/Runtime-Browser_%2B_WebAssembly-4a7c59)

**[立即开局](https://stevensun1005.github.io/guandanai/) · [玩法指南](docs/PLAYING.md) · [下载发布包](https://github.com/stevensun1005/guandanai/releases/latest) · [开发指南](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)**

</div>

![实际对局画面](docs/media/table-desktop.png)

<details>
<summary>更多界面：电脑性格与手机操作帮助</summary>

<p align="center"><img src="docs/media/bot-profiles.png" width="340" alt="每个电脑座位独立选择性格" /> <img src="docs/media/help-mobile.png" width="280" alt="手机上的操作帮助" /></p>

</details>

## 一张链接，一桌朋友

1. 打开游戏，输入昵称，选择 **开房间**。
2. 选择自己的座位，点 **复制邀请链接** 发给朋友。
3. 朋友打开链接、输入昵称、选择座位。房主点 **开始**。

没人坐的座位由电脑接管，一个人也能直接开局。朋友刷新原标签页后可恢复座位；对局期间请保持房主页面打开。详见 [房间与恢复](docs/ROOMS.md)。

## 已经能做什么

| 体验     | 内容                                                       |
| -------- | ---------------------------------------------------------- |
| 四人掼蛋 | 两副牌、百搭、同花顺、进还贡、接风、升级打 A               |
| 朋友房间 | 邀请链接、房间号、座位选择、掉线接管与原标签页恢复         |
| 智能电脑 | 强化学习主策略与独立应牌网络，全部在浏览器后台推理         |
| 手牌操作 | 拖动、扫选、成组、智能理牌、按花色排序、理牌撤销、三种布局 |
| 出牌辅助 | 合法出牌提示、同花顺查找、可选二次确认、跨局牌谱与整场战况 |
| 对局氛围 | 音效、全屏、可选语音、出牌动画与结果展示                   |
| 静态部署 | GitHub Pages 自动发布，所有模型资源随网页部署              |

大厅里可为每个电脑空位选择 **均衡、激进、稳健、观察、融合**；也可以点「来一桌不同性格」。风格会随房间同步。最后两家、剩余牌可由公开信息唯一确定时，电脑还会核算小型残局的必走路线。实现细节与验证范围见 [电脑对手](docs/BOTS.md)，下一步见 [Roadmap](docs/ROADMAP.md)。

## 为浏览器而做

想看清一局牌，可以从大厅进入 **[复盘练习](docs/PRACTICE.md)**：四家明牌、单步推进、写评语、回看，记录可以导出后在其他设备导入。

玩家无需安装 Node.js、Python 或桌面客户端。页面加载后，电脑出牌由 Web Worker 和 WebAssembly 在房主浏览器中计算。模型只接收自己的手牌、公开出牌、剩余张数和级数。观察型可额外使用独立训练的应牌网络；训练过程、留出成绩和适用范围都公开在 [模型训练指南](docs/MODEL_TRAINING.md)。

需要在本机运行电脑时，才下载推理组件和模型；加入朋友房间的玩家无需先等模型加载。资源加载失败时会给出重试入口，不会悄悄切换成另一种电脑策略。

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

Python 仅用于模型导出和开发验证，普通玩家与静态部署都不需要。详见 [验证指南](docs/TESTING.md)。

验证已覆盖三种窗口尺寸、双模型数值、座位恢复与三场完整自动比赛，合计 **37 局、2,957 手**；包含双端和四端。运行环境与结果见 [验证指南](docs/TESTING.md)。

## 看得懂，也改得动

```text
src/
  index.html          页面结构，不放游戏程序
  app.js              功能装配与初始化
  core/               无 DOM 依赖的牌、牌型、出牌生成和校验
  game/               发牌、进还贡、回合、计时、事件与结算
  hand/               理牌、提示、手牌视图与布局
  input/              玩家操作、拖动与快捷键
  ai/                 电脑控制、策略评估、特征编码与 Worker
  network/            房间、消息协议、座位恢复、状态快照与语音
  lobby/              大厅与座位
  ui/                 牌面、牌桌、计时与弹层
  replay/             对局记录、回看与导入导出
  audio/ effects/     声音与动画
  styles/ assets/     按功能拆分的样式和图片
ai/                   策略模型与数值验证工具
scripts/              构建、预览、模型导出和打包
tests/                Node 单元检查与真实浏览器验证
docs/                 玩法、架构、机器人与迭代路线
```

源代码采用 ES Modules。生产构建负责打包、资源处理与版本标识；`dist` 是构建结果，不是开发入口。模块约定见 [架构文档](docs/ARCHITECTURE.md)。

## 发布你自己的版本

向 `main` 推送后，GitHub Actions 会执行检查、构建并发布到 GitHub Pages。Pages 的 Source 选择 **GitHub Actions**。

也可以把 `npm run build` 生成的 `dist` 目录完整上传到静态网站。请保留 `assets/` 与 `models/` 的相对位置，不要只上传 `index.html`。

## 常见问题

**朋友刷新还能回来吗？** 可以，在原标签页会尝试恢复原座位，等待期间由电脑接管。主动退出、切换模式或房主重新加载后不能按原局恢复。

**房主能关闭页面吗？** 房主页面负责推进游戏。关闭后，其他人可以在本机选择由电脑继续打，但不会自动产生新的联机房主。

**为什么朋友偶尔连不上？** 联机使用 WebRTC 与公共信令，双方的网络、NAT 和防火墙都会影响连接。双方刷新为相同页面版本后重试。

**模型有没有偷偷看其他人的手牌？** 模型输入仅包含当前座位自己的牌和公开信息。房主浏览器承担整桌游戏状态，这与模型的输入范围是两件事。

**支持哪些设备？** 主要验证现代 Chrome 桌面环境与手机尺寸布局；不同浏览器和真实设备的表现仍欢迎反馈。

## 一起把这一桌做好

欢迎带着可复现的场景提 [Issue](https://github.com/stevensun1005/guandanai/issues)，或提交小而明确的改进。UI 变化请附截图，牌型和策略变化请附具体牌局及验证结果。

[贡献流程](CONTRIBUTING.md) · [机器人设计](docs/BOTS.md) · [模型训练](docs/MODEL_TRAINING.md) · [测试与评估](docs/TESTING.md)
