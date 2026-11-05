# 目录迁移与运行兼容

正式源码现在按 `web/` 与 `ai/` 分类。根目录仅保留工作区配置、README、GitHub 配置和共享依赖。各大目录的 README 提供功能入口。

| 原位置                         | 新位置                                         |
| ------------------------------ | ---------------------------------------------- |
| `src/`                         | `web/src/`                                     |
| 网页构建、预览、打包脚本       | `web/tools/`                                   |
| 网页测试与操作文档             | `web/tests/`、`web/docs/`                      |
| `scripts/continuous/`          | `ai/local/training/continuous/`                |
| 其他本机 Python 训练代码       | `ai/local/training/`                           |
| 本机数据采集、评测工具         | `ai/local/data/tools/`、`ai/local/evaluation/` |
| `scripts/guanzero/`            | `ai/guanzero/training/`                        |
| `scripts/lib/`                 | `ai/shared/simulation/`                        |
| `tests/fixtures/`              | `ai/shared/fixtures/`                          |
| `ai/policy.*`、`ai/response.*` | `ai/local/models/baseline/`                    |
| `ai/experiments/`              | `ai/local/models/experiments/`                 |
| 研究报告、交接及评测 JSON      | `ai/research/`、`ai/research/evaluation/`      |
| `work/continuous/`             | `ai/local/runs/`                               |
| `work/archives/`               | `ai/local/checkpoints/`                        |
| 其他本机临时现场               | `ai/local/workspace/`                          |

## 本机正在进行的训练

`D:/vibecoding/guandan-runtime` 是独立的冻结源码检出，不参与正式源码重排。当前运行继续由该检出执行，原始训练配置、模型、优化器、种子游标及已落盘样本保留；4 GiB 资源预留策略不变。

本机保留旧生成目录的兼容连接，使当前运行和已有开发工作树的绝对路径仍可访问。连接只用于本机旧现场，不是两套正式源码，也不提交 Git。新代码、新运行与文档使用新位置。不要在仍有旧进程／开发工作树引用时删除这些连接。

文件移动不等于重新训练。历史评测附件保持原文，旧指纹应结合当时 Git 提交和冻结配置复现。新源码的路径、导入和文件指纹会变化；新训练必须使用新的配置，不能绕过旧运行的源码核对。

## 另一台电脑升级

1. 如果 GuanZero 仍在跑，先保存其启动命令、运行目录及当前提交，保留对应提交的独立运行检出。
2. 不在运行中的源码目录直接覆盖新布局。既有运行继续使用原冻结检出；保留其检查点、优化器、分片与种子计数。
3. 更新开发目录后，用根目录 `npm test`、`npm run build` 和对应 Python 测试验证。
4. 后续新运行放 `ai/guanzero/runs/`；旧运行续训仍由原冻结检出执行，数据可以暂留原位置。确需迁移时，先正常停止、核对数据和兼容路径，再从相同检查点恢复。

根目录的 `npm run build`、`npm run dev`、训练及面板命令保持可用；不要继续照旧文档运行已移动的源码路径。
