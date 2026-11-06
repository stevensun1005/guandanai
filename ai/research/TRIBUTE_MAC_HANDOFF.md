# 进还贡专项：从 Windows 移交到 Mac

这份交接用于已结束的进还贡专项，和 [Mac 主模型的原 24 小时窗口](MAC_HANDOFF.md)分开。Windows 原件保留；准备迁移包不表示已经在 Mac 验证或启动专项训练，也不延长现有 Mac 主训练的截止。

## 只需手工复制两个文件

Windows 目录：`D:\vibecoding\guandan-transfer\`。

- `danMCai-tribute-windows-20261106.zip`
- `danMCai-tribute-windows-20261106.zip.sha256`

迁移包实测为 43,191,318 字节，约 41.2 MiB；51,734 个负载文件的 SHA 与 ZIP CRC 已通过。

把它们一起复制到 Mac 的 `Downloads`。这是本次专项的新迁移包；旧的 `danMCai-windows-gpu-main-20261105.zip` 是主出牌模型的历史迁移包，已完成主模型迁移的 Mac 不必为了专项再次导入它。

当前代码和公开研究记录从本仓库 `main` 安全同步；训练数据不在 Git 里，单独拉代码不能替代上述 ZIP。不要复制 Windows 的 Python 环境、`node_modules` 或目录连接；不要覆盖 Mac 上正在运行的模型、数据或依赖。

## 包内保留什么

| 位置                                             | 内容与用途                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `runs/tribute-champion-20261106/`                | 继任批次全部现存训练／开发数据、协议、游标、日志、最终评测和检查点                                                       |
| 其中 `learner/latest.pt`                         | 累计 59,300 步的完整网络和 Adam 状态，用于后续明确登记的继承                                                             |
| 其中 `learner/best.pt`、`best.onnx`、`best.json` | 55,580 步候选，保留其负结果；不是已批准的网页模型                                                                        |
| `runs/tribute-20261106/`                         | 前批次的全部现存数据、模型和停止证据；旧 `progress.json` 是面板镜像，原停止字节在 `progress-at-champion-transition.json` |
| `models/<SHA>.onnx`                              | 本次原冻结的 danMCai／GuanZero 底座，用于复现，不强制作为未来批次教师                                                    |
| `frozen-source/`                                 | 继任协议列出的 73 个源码文件，供指纹核对；完整运行源码从 Git 的对应提交恢复                                              |
| `MANIFEST.json`、`RESTORE_MAC.md`                | 逐文件大小／SHA-256、来源信息和包内说明                                                                                  |

继任源码固定提交为 `3b0ec91dd570cecd6bf50720133ae7adeaa124ef`。旧协议、原样本和检查点按原字节保存，不把它们改写成 Mac 数据或新教师生成的数据。

## 在 Mac 校验、导入

在 Mac 项目主目录确认 Git 状态并安全同步 `main`；有草稿使用独立检出，不向正在运行的冻结源码里 pull。记录当前项目绝对路径：

```bash
mac_project="$PWD"
tribute_import="$mac_project/ai/danMCai/workspace/tribute-import-20261106"
cd "$HOME/Downloads"
shasum -a 256 -c danMCai-tribute-windows-20261106.zip.sha256 || exit 1
test ! -e "$tribute_import" && test ! -L "$tribute_import" || { echo '目标已存在，请保留它并选择另一个新目录'; exit 1; }
mkdir -p "$tribute_import"
unzip -q danMCai-tribute-windows-20261106.zip -d "$tribute_import"
```

校验失败时不要启动或改写数据。解压后逐项验证负载文件：

```bash
python3.12 - "$tribute_import" <<'PY'
from pathlib import Path
import hashlib, json, sys
root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'MANIFEST.json').read_text(encoding='utf8'))
for item in manifest['files']:
    file = (root / item['path']).resolve()
    assert file.is_relative_to(root), item['path']
    data = file.read_bytes()
    assert len(data) == item['bytes'], item['path']
    assert hashlib.sha256(data).hexdigest() == item['sha256'], item['path']
print('逐文件校验通过：', len(manifest['files']))
PY
```

将导入目录作为只读父快照。后续运行、日志及迁移后的检查点写到新的专项目录，不在导入快照内训练，不覆盖原 Windows 或 Mac 主训练。

## 给 Mac 上的 Codex：下一步仍需完成

当前专项启动器是 Windows 入口：`run.mjs` 调用 `--device=cuda:0`，旧准备器固定 2026-11-06 08:00 Toronto 截止并拒绝到期后启动。Python 的设备解析已有 `mps` 分支，但专项尚未完成 Mac 真机恢复、更新、导出和资源预算验证。**不能照抄旧启动命令，也不能编辑原协议延长时间。**

1. 先读 `AGENTS.md`、本文件、专项 README、主报告第 35 节及当前交接。核对 Mac 的原主训练、进程、固定 schedule、可用内存和磁盘；保护其源码、运行和依赖。不要在活跃任务共享的 Python 环境或 `node_modules` 中重装依赖。
2. 使用原生 Apple silicon、Node 24 和 Python 3.12，按 [Mac 环境说明](MAC_HANDOFF.md#在-mac-准备环境)核对依赖。必要时为专项另建 Python 环境／独立准备目录；不要直接重跑会修改主训练共享依赖的安装脚本。真实执行 `torch.backends.mps.is_available()` 检查，不能把 Windows GPU 或主模型的历史 MPS 验证当作专项已通过。
3. 在新副本上恢复 `latest.pt` 的完整网络与 Adam，核对累计 59,300 步及参数。用临时副本验证 CPU／MPS 推理、临时更新、保存恢复及 ONNX 数值和动作；测试更新不计为正式新增训练，不覆盖父快照。
4. 在新的冻结检出实现并验证专项的 MPS 学习器入口、CPU 对局采样、Mac 可用内存口径和路径映射。CPU 采样与 MPS 梯度训练分别显示，保留至少 4 GiB 使用空间；不以静默 CPU 回退冒充显卡训练。
5. 正式训练前与所有者确定新的时长／固定截止，并说明短测所得预计耗时和 CPU 占用。这不是旧窗口的重启或续约，不在本次交接自动启动第二个 GPU 任务。
6. 新协议登记父检查点／数据 SHA、继承步数、后端、来源和新的种子分配。新续打教师从当时最新 `main` 的真实 danMCai 冠军 manifest／accept／权重 SHA 核验；如果换教师或训练方法，保留旧数据的原来源标签，按新批次设计明确是否以及如何使用。
7. 原留出种子 `4,000,000,000–4,000,000,127` 已用于 512 个单局评测，不能再冒充新独立验收。训练、开发、后续验收继续分开，保留旧游标和所有原始结果。

## 效果与发布边界

本次候选没有通过预先登记的双头门槛，网页专项仍关闭。迁移成功或训练步数增加不代表棋力提升。下一批应先验证标签稳定性与不同出牌底座的适配，再决定训练方案；不能承诺照原方法延长就能改善。

仍以本局最终队伍升级分为目标，保留旧贡还对照和独立测试。通过相应验收及浏览器／房间验证前，不融合网页，不改主模型默认冠军，不覆盖 baseline，不干预 GuanZero 或主模型的活跃冻结训练。新方法、正负结果和协议变化按 `AGENTS.md` 记录并推送 `main`；权重和数据只放忽略目录或合规的不可变权重附件，不提交此 ZIP。

Windows 侧迁移包的实际大小、SHA 和逐文件验证结果见[准备证据](evaluation/tribute-mac-transfer-20261106.json)。该证据只说明 Windows 侧打包／校验，Mac 专项验证仍待执行。
