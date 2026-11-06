# danMCai 模型

当前总体目标是持续提升整体棋力，并帮助所有者复盘和提高水平；80% 仅保留为历史实验阈值。能力评价与尚待验证的教学方向见[主报告](../research/MODEL_STUDY.md)，本次目标澄清不修改活跃冻结训练。

这条路线从现有价值网络出发训练；与 GuanZero 的随机初始化路线分开。

本次转交 MacBook 的环境安装、迁移附件、MPS 实测与**仅一个 24 小时窗口**见 [Mac 交接](../research/MAC_HANDOFF.md)。Windows 模型、优化器、当前回放和历史记录保留。M1 Pro 已通过真实 MPS／Adam／ONNX 预检并从现有检查点续训；首次内存计数问题、恢复指纹及原固定截止见交接和主报告第 28 节，完整窗口和棋力结论仍待实际证据。

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

网页中的产品名称为 danMCai，显示真实版本，如 `danMCai-v000705434`。网页默认取本路线实际门控冠军，不能按 `models/latest.json` 的最大步数代替；最新两次晋升、accept 门控和完整 SHA 都需核对。[菜单与发布](../../web/docs/WEB_MODELS.md)。真人数据的采集与预处理独立于本训练，未经实验不改动正在运行的缓冲区或对手池。

Fixed 2v2 evaluation: `evaluation/evaluate-fixed.mjs --protocol=<JSON> --run=<ignored run>` binds both teammates to one checkpoint, swaps teams per seed and writes resumable full-match records. `evaluation/summarize_independent.py` reports paired-seed uncertainty; current protocols are indexed in the [research report](../research/MODEL_STUDY.md).

`evaluation/monitor-fixed.mjs` 读取实际完成状态，把分组计数和桌面观测供给本机进度面板；完成进程正常退出不误判失败，告警不修改模型、奖励或训练配置。已有固定比较的完整报告见[冠军与最新导出对照](../research/reports/champion-clint-latest-20261105.md)。

Mac 吞吐调优使用启动器的具名采样配置入口，正常保存后调整并发并实测，保持原内存预算、学习协议与固定截止；当前冻结检出和恢复命令以 [MAC_HANDOFF](../research/MAC_HANDOFF.md#当前-mac-执行入口2026-11-05) 为准。

本次 Mac 门控已按所有者授权改为新快照优先，普通旧快照不补赛，最近两位前冠军低频检查，P0 退步监控保留；训练对手池与原固定截止沿用。参数、运行边界和测试见[持续训练指南](../research/CONTINUOUS_TRAINING.md#新快照优先的门控调度)。
