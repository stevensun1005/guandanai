# Mac 结束后返回 Windows：恢复包与独立整局评测

## 2026-11-07：已授权 A→B 各四小时，网页冠军保留

所有者现已批准执行此前准备的两臂。A 已在 Toronto **11 月 7 日 00:49:32** 实际启动，固定截止 **04:49:32**（UTC `05:49:32.553Z` 至 `09:49:32.553Z`）；B 等 A 完整退出后才由控制器创建一次四小时窗口，预计约 08:50 结束训练。B 的准确截止以自己的 `schedule.json` 为准，不能把估计时间写成已启动。中断不补时，原 Mac 截止和所有旧运行不变。

实时面板：<http://127.0.0.1:8766/>，每三秒读取真实状态，分列两臂、剩余时间、本轮新增更新／采样、设备、全机 CPU、可用内存及独立评测进度；掉线明确标识旧数据。只读 API `/api/status`，仅监听本机。4／5 GiB 暂停／恢复预算沿用冻结采样器，不是对整个操作系统的硬内存分区；不能保证其他程序瞬间占满内存时仍有固定余量。训练采样四槽各八局、ROCm 学习器单线程，后续原生 CPU 评测最多四个单线程进程，实际负载以面板为准。

- 原运行规范入口不变：`ai/danMCai/runs/windows-ab-20261106-A/`、`windows-ab-20261106-B/`；训练和评测继续用 `workspace/worktrees/windows-return-20261106/` 的冻结源码，不能同步 main 到它。
- 外部控制检出：`ai/danMCai/workspace/worktrees/windows-ab-control-20261107/`；控制器、两组验证及输出在该检出的忽略目录，并通过主项目 `ai/danMCai/workspace/windows-ab-20261107/` 连接访问。`settings.json`、`progress.json`、`training-A.log`／`training-B.log` 与 `evaluation/` 是实际现场。
- 已启动 `run-windows-ab.mjs --settings=<上述 settings.json> --start`，会按顺序执行 A、B 和评测。**不要再启动第二个控制器或训练器。** 只查看可直接打开面板。控制器已失效时先审计 PID、锁、STOP 和固定截止；禁止把四小时重新计时。没有安装系统自动重启任务。
- 两臂结束后只选各自**最终完整学习器导出**，不选开发门控峰值、内部冠军或跨臂最大步数；核对 SHA 后另复制到 `evaluation/models/`，冻结协议及十二小时运行上限，再运行预登记 24,000 局。同一评测截止不按结果延长；未完成不能称为完整验收。
- 最终结果须经汇总校验，再更新主报告、机器证据、成果索引及指南，经相关测试后推送 main。跟进任务 `windows-a-b` 每三十分钟检查，完成后删除；它不自动补时或更新网页权重。

当前网页 danMCai 冠军固定保留 **017／v000855042**。本实验内部 gate 与其候选不能触发网页同步或晋升。完整新授权与启动快照见 [本批证据](evaluation/windows-ab-20261107/)，原准备记录仍按原口径保留，下面“未启动”均指 11 月 6 日准备阶段。

## Windows 实测与双臂准备（2026-11-06）

**正式训练未启动，没有新计时窗口。** Windows 已重新核验外层 ZIP 的 421,964,889 字节、完整 SHA 与 785 个负载文件，以及内层完整 SHA 与 610 个负载文件。两臂恢复相同的 v001013906／匹配 Adam：12 组状态、123 分片／2,033,479 行、49,470 行未摄入尾部均保留，累计量不改写。原内存环、RNG 和已淘汰样本仍不保证逐位恢复。

原 GPU Python 环境未重装。RX 7800 XT／PyTorch 2.9.1／ROCm 7.2 在 `cuda:0` 上完成 129 行前向和 Adam 恢复，CPU／GPU 最大绝对差约 2.86e-6，参数更新零。采样探针实际使用 DirectML，16 个固定局面／49 个候选未发生会话级 CPU 回退，最大误差约 1.88e-6。它只证明兼容性，不证明合批吞吐、GPU 更快或棋力提升。

