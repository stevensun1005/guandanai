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

当前 MacBook 接手仅有一个 24 小时窗口，原生环境、只读迁移附件、冻结检出及恢复流程见 [Mac 交接](research/MAC_HANDOFF.md)；依赖入口见 [共享环境](environment/README.md)。Windows 原运行保留，不因代码同步自动重启。

M1 Pro 真机已完成迁移和 MPS／Adam／ONNX 预检并恢复续训；本次固定截止、内存计数修正和实际新增量统一见[主报告第 28 节](research/MODEL_STUDY.md#28-2026-11-05mac-真机预检与固定窗口启动)，尚未完成整个 24 小时窗口。

当前训练快照不会因目录整理自动更新源码或清空数据。运行中的旧布局与迁移路径见 [迁移说明](research/STRUCTURE_MIGRATION.md)。

网页菜单 2026-11-09 起只有四项：Clint 纯规则、最新一代 GuanZero、danMCai 现任门控冠军和默认的 danMCai-reason（冠军加推断网络搜索，出牌评价也默认用它）；普通新导出不自动成为默认。[菜单与发布](../web/docs/WEB_MODELS.md) 统一维护名称和选择范围。

GuanZero 当前开发评测只保留danMCai冠军500场和reason200场（250/100对），Clint不再参与；历史报告原样保留。详见[GuanZero](guanzero/README.md)。真人联机数据经独立云端服务采集，下载与预处理入口在 [共享数据](shared/data/README.md)，不自动接入活跃训练。
