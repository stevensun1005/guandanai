# 网页端

浏览器游戏、界面、房间联机和浏览器模型推理都从这里找。

| 找什么                         | 位置                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 页面与启动流程                 | [src/index.html](src/index.html)、[src/app.js](src/app.js)、[src/app](src/app)                 |
| 牌规、牌型、比赛结算           | [src/core](src/core)                                                                           |
| 发牌、回合、进还贡             | [src/game](src/game)                                                                           |
| 手牌排列、选择、理牌           | [src/hand](src/hand)                                                                           |
| UI、动画、音效、样式           | [src/ui](src/ui)、[src/effects](src/effects)、[src/audio](src/audio)、[src/styles](src/styles) |
| 房间、重连、语音               | [src/network](src/network)、[src/lobby](src/lobby)                                             |
| 匿名牌谱、断网补传、云端数据库 | [src/collection](src/collection)、[collector](collector/README.md)                             |
| 模型选择、Worker 与浏览器推理  | [src/ai](src/ai)                                                                               |
| 冠军出牌评价、个人开关与相对分 | [src/coach](src/coach)、[使用说明](docs/MOVE_COACH.md)                                         |
| 独立纯规则对手及版本边界       | [src/rule-bot](src/rule-bot/README.md)                                                         |
| 当前上线模型与默认值           | [src/ai/model-catalog.json](src/ai/model-catalog.json)                                         |
| 构建、预览、打包               | [tools](tools)                                                                                 |
| 网页测试                       | [tests](tests)                                                                                 |
| 操作与部署文档                 | [docs](docs)                                                                                   |

当前电脑菜单包含 Clint、GuanZero 最近两代、danMCai 初始版与两代danMCai 冠军。GuanZero 使用 `训练任务名-版本数值`，默认仍由danMCai 现任冠军决定；完整顺序与发布规则见 [电脑选择](docs/WEB_MODELS.md)。Clint 不加载 ONNX；网络模型在实际决策时由房主浏览器按需加载。

在项目根目录运行：

```bash
npm run build
npm run dev
```

构建输出在 `web/dist/`，浏览器测试截图在 `web/artifacts/validation/`，打包文件在 `web/artifacts/packages/`。这些是生成内容，不提交 Git。也可以双击本目录的 `启动预览.cmd`。

训练代码在 [AI 目录](../ai/README.md)。牌规和公开信息编码由网页与训练共同复用，不另复制一套。

出牌评价可在开局前选择，右侧 Top 5 点击只选牌；普通分数、房主许可和数据标记见 [MOVE_COACH](docs/MOVE_COACH.md)。

## 进还贡专项接入

[共享专项](../ai/shared/tribute/README.md) 使用独立 Worker 与批准底座 SHA，覆盖机器人进贡、还贡及理牌期间提前还贡；真人、Clint 与未批准模型维持原行为。当前组件默认关闭，启用须有固定窗口独立结果和浏览器验证，不增加菜单项。

## 开局与屏幕适配

`src/lobby/start-state.mjs` 负责房主的初始续局状态和视角旋转，`src/lobby/level.js` 提供双队级数、名次与失败次数弹窗。只在首场首次开局应用；房间恢复保留当前状态。`src/ui/viewport.js` 合并尺寸事件并对齐名字牌，不修改 viewport meta；`#debug` 可查看尺寸诊断。使用方法见 [上桌指南](docs/PLAYING.md)，检查记录见 [Clint 增量同步](../ai/research/evaluation/clint-sync-20261106.json)。