冻结检出为 `ai/danMCai/workspace/worktrees/windows-return-20261106/`；规范入口 `ai/danMCai/runs/windows-ab-20261106-A/` 和 `windows-ab-20261106-B/` 是指向该检出内独立运行的目录连接。旧 `gpu-main`、其他历史运行、只读 `workspace/mac-return-import-20261106/` 与外层 `workspace/windows-return-bundle-20261106/` 保留，不覆盖、不重启。目录连接、Python 环境不能跨电脑复制。

| 设置                                     | A 基线                 | B 假设                   |
| ---------------------------------------- | ---------------------- | ------------------------ |
| self / league / historical original-rule | 0.5 / 0.3 / 0.2        | 0.3 / 0.5 / 0.2          |
| 每槽 actor 偏移，左闭右开                | [8,000,000, 8,100,000) | [12,000,000, 12,100,000) |
| gate / anchor 索引，左闭右开             | [700, 750)             | [800, 850)               |

四槽训练根种子为 `1e9 + slot*50,000,000 + actor偏移`，门控为 `3.5e9 + index*100,000`，锚点为 `3.6e9 + index*100,000`，两臂区间互斥，到界后不再分配。未复制默认 6,000,000／600。除种子、路径和准备时间等运行标识外，唯一试验处理是 `actorMix`；网络、权重、Adam、回放、探索、学习率、奖励、重放比、联盟成员及更新规则一致。两臂同为四名采样器各八场，4／5 GiB 内存暂停／恢复预算，Clint 不加入训练。

审计读取 1,110,329 个独特训练根种子，连同公开评测为 1,149,583 个已知根种子。新预留无已知交集；7,000 副后续独立牌排除这些根种子的 200 个潜在派生回合，并排除两臂预留根种子可能生成的对应牌副。缺失的 P0 早期历史、不可读取的其他机器日志不在保证内。上一轮 20,000 局是已使用证据。

**生命周期修复：**在途任务的旧模型路径曾被清理，Worker 缓存淘汰后重载发生 ENOENT。新检出保留运行内不可变 ONNX；联盟仍按原规则退出选择池及移除统计，但不删文件。两臂采用相同修复，不改历史冻结源码。回归覆盖旧联盟退出、真实 Worker 缓存淘汰后重载，以及发布超过 `keepVersions` 后保留旧导出。没有在线垃圾回收；600 秒导出间隔下，六小时新增学习器权重约 185 MiB，另有联盟副本，原 20 GB 磁盘限制仍生效。本次不清理模型，未来离线清理须先确认所有消费者停止。

建议先每臂相同 4–6 小时、顺序运行以避免争用显卡；时长和先后顺序尚未确定。在冻结检出中，下列入口**仅检查**：

```powershell
node ai/danMCai/training/continuous/windows-window.mjs --run=ai/danMCai/runs/windows-ab-20261106-A
node ai/danMCai/training/continuous/windows-window.mjs --run=ai/danMCai/runs/windows-ab-20261106-B
```

未来明确授权后才追加 `--start --hours=<批准小时数> --authorization=<授权记录> --python=<已验证GPU Python> --verification=<对应GPU报告>`。首次启动固定截止，恢复仅跑剩余时长、拒绝改时长或过期重开；原 Mac 截止永不延长。不安装自动重启。准备工具的 `--finalize` 只允许在无 schedule／学习器活动／采样结果、检查点和已登记配置未变时封存测试后的源码，不能绕过已启动运行的冻结核对。

后续计划 A 对 B 2,000 对；五种对手／队友设置各 1,000 对且两臂共用牌副，共计划 24,000 局，**实际完成零局**。主指标为平均升级分的 95% 牌副簇区间；五项次要 A−B 对照用 Bonferroni 99% 簇区间。保持 108 张实体牌、级牌和先手相同后交换阵营，混合队友按座位均衡，分别报告胜负、升级分、名次，不合成总体胜率。最终 A／B 权重、SHA 和评测截止须在读结果前冻结；未填完整时评测器拒绝执行。进还贡及跨局整场仍属其他实验。

