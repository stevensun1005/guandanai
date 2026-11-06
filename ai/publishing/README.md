# 发布模型到网页

- [publish-web-model.mjs](publish-web-model.mjs)：冻结完整导出、验证、上传 Release、注册模型并记录证据。
- [artifacts.mjs](artifacts.mjs)：构建时下载模型并核对 SHA-256。
- [archive-models.py](archive-models.py)：历史权重归档工具。
- `cache/`：本机发布与下载缓存，不提交 Git。

玩家看到的模型名称来自真实训练版本；正式清单位于 [web/src/ai/model-catalog.json](../../web/src/ai/model-catalog.json)。[发布与另一台电脑接入说明](../../web/docs/WEB_MODELS.md)。

## 当前菜单与同步规则

Mac 续训与 Windows 原运行按相同冠军证据发布；`--source` 写实际运行名，清单的 `source.champion` 绑定 accept 记录和 SHA。普通归档步骤仍不自动晋升默认模型。

仅提供 Clint、GuanZero 最近两代、danMCai 初始版和danMCai 最近两代真实门控冠军，默认danMCai 现任冠军。GuanZero 名称为 `训练任务名-版本数值`，发布新代只轮换它的两项；不可变 Release 和历史证据保留。具体参数、冠军证据及默认保护以 [WEB_MODELS.md](../../web/docs/WEB_MODELS.md) 为准。

周期同步同时归档新完成的 Clint 开发评测；即使没有新权重，也应识别新的评测证据。发布或命名变化同步根 README、相关指南、CHANGELOG 与研究报告，不能仅更新清单。

## 进还贡阶段适配器

`finalize-tribute.mjs --run=<专项运行绝对路径>` 仅在固定窗口停止后，在专用干净检出安全同步 main，核对冻结源码及权重，执行预登记的独立单局交换阵营评测与 Chrome WASM 验证。它不通过完整策略的 513/54 接口发布工具注册，而以独立 389→2 接口和不可变 SHA Release 归档；不增加菜单项、不替换冠军、不修改两条主网络。

两头均未退步且达到协议区间门槛时才写 `tribute-model.json` 的批准底座 SHA；新底座不会自动继承批准。负结果也提交研究证据，网页仍走原贡还。`--preflight` 只用专用短测运行检查流程，不上传、提交或推送。验证 Python 默认 `python`，专项 GPU Python 只供训练进程使用。失败现场保存在运行目录的 `fusion-error.json`；不覆盖既有 Release。
