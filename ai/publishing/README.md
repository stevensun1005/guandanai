# 发布模型到网页

- [publish-web-model.mjs](publish-web-model.mjs)：冻结完整导出、验证、上传 Release、注册模型并记录证据。
- [artifacts.mjs](artifacts.mjs)：构建时下载模型并核对 SHA-256。
- [archive-models.py](archive-models.py)：历史权重归档工具。
- `cache/`：本机发布与下载缓存，不提交 Git。

玩家看到的模型名称来自真实训练版本；正式清单位于 [web/src/ai/model-catalog.json](../../web/src/ai/model-catalog.json)。[发布与另一台电脑接入说明](../../web/docs/WEB_MODELS.md)。

## 当前菜单与同步规则

仅提供 Clint、GuanZero 最近两代、danMCai 初始版和danMCai 最近两代真实门控冠军，默认danMCai 现任冠军。GuanZero 名称为 `训练任务名-版本数值`，发布新代只轮换它的两项；不可变 Release 和历史证据保留。具体参数、冠军证据及默认保护以 [WEB_MODELS.md](../../web/docs/WEB_MODELS.md) 为准。

周期同步同时归档新完成的 Clint 开发评测；即使没有新权重，也应识别新的评测证据。发布或命名变化同步根 README、相关指南、CHANGELOG 与研究报告，不能仅更新清单。
