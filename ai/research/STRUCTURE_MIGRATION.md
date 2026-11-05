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

## 本机文件已经放到哪里

本次已实际迁移本机生成目录，不只调整源码入口：

- `ai/local/runs/gpu-main/`：当前 GPU 训练的配置、采样记录、分片、学习器、联赛与评测记录。
- `ai/local/checkpoints/`：原有 CPU/GPU 归档及迁移前第 242,498 步的完整检查点备份。
- `ai/local/data/generated/`：历史采集与训练数据；`ai/local/environment/`：本机 Python 环境。
- `ai/local/workspace/worktrees/`：已有开发工作树；`workspace/logs/legacy/`：历史日志；`workspace/maintenance/structure-migration/`：本次迁移的本机校验和草稿备份。
- `ai/publishing/cache/`：网页模型下载／发布缓存；`web/artifacts/validation/`：界面验证截图；`web/artifacts/packages/`：网页压缩包。

根目录保留隐藏的旧 `work/` 兼容入口，供冻结运行、旧开发工作树和历史绝对路径使用；少量历史临时现场保留在那里。根目录的 `node_modules/` 也是隐藏的开发依赖。日常查找代码从 `web/` 和 `ai/` 的 README 进入。不要手动删除兼容入口。

## 本机正在进行的训练

`D:/vibecoding/guandan-runtime` 是独立的冻结源码检出，不参与正式源码重排。当前运行继续由该检出执行，原始训练配置、模型、优化器、种子游标及已落盘样本保留；4 GiB 资源预留策略不变。

此次正常停机保存于 `v000242498`，迁移前后核对模型、包含优化器的检查点及原配置 SHA-256 后续跑；未变更冻结源码和协议，原截止时间仍为 2026-11-05 20:40:54 UTC。实时面板继续使用 <http://127.0.0.1:8766/>；面板和四小时发布任务均已切换到新路径。[校验证据](evaluation/structure-migration.json) 区分干净源码与带所有者草稿的本机验证。

本机保留旧生成目录的兼容连接，使当前运行和已有开发工作树的绝对路径仍可访问。连接只用于本机旧现场，不是两套正式源码，也不提交 Git。新代码、新运行与文档使用新位置。不要在仍有旧进程／开发工作树引用时删除这些连接。

文件移动不等于重新训练。历史评测附件保持原文，旧指纹应结合当时 Git 提交和冻结配置复现。新源码的路径、导入和文件指纹会变化；新训练必须使用新的配置，不能绕过旧运行的源码核对。

## 另一台电脑升级

1. 如果 GuanZero 仍在跑，先保存其启动命令、运行目录及当前提交，保留对应提交的独立运行检出。
2. 不在运行中的源码目录直接覆盖新布局。既有运行继续使用原冻结检出；保留其检查点、优化器、分片与种子计数。
3. 更新开发目录后，用根目录 `npm test`、`npm run build` 和对应 Python 测试验证。
4. 后续新运行放 `ai/guanzero/runs/`；旧运行续训仍由原冻结检出执行，数据可以暂留原位置。确需迁移时，先正常停止、核对数据和兼容路径，再从相同检查点恢复。

根目录的 `npm run build`、`npm run dev`、训练及面板命令保持可用；不要继续照旧文档运行已移动的源码路径。

## 后续新增入口

真人牌谱接收服务位于 `web/collector/`，浏览器队列位于 `web/src/collection/`，下载与预处理位于 `ai/shared/data/`；原始语料和生成样本不提交 Git，也不自动接入正在运行的训练。

GuanZero 工作站可在独立冻结检出中运行新版只读面板和 Clint 补充评测，实际来源以本机 `dashboard-launcher.json` 的 `sourceRoot`、`clint-companion-launcher.json` 为准。该评测检出与周期发布工作树分开，不能为了同步文档或网页代码向冻结检出拉取新源码。本文记录的本机路径和历史迁移时间属于对应工作站，不应直接套用到另一台电脑。
