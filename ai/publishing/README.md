# 发布模型到网页

- [publish-web-model.mjs](publish-web-model.mjs)：冻结完整导出、验证、上传 Release、注册模型并记录证据。
- [artifacts.mjs](artifacts.mjs)：构建时下载模型并核对 SHA-256。
- [archive-models.py](archive-models.py)：历史权重归档工具。
- [publish-belief-asset.mjs](publish-belief-asset.mjs)：把研究机器人（`searchBots`）的推断网络发布为固定 Release 附件；先按清单核对 SHA 和大小并写入构建缓存，`--publish` 才建 tag（不覆盖已有 tag）并核对公网 SHA。清单项由人工编写和审查，工具不改清单。
- `cache/`：本机发布与下载缓存，不提交 Git。

玩家看到的模型名称来自真实训练版本；正式清单位于 [web/src/ai/model-catalog.json](../../web/src/ai/model-catalog.json)。[发布与另一台电脑接入说明](../../web/docs/WEB_MODELS.md)。

## 当前菜单与同步规则

Mac 续训与 Windows 原运行按相同冠军证据发布；`--source` 写实际运行名，清单的 `source.champion` 绑定 accept 记录和 SHA。普通归档步骤仍不自动晋升默认模型。

2026-11-09 起菜单只提供四项：Clint、最近注册的一代 GuanZero、danMCai 现任真实门控冠军（`danMCaiChampions[0]`）和研究机器人 9001（danMCai-reason-v000855042，017＋推断网络搜索，所有者授权，非冠军）；初始版、上一任冠军与旧 GuanZero 只保留归档。按所有者 2026-11-09 指示，菜单默认 `selection.defaultChoice` 为 9001，`defaultId` 仍是danMCai 现任冠军。`publish-web-model.mjs` 只改 `models` 与 `webModels`，保留 `searchBots` 与 `defaultChoice`；冠军更换后若 `defaultChoice` 的底座不再是现任冠军，清单校验会失败，须另行决定。GuanZero 名称为 `训练任务名-版本数值`，发布新代替换菜单里的旧一代；不可变 Release 和历史证据保留。具体参数、冠军证据及默认保护以 [WEB_MODELS.md](../../web/docs/WEB_MODELS.md) 为准。

周期同步同时归档新完成的 Clint 开发评测；即使没有新权重，也应识别新的评测证据。发布或命名变化同步根 README、相关指南、CHANGELOG 与研究报告，不能仅更新清单。

本次 Mac 唯一窗口结束后，最终冠军已核对并复用归档 017，对应的 `danmcai` 周期任务已删除。训练晋升与网页发布仍是独立流程；新运行须在执行电脑按授权重新配置发布检查，不能重开原窗口。当前菜单及证据以 WEB_MODELS 和发布 JSON 为准。

## 进还贡阶段适配器

`finalize-tribute.mjs --run=<专项运行绝对路径>` 仅在固定窗口停止后，在专用干净检出安全同步 main，核对冻结源码及权重，执行预登记的独立单局交换阵营评测与 Chrome WASM 验证。它不通过完整策略的 513/54 接口发布工具注册，而以独立 389→2 接口和不可变 SHA Release 归档；不增加菜单项、不替换冠军、不修改两条主网络。

两头均未退步且达到协议区间门槛时才写 `tribute-model.json` 的批准底座 SHA；新底座不会自动继承批准。负结果也提交研究证据，网页仍走原贡还。`--preflight` 只用专用短测运行检查流程，不上传、提交或推送。验证 Python 默认 `python`，专项 GPU Python 只供训练进程使用。失败现场保存在运行目录的 `fusion-error.json`；不覆盖既有 Release。

本机 io48 从已完成的十二小时批次发布，准备与正式发布都须提供 `--evaluated-suite` 和该目录的 `model.onnx`。详见[同批发布](../../web/docs/WEB_MODELS.md#guanzero-每十二小时评测并发布)。
