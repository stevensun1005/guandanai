# 发布模型到网页

- [publish-web-model.mjs](publish-web-model.mjs)：冻结完整导出、验证、上传 Release、注册模型并记录证据。
- [artifacts.mjs](artifacts.mjs)：构建时下载模型并核对 SHA-256。
- [archive-models.py](archive-models.py)：历史权重归档工具。
- `cache/`：本机发布与下载缓存，不提交 Git。

玩家看到的模型名称来自真实训练版本；正式清单位于 [web/src/ai/model-catalog.json](../../web/src/ai/model-catalog.json)。[发布与另一台电脑接入说明](../../web/docs/WEB_MODELS.md)。
