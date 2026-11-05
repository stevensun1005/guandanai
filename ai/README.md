# AI

两条训练路线分开存放，公共模拟、研究证据和网页发布各有入口。

| 目录                               | 内容                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| [local](local/README.md)           | 本机模型：从原始价值网络继续训练，含持续自对弈与历史实验         |
| [guanzero](guanzero/README.md)     | 另一条 GuanZero 路线：历史序列网络及其独立训练、推理、评测和面板 |
| [shared](shared/README.md)         | 两条路线复用的对局模拟与测试局面                                 |
| [research](research/README.md)     | 主研究报告、交接、训练说明和机器可读实验结果                     |
| [publishing](publishing/README.md) | 将训练检查点注册、归档并发布到网页                               |
| [environment](environment)         | Python 依赖清单                                                  |

先看 [研究报告](research/MODEL_STUDY.md) 了解真实架构、已完成结果和局限；继续训练前读 [交接文档](research/CODEX_HANDOFF.md)。

当前训练快照不会因目录整理自动更新源码或清空数据。运行中的旧布局与迁移路径见 [迁移说明](research/STRUCTURE_MIGRATION.md)。
