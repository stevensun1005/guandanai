# 尾盘模型 Windows 续训：交接与执行步骤

所有者 2026-11-11／12 要求把 Mac 上的尾盘明牌引导训练结果（r2，最终学生 `e00061050`）拷到 Windows 继续训练（原话见 [authorization.json](authorization.json)）。本目录是这次续训的预登记：[protocol.json](protocol.json)（16 小时、10 个采样进程、CUDA、从 r2 检查点起步）和 [seed-audit.json](seed-audit.json)（41 个训练种子块共 590 万副，3,000 副留出评测牌）。方法与续训机制见[尾盘 README](../../../danMCai/endgame/README.md#从已有检查点开新运行例如拷到-windows-续训)，r2 结果见主报告第 57 节。

教师与评测对手固定为冠军 017：夜间研究冠军 v000061013 存在，但本次是 r2 的延续，B 对比也需要同样设置；换教师属于另一个实验，须另行预登记。

这是**新运行**，不是延长 r2；只是研究实验，不换网页冠军 017、默认 danMCai-reason 或菜单，结果也不能当教师或冠军。

## 输入

| 项目           | 内容                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 拷贝包         | `endgame-r2-e00061050.zip`（所有者从 Mac 拷来）：`learner/checkpoint.pt`、`models/e00061050.onnx` 等及 `SHA256SUMS.txt`     |
| 检查点 SHA-256 | `d42fb0206d3d9005fc72ae891fe23f2defd0ed1f48b2876c39afd20903d4650d`                                                          |
| r2 学生        | `e00061050`，`382085eebe6dcfa579d57bc6f639fd4e72e30509a5c32c02128df2e84709dcef`                                             |
| 冠军 017       | `web/dist/models/bot-017.onnx`（`npm run build` 生成），`462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7` |

## 步骤

每一步开始和结束都在面板记 START／END（见第 7 步）。任何一步不符合就停下报告，不要改种子、协议或代码去"凑通过"。

1. **同步与检查**：在 Windows 项目里 `git pull` 到最新 `main`，确认本目录存在；`npm ci`（如需要）和 `npm run build`，核对 `bot-017.onnx` 的 SHA。确认本机没有其他训练或评测在跑（只看，不停别人的进程；例如 2026-11-12 的新冠军对 reason 独立评测 v2 截止 17:30Z，也就是美东 12:30，要等它结束再启动），运行目录所在磁盘至少 20 GB 可用，不放在 OneDrive 同步目录里。
2. **解包核对**：把拷贝包解到仓库外（例如 `D:\guandan-runtime\endgame-r2-source\`），逐个核对 `SHA256SUMS.txt`，检查点必须是上面的 SHA。
3. **Python 与 CUDA**：用本机已有的 danMCai 训练 venv（含 torch CUDA）。`python -c "import torch;print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"` 必须为 True。学习器只认 `cuda`，不可用时会报错，不要改成 CPU。
4. **在 Windows 上重跑种子审计**（Mac 读不到 Windows 自己的历史记录）：把 `protocol.json` 的 `seeds.trainingBlocks` 存成 `train.json`，运行

   ```bash
   python ai/research/tools/audit-research-seeds.py --workspace=<仓库路径> --start=2950000000 --count=3000 --out=<临时目录>\seed-audit-windows.json --training-ranges=<临时目录>\train.json
   ```

   必须无冲突，且 `seeds` 与本目录 `seed-audit.json` 完全相同。审计结果作为 `seed-audit-windows.json` 一并提交。有冲突就停，报告冲突，不要自己换种子。

5. **冻结源码**：在仓库外建一个干净的 detached 工作树（例如 `git worktree add --detach D:\guandan-runtime\endgame-continue-src <本目录所在的 main 提交>`），装好依赖（`npm ci` 或指向主检出的 `node_modules` 目录连接）。`run.mjs` 会记录源码 SHA，之后源码变化就拒绝重启，所以训练只从这个工作树启动。
6. **试启动（只作开发检查，不算证据）**：复制一份协议，只改三处：`run.hours` 改为 `0.05`，`actor.count`／`run.actors` 改为 `1`，`actor.slotSeeds` 改为 `[[[3838000000, 3838200000]]]`（r2 已登记的开发用块）。用单独的试启动目录运行，确认：学习器 `learner/status.json` 的 `device` 是 `cuda`、`inherited.step` 为 61050；`models/latest.json` 的 SHA 是 `382085ee…`；采样进程在 `shards\` 写出至少一个分片；放 `STOP` 后全部进程退出。另跑 `node --test ai/danMCai/tests/endgame-*.test.mjs` 和 `python ai/danMCai/tests/endgame_learner_test.py`。
7. **面板**：按 AGENTS"研究面板统一格式"，用 `ai/research/tools/window-dashboard.mjs` 为本运行建配置（卡片：同步核对、种子审计、试启动、训练 16 小时、评测 A、评测 B、写报告推送），没有尾盘学习器的阶段类型就在该工具里补一个（读 `learner/status.json` 的步数、已读行数、损失和 `actors\*.json` 的已用种子）。也可同时开 `node ai/danMCai/endgame/dashboard.mjs --run=<运行目录>`（端口 8768）。时间一律显示多伦多时间并标"美东"。
8. **正式启动**：

   ```bash
   node <冻结工作树>\ai\danMCai\endgame\run.mjs --run=<运行目录> --protocol=<冻结工作树>\ai\research\evaluation\endgame-continue-20261112\protocol.json --init-checkpoint=<解包目录>\learner\checkpoint.pt --python=<venv>\Scripts\python.exe
   ```

   用计划任务或 `Start-Process` 让监督进程脱离当前会话，关掉终端也继续跑；运行期间防止睡眠（例如在运行期间常驻调用 `SetThreadExecutionState`，不要擅自改系统电源设置，需要改就请所有者自己改）。启动后在本目录写 `startup.json`：冻结提交、`config.json` 的 SHA 与固定截止（UTC 和多伦多时间）、首个导出 SHA、GPU 型号、torch／CUDA 版本、Windows 审计结果。
9. **运行中**：只监看，不热改。截止由 `config.json` 固定，重启只用剩余时间，不续约。某个采样进程用完种子会自己退出，这是预期的；学习器按回放比例继续训练到截止。
10. **评测（截止后）**：取停机时 `models/latest.json` 指向的最终导出，不挑中间版本。两次评测用同样的 3,000 副留出牌，`--workers` 设为 CPU 核数减 2：

    ```bash
    node <冻结工作树>\ai\danMCai\endgame\evaluate.mjs --student=<运行目录>\models\<最终导出>.onnx --champion=<运行目录>\models\champion.onnx --seeds=<冻结工作树>\ai\research\evaluation\endgame-continue-20261112\seed-audit.json --out=<运行目录>\eval-A --pairs=3000 --threshold=32 --solver-cards=18 --workers=<N>
    ```

    评测 B 把 `--student` 换成解包目录的 `models\e00061050.onnx`，`--out` 换成 `eval-B`。再按每副牌（两次交换座位的平均）算 A − B 的配对差和 95% 牌副聚类区间（从两边的 `part-*.json` 按种子对齐）。

11. **判读与报告**：只按 `protocol.json` 的规则写"正向证据／零结果／负"：A 是续训后学生对冠军 017；A − B 是续训有没有带来改进。没跑满 3,000 副要写明实际副数。把 `startup.json`、两次评测的 `summary.json`／`run.json`、配对差结果、`seed-audit-windows.json` 放进本目录；主报告新增一节、CHANGELOG 一条。权重不进 Git，只记 SHA。用干净工作树提交，只暂存本次文件，跑 `npm test`、`npm run format:check` 和相关 Python 测试后推送 `main`，不强推。

## 不要做

- 不延长截止、不重开新窗口、不改种子／学习率／评测设计；确需改动先写 `protocol-amendment-N.json` 说明原因，并请所有者确认。
- 不把结果写成胜率或棋力宣称；r2 的 +0.0292 不能移用到新学生。
- 不动网页模型清单、默认、冠军，不动其他运行、奖励定义或 GuanZero；不把真人牌谱接进训练。
