# 目录迁移与运行兼容

本次 MacBook 接手使用[独立交接指南](MAC_HANDOFF.md)：Git 克隆源码、私下复制带校验的训练 ZIP、原生重装依赖，在冻结 detached worktree 的新目录续训。Mac 主项目的规范运行入口可以链接到该冻结检出的运行目录；不把 Windows 目录连接、虚拟环境或 node_modules 复制过去，不覆盖 Windows 的原运行。旧源码及配置的历史字节保持原样；Mac 的 MPS、采样器和种子变化作为新协议记录。

正式源码现在按 `web/` 与 `ai/` 分类。根目录仅保留工作区配置、README、GitHub 配置和共享依赖。各大目录的 README 提供功能入口。

| 原位置                         | 新位置                                             |
| ------------------------------ | -------------------------------------------------- |
| `src/`                         | `web/src/`                                         |
| 网页构建、预览、打包脚本       | `web/tools/`                                       |
| 网页测试与操作文档             | `web/tests/`、`web/docs/`                          |
| `scripts/continuous/`          | `ai/danMCai/training/continuous/`                  |
| 其他 danMCai Python 训练代码   | `ai/danMCai/training/`                             |
| 本机数据采集、评测工具         | `ai/danMCai/data/tools/`、`ai/danMCai/evaluation/` |
| `scripts/guanzero/`            | `ai/guanzero/training/`                            |
| `scripts/lib/`                 | `ai/shared/simulation/`                            |
| `tests/fixtures/`              | `ai/shared/fixtures/`                              |
| `ai/policy.*`、`ai/response.*` | `ai/danMCai/models/baseline/`                      |
| `ai/experiments/`              | `ai/danMCai/models/experiments/`                   |
| 研究报告、交接及评测 JSON      | `ai/research/`、`ai/research/evaluation/`          |
| `work/continuous/`             | `ai/danMCai/runs/`                                 |
| `work/archives/`               | `ai/danMCai/checkpoints/`                          |
| 其他本机临时现场               | `ai/danMCai/workspace/`                            |

## 本机文件已经放到哪里

本次已实际迁移本机生成目录，不只调整源码入口：

- `ai/danMCai/runs/gpu-main/`：当前 GPU 训练的配置、采样记录、分片、学习器、联赛与评测记录。
- `ai/danMCai/checkpoints/`：原有 CPU/GPU 归档及迁移前第 242,498 步的完整检查点备份。
- `ai/danMCai/data/generated/`：历史采集与训练数据；`ai/danMCai/environment/`：本机 Python 环境。
- `ai/danMCai/workspace/worktrees/`：已有开发工作树；`workspace/logs/legacy/`：历史日志；`workspace/maintenance/structure-migration/`：本次迁移的本机校验和草稿备份。
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

## danMCai 名称与规范路径

本路线统一使用 **danMCai**，源码、Python 模块、命令和文档入口均位于 `ai/danMCai/`；网页清单字段为 `selection.danMCaiChampions`。冠军 ID、模型二进制、版本号、网络结构和真实门控记录不因命名调整而改变。通用的浏览器存储和回环地址概念不改名，历史机器证据、冻结源码与配置保持原始字节。

本机仍在运行的训练不重排物理数据。规范目录内的 `runs/`、`checkpoints/`、`environment/`、`workspace/` 和 `data/generated/` 通过 Windows 目录连接指向此前数据；此前数据承载目录隐藏并忽略提交。已有工作树路径与活跃进程继续有效，规范路径和旧进程读取同一份数据，不复制模型、缓冲区或 Python 环境。此兼容层不是第二条模型路线；不要在运行或旧工作树仍有引用时删除它。

另一台电脑拉取前先保护未提交修改。干净克隆直接使用规范目录；有旧训练时保留其冻结检出和数据，在规范位置建立对应目录连接。例如 `New-Item -ItemType Junction -Path ai/danMCai/runs -Value <原运行根目录>`，仅在目标不存在且来源经过核对时执行；其余生成目录同理。已有规范目录含数据时先核对，不能覆盖。停止旧运行、校验数据并修复全部调用后，才考虑迁移物理存储。

只读面板改用 `npm run train:dashboard -- --run=ai/danMCai/runs/gpu-main`。既有冻结训练继续使用其原始启动路径和截止时间，不能用新源码直接接管旧运行，亦不能为命名更新更改学习协议。
