# AI

两条训练路线分开存放，公共模拟、研究证据和网页发布各有入口。

| 目录                               | 内容                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| [danMCai](danMCai/README.md)       | danMCai 模型：从原始价值网络继续训练，含持续自对弈与历史实验     |
| [guanzero](guanzero/README.md)     | 另一条 GuanZero 路线：历史序列网络及其独立训练、推理、评测和面板 |
| [shared](shared/README.md)         | 两条路线复用的对局模拟与测试局面                                 |
| [research](research/README.md)     | 主研究报告、交接、训练说明和机器可读实验结果                     |
| [publishing](publishing/README.md) | 将训练检查点注册、归档并发布到网页                               |
| [environment](environment)         | Python 依赖清单                                                  |

先看 [研究报告](research/MODEL_STUDY.md) 了解真实架构、已完成结果和局限；继续训练前读 [交接文档](research/CODEX_HANDOFF.md)。

当前训练快照不会因目录整理自动更新源码或清空数据。运行中的旧布局与迁移路径见 [迁移说明](research/STRUCTURE_MIGRATION.md)。

网页提供 Clint 纯规则、GuanZero 两代及 danMCai 初始版／两代门控冠军；普通新导出不自动成为默认。[菜单与发布](../web/docs/WEB_MODELS.md) 统一维护名称和选择范围。

GuanZero 开发评测包含随机、原版规则、P0 和 Clint（rules-v2），旧检出可独立补评，详见 [GuanZero](guanzero/README.md)。真人联机数据经独立云端服务采集，下载与预处理入口在 [共享数据](shared/data/README.md)，不自动接入活跃训练。