实际记录与预登记见 [Windows 准备证据](evaluation/windows-return-20261106/)，研究结论见主报告第 42 节。网页保持真实冠军 017；恢复、兼容性与实验准备都不是新的棋力提升证据。

本次 Mac 唯一 24 小时窗口已经结束，原截止不变。随后所有者授权最多五小时完成独立评测和 Windows 打包；完成固定样本后提前结束。**本交接只准备恢复，不在 Mac 重启训练，也不启动 Windows 原来的 `gpu-main`。**

独立评测的冻结协议、模型／源码 SHA、种子核对和实际结果统一见 [本轮目录](evaluation/independent-mac-final-20261106/)。主报告保留训练收尾和评测结论；旧窗口、探索训练和开发门控不改写成此次独立成绩。

## 包含什么

- `training-state/danMCai-mac-20261105-final.zip` 和 `.sha256`：最终 v001013906、匹配 Adam、123 份现存回放、四份未摄入尾部样本、冠军／联盟／历史日志和原冻结源码。完整恢复包 610 个负载文件，之前已经逐项解压验证。
- `project/`：本次恢复需要的源代码、初始 P0、模型编码、规则、恢复工具、测试与说明；`package-lock.json` 固定 Node 依赖。它是明确列入清单的源码快照，不含 `.git`。
- `evaluation/`：本轮预登记协议、逐对原始结果和总结。评测样本只作验收，不并入训练回放。
- `manifest.json`：包内逐文件长度和 SHA；外层 ZIP 另有完整 `.sha256`，可用包内 `transfer.py verify --snapshot=<外层解压目录>` 逐项验证。

最终学习器和网页冠军是两个不同对象：

| 对象                     | 版本                 | SHA-256                                                            |
| ------------------------ | -------------------- | ------------------------------------------------------------------ |
| 可恢复学习器             | v001013906           | `a44ff84c17ec1c31beaec3c7280121d5d87bd875b06d9eb8cd0bb9c46378903e` |
| 匹配模型和 Adam 的检查点 | 1,013,906 次累计更新 | `8c7041a3cf3b8446b9b050585a5d2467c17db8e179410c84fd62a89cf21675d6` |
| 网页真实冠军             | v000855042           | `462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7` |

没有 v000855042 对应的 Adam 快照，不能将最终学习器的 Adam 与冠军网络拼接后声称是原样续训。若下一轮从冠军另开分支，需要明确新建 Adam、记录权重继承和优化器计数区别，并使用新协议。

现存回放共 2,033,479 行，其中 49,470 行未进入最终检查点摄入计数；重新载入后会按原规则处理，不能冒称这部分已训练。缓冲容量仍为 2,000,000 行，原内存环位置、随机数状态和已淘汰历史不保证逐位恢复。历史 `countedShards` 的缺失名称按已校验父快照识别，不能删改累计量来掩盖。

包不包含 Windows Python 环境、`node_modules`、云端凭据或真人牌谱。它是私下迁移附件，不上传公开 Release。

## Windows 收到后

先在新目录解压外层 ZIP，保留 Mac 及 Windows 旧运行不动。在 PowerShell 核对外层 ZIP 的 SHA 与配套 `.sha256` 一致：

```powershell
Get-FileHash .\danMCai-Windows-return-20261106-ready.zip -Algorithm SHA256
```

进入包中的 `project`，或先安全同步原 Windows 项目的 main，再将包和只读快照放到新目录。下面 `$Project` 必须指向实际使用的项目，不能直接照搬其他电脑路径。没有 `.git` 的包内 `project` 可用于恢复检查；要继续开发和推送，应在 Windows 正常 Git 检出中操作。

