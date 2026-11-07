# 网页端

## 对局布局与手牌复原

高度足够时，电脑 Top 5 在独立侧栏显示，收起释放牌桌空间；选牌评价继续保留。操作按钮、计时与成组工具随空间排列，少牌时仍预留操作列高度，矮窗口支持两列；局末按钮留在结果卡内。手牌「复原」恢复散牌大小顺序，保留手动成组，支持撤销；四家明牌练习恢复建议牌型分组。操作细节见 [玩法](docs/PLAYING.md) 与 [评价](docs/MOVE_COACH.md)。

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

Clint 的普通出牌与真人超时分别维护；早前的公开牌史策略修订只改变规则对手，范围、例外及指纹见 [规则模块](src/rule-bot/README.md#公开牌史策略更新)。

## 训练与公开观战

大厅「训练」保留单机明牌复盘；「观战」通过四位房间号查看公开牌面，不占座、不接收私牌、不操作牌局。实现分为 `src/network/public-table.mjs` 的纯数据投影／验证、`src/network/spectators.js` 的独立连接与视图，语音仍由 `network/voice.js` 处理。房主选项新增房间号及逐个观众的语音开关。使用与测试见 [上桌指南](docs/PLAYING.md#观战朋友的牌桌)、[验证指南](docs/TESTING.md#公开观战与语音回归)。此前四个 UI 提交没有修改 Clint 策略、神经网络或冻结训练。

## 配牌训练

大厅训练入口提供「配牌」「牌局」「残局」。残局使用独立 Clint 练习 Worker，限定每家最多10张，完整求解才给最优路线；不接入普通机器人或模型训练。`src/practice/groups.mjs` 只处理实体牌分组编辑与记录校验，`src/practice/arrangement.js` 提供独立界面、500 手本机保存和文本导出；参考分不是神经网络输出。它不连接牌谱上传／训练管线，原明牌桌和模型选择保留。使用说明见 [训练指南](docs/PRACTICE.md)。
