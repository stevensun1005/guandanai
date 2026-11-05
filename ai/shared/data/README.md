# 真人联机数据

采集端和云端部署说明见 [web/collector](../../../web/collector/README.md)。这里保留下载及预处理工具；原始牌谱与生成样本在忽略的 `human-games/` 中，不进入 Git。

- `tools/fetch-human-games.mjs`：凭私有导出密钥分页下载，保存每把 JSON 与游标；重跑不覆盖不同内容。
- 下载默认排除测试局；`--include-tests` 仅供诊断，默认写入 `ai/danMCai/workspace/collection/export-validation/`。
- `tools/prepare-human-games.mjs`：校验原始完整牌局，输出仅人工动作的 JSONL。
- `tools/human-examples.mjs`：当前座位可见信息、原始内容 SHA 与整场分组，明确排除测试和托管动作。

数据先作为 `unverified_browser` 研究语料隔离保存，不自动训练或替换网页冠军。当前活跃训练不读取该目录。

出牌评价新增可选 `actions[].assisted=true`：同一手之前已展示数字预评的人工动作保留原始标记，但从默认样本中排除；只开关开启、仍在加载或事后评分不算。它是浏览器自报的展示状态，不是验证过的人类阅读或采纳行为。
