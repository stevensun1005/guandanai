# 实验模型成果

本目录中的模型是研究检查点，不属于网页默认部署。普通玩家只加载 `web/src/ai/model-catalog.json` 指定的模型。

- `asymmetric-pilot/`：四组“公开出牌网络＋公开／明牌评价网络、全新牌局／难局重打”对照中已完成周期的模型。`actor.npz` 与 `policy.onnx` 是同一个公开信息出牌网络，`critic.npz` 只供训练使用。`training.json` 保存参数变化、数据指纹与行为概率核对。
- `asymmetric-next/`：扩大样本后的四组对照；只加入已经完成的周期。每组从同一初始化开始，各周期接续自己的 Actor 与 Critic，按训练数据学习，不按开发成绩拼接不同模型。
- 历史大量检查点通过 GitHub 实验附件存档，文件目录、SHA-256 与下载入口记录在 `ai/research/evaluation/model-artifacts.json`。其存在不表示通过验收；失败与流程检查的产物同样保留。
- 暂停的 CPU 持续训练另有 D 盘校验归档 `ai/local/checkpoints/cpu-main-2026-11-04-step-20923/`，包含第 20,923 步完整模型、优化器、现存训练分片与日志。[逐文件保留清单](../../../research/evaluation/cpu-main-retention-2026-11-04.json)和成果索引的 `localArchives` 记录哈希与留存范围；这批二进制数据未上传 Git 或 Release。更早已被滚动缓冲区淘汰的原始行没有恢复，当前 GPU 独立运行也没有继承该 CPU 检查点。

实验标签、开发与留出用途，以及实际数据见 [模型研究报告](../../../research/MODEL_STUDY.md)。训练缓冲区体积较大，未混入网页资源或此检查点目录。

实验配置中的锚点路径已改为仓库内的相对路径，使用时从仓库根目录运行；权重内容不因此改变。原训练路径与数据指纹仍保留在训练报告中。

JSON 训练报告在 Git 中统一使用 LF 换行；证据快照同时记录本地原文件的 `trainingReportSHA256` 和发布文件的 `publishedTrainingReportSHA256`，避免 Windows 换行转换造成核对歧义。二进制权重直接保留原字节。
