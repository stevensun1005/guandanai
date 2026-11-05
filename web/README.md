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
| 独立纯规则对手及版本边界       | [src/rule-bot](src/rule-bot/README.md)                                                         |
| 当前上线模型与默认值           | [src/ai/model-catalog.json](src/ai/model-catalog.json)                                         |
| 构建、预览、打包               | [tools](tools)                                                                                 |
| 网页测试                       | [tests](tests)                                                                                 |
| 操作与部署文档                 | [docs](docs)                                                                                   |

当前电脑菜单包含 Clint、GuanZero 最近两代、danMCai 初始版与两代本机冠军。GuanZero 使用 `训练任务名-版本数值`，默认仍由本机现任冠军决定；完整顺序与发布规则见 [电脑选择](docs/WEB_MODELS.md)。Clint 不加载 ONNX；网络模型在实际决策时由房主浏览器按需加载。

在项目根目录运行：

```bash
npm run build
npm run dev
```

构建输出在 `web/dist/`，浏览器测试截图在 `web/artifacts/validation/`，打包文件在 `web/artifacts/packages/`。这些是生成内容，不提交 Git。也可以双击本目录的 `启动预览.cmd`。

训练代码在 [AI 目录](../ai/README.md)。牌规和公开信息编码由网页与训练共同复用，不另复制一套。