**沿用原 Windows 已验证的 GPU Python 环境。** 原机 RX 7800 XT 使用 ROCm、设备接口为 `cuda:0`，采样推理可使用 DirectML；不要用 CPU 版 requirements 覆盖其 PyTorch。若环境已不存在，先按目标 Windows 硬件重新验证安装，不能把 Mac MPS 环境复制过去。

```powershell
$Project = (Get-Location).Path
$GpuPython = 'D:\your-existing-gpu-runtime\Scripts\python.exe'
& $GpuPython -c "import torch; print(torch.__version__, torch.version.hip); assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
npm ci

# $Bundle 指向解压后的外层包，$Project 指向项目。
$Bundle = Split-Path $Project # 仅当使用包内 project；若用原 Git 项目，改为实际外层包目录。
& $GpuPython ai/danMCai/training/continuous/transfer.py verify --snapshot $Bundle
$Snapshot = Join-Path $Project 'ai\danMCai\workspace\mac-return-import-20261106'
$Run = Join-Path $Project 'ai\danMCai\runs\windows-return-20261106'
& $GpuPython ai/danMCai/training/continuous/transfer.py unpack `
  --archive "$Bundle\training-state\danMCai-mac-20261105-final.zip" `
  --destination $Snapshot
& $GpuPython ai/danMCai/training/continuous/prepare-windows-return.py `
  --snapshot $Snapshot --project $Project --run $Run --actors 4 --provider dml
& $GpuPython ai/danMCai/training/continuous/verify-windows-return.py `
  --snapshot $Snapshot --project $Project --run $Run --device cuda:0 `
  --output "$Project\ai\danMCai\workspace\windows-return-verification.json"
```

每条命令完成后检查退出码为 0，失败就停在该步骤，不继续启动。`unpack` 会验证整包及所有文件 SHA，并拒绝覆盖已有目标；`prepare` 只复制到新运行目录；`verify` 检查网络／Adam／回放，并执行所选后端的只读前向和 Adam 恢复，优化器更新为零。Mac 上完成的 CPU 恢复检查不代表 Windows ROCm／CUDA 或 DirectML 已通过；Windows 仍须实际运行上述检查。DirectML 的真实采样吞吐另在新实验启动后按实测记录，不假定优于 CPU。

没有现成解压工具时，也可从本项目取出 `transfer.py`，使用标准 Python 执行 `transfer.py unpack --archive=<外层ZIP> --destination=<全新目录>`；这同样会核对配套 `.sha256` 和外层全部文件，恢复时间戳。解压外层不需要 PyTorch。

准备工具保留最终学习器、Adam、升级分目标、学习率和重放比例，改用 `cuda:0`，预设四名采样器／每名八场并保留 4／5 GiB 内存阈值。CPU／GPU 并发后续按 Windows 实测调优。新 actor 游标区间从 6,000,000 开始，门控／锚点索引从 600 开始；检查旧运行未占用这些块，避免与 Mac 和旧 Windows 轨迹重叠。新配置与旧配置的来源、后端和种子变化有单独谱系，不冒称原协议完全不变。

## 真正开始下一轮之前

核对本轮评测结论、确定要从匹配最终学习器续训还是从冠军开新优化器分支，并确定下一窗口时长和固定 UTC 截止。**本包不创建新训练 schedule，也不安装或启用自动重启任务。** 原 Mac schedule 只留在只读历史快照里，不能拿它启动新 Windows 运行；新实验的重启也只能使用自己固定窗口的剩余时间。

后续由 Windows 上的 Codex 先读 `AGENTS.md`、本交接、[训练指南](CONTINUOUS_TRAINING.md)及本轮实际结果，再按所有者确定的窗口建立冻结检出和启动入口。检查点和数据已经准备好，不需要重跑 Mac 训练，也不要覆盖 Windows 原 `gpu-main`。训练目标仍按整局最终名次和本队升级分；新对手池、奖励、学习率等方法变化必须单独登记和对照，不能由恢复工具暗中修改。
