# Mac 结束后返回 Windows：恢复包与独立整局评测

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
