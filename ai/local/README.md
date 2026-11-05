# 本机模型

这条路线从现有价值网络出发训练；与 GuanZero 的随机初始化路线分开。

| 找什么                           | 位置                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| 持续训练调度                     | [training/continuous/supervisor.mjs](training/continuous/supervisor.mjs) |
| 网络结构与 ONNX 导出             | [training/continuous/value_net.py](training/continuous/value_net.py)     |
| 优化器、重放缓冲与学习器         | [training/continuous/learner.py](training/continuous/learner.py)         |
| 自对弈采样、GPU 推理、内存预算   | [training/continuous](training/continuous)                               |
| 历史 PPO、完整网络、辅助任务实验 | [training](training)                                                     |
| 数据采集工具                     | [data/tools](data/tools)                                                 |
| 完整比赛、规则对手与策略评测     | [evaluation](evaluation)                                                 |
| 原始模型与参考权重               | [models/baseline](models/baseline)                                       |
| 已有历史实验检查点               | [models/experiments](models/experiments)                                 |
| 独立 NumPy 编码与数值参考        | [reference](reference)                                                   |
| 本路线测试                       | [tests](tests)                                                           |

本机生成目录：`runs/` 存运行数据与实时面板记录，`checkpoints/` 存保留的检查点，`data/generated/` 存采集数据，`environment/` 存本机环境，`workspace/` 存开发工作树与临时实验。它们均不提交 Git。

根目录常用命令仍为 `npm run train:status`、`npm run train:dashboard`。正在运行的 `gpu-main` 继续使用原冻结运行环境，先读[迁移说明](../research/STRUCTURE_MIGRATION.md)，不要用新布局源码直接覆盖旧运行。

网页中的产品名称为 danMCai，显示真实版本，如 `danMCai-v000293055`。网页默认取本路线实际门控冠军，不能按 `models/latest.json` 的最大步数代替；最新两次晋升、accept 门控和完整 SHA 都需核对。[菜单与发布](../../web/docs/WEB_MODELS.md)。真人数据的采集与预处理独立于本训练，未经实验不改动正在运行的缓冲区或对手池。
