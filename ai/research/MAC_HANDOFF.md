# MacBook 接手：本次一个 24 小时续训窗口

**进还贡专项另见 [TRIBUTE_MAC_HANDOFF.md](TRIBUTE_MAC_HANDOFF.md)。** 本文的主模型历史 ZIP 和原 24 小时窗口不用于重启专项，也不因专项移交延长。

这份交接只授权 **Mac 首次正式启动后的一个 24 小时窗口**，用于所有者在 Windows 上正常使用电脑期间继续 danMCai 训练。环境准备和兼容性预检不计时；首次通过预检后保存固定截止时刻。中断后只跑剩余时间，到期不自动续约、不每日重启、不同时重启 Windows 训练。请在本次 2026-11-05 晚间接手；若隔日才看到交接，先核对所有者最新时间要求。

## 当前 Mac 执行入口（2026-11-05）

迁移包已从 Downloads 完整校验并恢复 516 个文件。原生 M1 Pro、32 GiB、macOS 27.2、Node 24.15.0、Python 3.12.2、PyTorch 2.15.0 已实际完成 MPS 检查点／Adam 恢复、临时更新和 ONNX 预检。正式运行从 682,654 步继承，**首次窗口为 `2026-11-05T21:58:13.414Z` 至 `2026-11-06T21:58:13.414Z`**，即 Toronto 11 月 5 日 16:58:13 至 11 月 6 日 16:58:13；恢复后逐字节核对 schedule 未变。

首个冻结检出 `mac-training-20261105`（`af640a8`）因 macOS 原始空闲页口径暂停采样，正常保存至 682,742 步后原样保留。内存兼容修正使用 `mac-training-20261105-r2`（`aac0bbd`），已保留。所有者后续授权实测采样提速，吞吐调优曾使用冻结检出 `mac-training-20261105-r3`（`1ab42a7`）；所有者随后授权门控候选调度变更，当前执行源码在 **`ai/danMCai/workspace/mac-training-20261105-r4`（`4ac91db`）**，通过具名协议在同一物理运行调整采样并发；原检查点、Adam、累计量和种子游标继承。主项目 `ai/danMCai/runs/mac-20261105` 仍链接到原检出内的物理数据，新冻结检出也链接到同一数据。不要在旧冻结检出重新启动或新建第二个运行。

只在确认当前启动器和调度器均已退出、且原截止尚未到时，才在主项目根目录恢复：

```bash
mac_project="$PWD"
cd "$mac_project/ai/danMCai/workspace/mac-training-20261105-r4"
nohup node ai/danMCai/training/continuous/mac-24h.mjs \
  --snapshot="$mac_project/ai/danMCai/workspace/mac-import" \
  --python="$mac_project/ai/danMCai/environment/mac/bin/python" \
  >> ai/publishing/cache/mac-24h.log 2>&1 &
```

当前已采用 **四名 CPU 快速采样器、每名八场**，学习器仍为 MPS，4／5 GiB 内存暂停／恢复阈值不变；这是所有者后续授权的吞吐调优，首次两采样器预设的历史记录保留。短时观测采样约 1,016 → 1,967 决策/秒、正式更新约 2.17 → 3.27 次/秒，可用内存最低约 12.8 GiB、无新增换页；不是隔离性能基准或棋力提升证据。完整数据、边界错误与保存点见[吞吐证据](evaluation/mac-throughput-20261105.json)，当前研究记录见主报告第 30 节。

当前门控采用 `gateSchedule.mode=new-first-v1`：切换正常保存点为 743,487，立即快照一次；之后仍每小时快照，只选切换点及之后的最新一份，已被更新快照替代的候选不补赛。普通历史快照继续留在原训练对手池，不再逐个挑战。最近两位真实前冠军可低频挑战现任冠军（切换时为 v000293055／v000091092），全局间隔至少三小时，同一候选／冠军的完整门控不重复；没有新候选且历史检查未到期时门控空闲。原每三小时 150 对 P0 锚点与连续两次明确退步停机规则保持原样；到期锚点优先于下一项门控，已开始的门控不因新快照到达而中断。原 SPRT、牌规与种子用途区间不变，实际观察见[调度证据](evaluation/mac-gate-scheduling-20261105.json)。

此命令读取既有 schedule，不重新计时；没有每日重启任务。实时只读面板为 <http://127.0.0.1:8766/>。已完成的预检与首次兼容性停机见[本次证据](evaluation/mac-continuation-20261105.json)和主报告第 28 节。完整窗口尚未完成，没有新增独立棋力验收；后续实际冠军晋升按 [WEB_MODELS](../../web/docs/WEB_MODELS.md) 单独发布，普通最新导出不自动替换冠军。下文的首次建立工作树命令保留为准备流程，当前 Mac 不要重复执行。

本机已补建每四小时 danMCai 真实冠军发布检查（应用定期任务 `danmcai`，在本聊天继续）。训练晋升只更新本地冠军，不会直接发布；该任务负责核对证据、归档 Release、测试、推送与确认网页。电脑及应用需保持运行；Git 文档不会自动在其他电脑安装任务。该任务不启动或修改训练，原固定截止仍沿用。2026-11-06 的漏发与补发记录见[归档 017](evaluation/web-model-017.json)。

## 给 Mac 上的 Codex

先读 `AGENTS.md`、本文件、`CONTINUOUS_TRAINING.md`、`CODEX_HANDOFF.md` 和 `STRUCTURE_MIGRATION.md`。这次先完成迁移、MPS 实测与续训，不在 24 小时窗口内插入 LSTM、改奖励、改对手池或重新从零训练等新实验。保护已有草稿，直接提交推送 main；训练用独立冻结检出，报告与网页发布使用另外的工作树。

1. 检查芯片、统一内存、macOS、剩余磁盘和当前 Git 状态；主机必须是原生 Apple silicon，不能在 Rosetta 下启动。此预设要求至少 16 GiB 内存、macOS 14+，准备导入前建议保留 15 GiB 磁盘。8 GiB、Intel 或 MPS 不可用时停止，报告具体阻塞，不偷偷改用 CPU 或改小缓冲区冒充同一协议。
2. 安装下述环境，找到用户复制来的 ZIP 和 `.sha256`，完整校验后解压；缺包时说明 Git 里没有它，不能声称已恢复 Windows 训练。
3. 在独立 detached worktree 冻结已测试源码。用 `mac-24h.mjs` 启动；它先在临时目录恢复真实检查点与 Adam，做 20 次会丢弃的测试更新及 ONNX 数值检查，成功后才开始计时和正式训练。
4. 观察首批状态，确认学习器为 `mps`、采样器为 `cpu`，不是把 CPU 采样显示成苹果显卡推理。记录设备、软件版本、吞吐、内存和实际错误；Windows 的速度不是 Mac 性能证据。持续窗口中保持资源预留，不在冻结检出里 pull 或改源码。
5. 只运行到 `schedule.json` 的原截止时间，最多一个 24 小时窗口。崩溃恢复仍使用同一运行和同一启动器；不要直接调用 supervisor 重新给满 24 小时。停止后检查进程退出、最后检查点与 SHA，再把真实新增训练量、门控／锚点正负结果写入主报告及机器证据并推送 main。窗口中的所有采样和门控都是开发数据，不是独立 80% 验收。

## Windows 已保留的成果

Windows 训练在 `2026-11-05T20:41:22.061Z` 因 `time-limit` 正常停止，即 Toronto 11 月 5 日 15:41。最新导出 `v000682654`，现任门控冠军仍是 `v000293055`。最后学习器累计 682,654 步、349,519,139 行已摄入样本、1,398,075,392 行训练使用；这些是生命周期累计量，不是 Mac 新增量。采样记录为 731,269 场、349,882,485 个决策，属于探索训练，不能当作棋力胜场。

Windows 的 `gpu-main`、旧 CPU 运行、其他历史实验、GuanZero 和冻结检出都留在原位，不删除、不覆盖，也不在本次迁移中重新启动。移交 ZIP 包含当前 GPU 运行的全部现存文件、Adam 检查点、模型／冠军／联盟、122 个回放分片和 32 个原冻结源码文件。**现存回放为 2,012,555 行**；之前被滚动缓冲区淘汰的历史样本不在磁盘里，不能声称全部 3 亿多行原始数据仍可恢复。

迁移包不包含 Windows Python 环境、`node_modules`、目录连接、云端密钥或真人牌谱。它是私下复制的训练附件，不提交 Git，也不把缓冲区上传到公开 Release。

| 要复制到 Mac 的文件                     | 校验／大小                                                         |
| --------------------------------------- | ------------------------------------------------------------------ |
| `danMCai-windows-gpu-main-20261105.zip` | 320,471,038 字节，约 306 MiB                                       |
| 同名 `.zip.sha256`                      | 与 ZIP 一起复制                                                    |
| ZIP SHA-256                             | `edebd10bad4f36f61f96e5386abda6dfe782d1cd9132765e5c371dcbce62fe2a` |

这两个文件已放在 Windows 的 `D:\vibecoding\guandan-transfer\`。用移动硬盘、U 盘或局域网复制到 Mac 的下载目录。克隆 Git 仓库只会取得代码和已提交附件，**不会取得这个迁移包**。完整校验与 Windows 恢复测试见[机器证据](evaluation/mac-handoff-20261105.json)。

## 在 Mac 准备环境

全新目录可以这样取得源码；已有项目先保护草稿并安全同步 main，不能用 clone 覆盖：

```bash
mkdir -p "$HOME/vibecoding"
git clone https://github.com/stevensun1005/guandanai.git "$HOME/vibecoding/guandan"
cd "$HOME/vibecoding/guandan"
```

需要 Git、原生 Node.js 24 LTS、原生 Python 3.12 和 Xcode Command Line Tools。已有 Homebrew 时可安装 `brew install node@24 python@3.12`，并将对应 `bin` 放入 PATH；没有 Homebrew 可用 Node 和 Python 官方安装器，无需为了此任务强制安装包管理器。缺少命令行工具时本人运行 `xcode-select --install` 完成系统安装。

```bash
bash ai/environment/setup-mac.sh
ai/danMCai/environment/mac/bin/python ai/danMCai/training/continuous/transfer.py unpack \
  --archive="$HOME/Downloads/danMCai-windows-gpu-main-20261105.zip" \
  --destination=ai/danMCai/workspace/mac-import
```

脚本使用仓库固定的 `torch==2.15.0`、`numpy==2.3.5`、`onnx==1.23.2`、`onnxruntime==1.31.1`，单独创建 Mac 环境；相应 Python 3.12 Apple silicon wheel 的存在已核对，安装与 Metal 执行仍须在真实 Mac 上确认。实际 `pip freeze` 写入忽略的环境目录，不提交二进制环境。MPS 检测失败会停止，不默默转 CPU。官方说明：[Apple Metal/PyTorch](https://developer.apple.com/metal/pytorch/)、[PyTorch MPS](https://docs.pytorch.org/docs/stable/notes/mps.html)。

解压时校验整个 ZIP，再逐项核对 516 个文件及时间戳，拒绝覆盖已有目标和不安全路径。解压后的 `mac-import` 当作只读快照；不要把预检结果或新文件写进去。重新解压应选新的目录名，不删除 Windows 原件。

## 冻结源码并启动

以下命令在主项目根目录执行一次。已有同名工作树、链接或运行时先检查，不覆盖：

```bash
mac_project="$PWD"
mac_frozen="$mac_project/ai/danMCai/workspace/mac-training-20261105"
git worktree add --detach "$mac_frozen" HEAD
ln -s "$mac_project/node_modules" "$mac_frozen/node_modules"
mkdir -p "$mac_project/ai/danMCai/runs"
ln -s "$mac_frozen/ai/danMCai/runs/mac-20261105" "$mac_project/ai/danMCai/runs/mac-20261105"
cd "$mac_frozen"
mkdir -p ai/publishing/cache
nohup node ai/danMCai/training/continuous/mac-24h.mjs \
  --snapshot="$mac_project/ai/danMCai/workspace/mac-import" \
  --python="$mac_project/ai/danMCai/environment/mac/bin/python" \
  > ai/publishing/cache/mac-24h.log 2>&1 &
```

默认运行 `ai/danMCai/runs/mac-20261105`；主项目内同名目录链接到它，方便找数据和启动只读面板。冻结工作树可以使用分离 HEAD，后续研究记录提交到另一个干净工作树的 main。大文件始终留在忽略目录。

预检会核对模型与检查点同为 682,654 步、参数逐项相等、Adam 状态已恢复、初始 CPU／MPS 误差和导出 ONNX 误差满足 `atol=rtol=1e-4`，并完成 20 次临时更新检查有限值。这些临时权重会丢弃，不覆盖正式模型、不算生产训练或强度结果。首启探针约需数秒至数分钟，Mac 实际耗时待测。

正式训练默认两名快速采样器，每名并发八场，ONNX 采样走 CPU；完整网络参数在 **MPS** 更新，学习器 CPU 主机线程为 1。内存预留／恢复阈值为 4／5 GiB，启动器要求至少 8 GiB 可用磁盘。采样、评测和数据读取仍会占 CPU；真实 CPU 百分比与吞吐只在 Mac 上量测。保持接电、屏幕盖打开；启动器的 `caffeinate -i` 防止空闲睡眠，不能保证合盖后仍运行。

macOS 的预算使用 `vm_stat` 中 free + inactive 页估计可用内存，并另存原始 free 页数；不把大量可回收缓存当作内存不足。此口径与 [psutil 的 macOS 可用内存说明](https://psutil.io/api/#psutil.virtual_memory)一致，不等于内存压力或严格预留保证。读取失败时保守回到原始空闲量并记录错误，4／5 GiB 阈值不变。首次真机启动曾因只读原始 free 页而暂停两名采样器，负结果和修正记入本次 Mac 运行证据。

若必须修复已证实的兼容性问题，先正常停止并保存检查点，保留原冻结检出及同一运行的 `schedule.json`；修复验证后另建冻结检出，将其中的运行入口链接到原运行，再用同一 `mac-24h.mjs` 加 `--protocol-change=<实际原因>` 续跑。该参数转交具名协议变更入口，记录前后源码指纹，不手工改配置绕过核对；仍先做真实 MPS 预检，只使用原窗口剩余时间。一般中断恢复不加此参数。

所有者后续授权在保留日常使用内存的前提下实测提速。已有 Mac 运行可在正常保存后用 `--protocol-change=<实际原因> --set='{"actors":4}'` 转交原调度器的采样配置验证入口，冻结检出须匹配对应实现；不能只改 `config.json`。首次迁移仍最多两名采样器，调优不改奖励、学习率、重放比、网络或固定截止。新增采样槽必须先核对其独立种子区间和导入分片最大序号，从保留序号之后写入；每阶段实测吞吐、内存、换页和错误，保留正负结果后决定采用的并发。

在主项目另一个终端查看：

```bash
npm run train:status -- --run=ai/danMCai/runs/mac-20261105
npm run train:dashboard -- --run=ai/danMCai/runs/mac-20261105 --port=8766
```

浏览器打开 `http://127.0.0.1:8766/`。重点核对 `learner/status.json` 的 `device=mps`、步数持续增长、实际采样数和资源告警。`schedule.json` 保存 UTC 开始／截止时间，面板的生命周期步数要减去 682,654 才是 Mac 新增步数；累计已摄入／训练行数也须减去继承值。训练数据是探索自对弈，门控结果与独立验收仍分开。

完整回放的 Windows 恢复检查已装满 2,000,000 行缓冲；按检查点分片清单补计 28,220 行收尾数据，累计摄入为 349,547,359。采样器生成计数与学习器摄入计数不同，不能拿二者差额直接宣称丢数或已经训练；历史差额和未归因部分保留在主报告第 26 节。Mac 新运行会按原滚动策略清理工作目录中的超龄分片，只读导入快照和 Windows 原件保持全部现存文件。

## 续训协议与恢复边界

- 新目录继承最新网络、Adam、累计训练计数、真实冠军及联盟；不会把最新模型自动当冠军。原始 P0 锚点保留，不覆盖 `baseline/policy.onnx`，网页默认和菜单保持不变。
- 回放从当前保存的分片按原时间戳重建，容量仍为 2,000,000。内存环的物理排列、随机数状态、后端舍入和新采样轨迹不保证逐位复现；这是记录了谱系的跨后端续训，不是原 Windows 协议无变化恢复。
- 新采样起点为每槽的偏移 3,000,000，门控／锚点从块 300 起，分别仍位于训练／门控／锚点的用途区间。移交前检查了来源当前偏移和块序号无冲突；新开对照不得复用这个预留。旧回放分片的序列号保留，新采样从已有最大序号之后写，避免覆盖旧数据。
- 奖励仍是原单把升级分目标，采样规则对手仍是**历史 original 基线**；迁移不把 Clint 策略混进神经网络训练，也不声称本次已经完成整场目标或 LSTM 改造。
- 意外中断后，在冻结工作树重复同一启动命令；它读取已保存截止时间，仅运行剩余时长，并拒绝重复启动同一活跃运行。不要新建另一个运行绕过时限。到期时启动器写入 `STOP`（`reason=authorized-time-limit`），学习器在下一轮检查时落盘退出，调度器也有剩余时限兜底；正常退出与采样收尾可能多约一分钟。调度器若记录 `operator-stop`，须同时保留这个限时 STOP 原因，不能改写原始记录。内存、锚点退步或错误也可能提前停止，必须记录实际完成量，不能自动补开训练凑满 24 小时。
- 调度器收尾写入退出码时保留 STOP 已有的 `reason` 与 `deadlineUTC`，以便核对单次窗口的实际停止原因；回归测试覆盖限时标记在收尾后仍存在。
- 主项目拉取新代码不会修改冻结检出。若冻结源码被改动，现有源码指纹检查会拒绝或停止，不改 `config.json` 绕过校验。

## 窗口结束后

核对最后导出、检查点、冠军和完整门控／锚点记录，再运行 Node、格式、相关 Python 测试及构建，在干净工作树同步研究报告和成果索引到 main。记录新增量和跨后端协议变化，正负结果都保留；没有独立整场测试，不宣称 80% 已验证。

保留 Mac 全部运行目录与只读导入快照。需要带回 Windows 时另行打包为 Mac 窗口归档并加 SHA-256，放新目录，不覆盖 Windows `gpu-main`，不把 Mac 的 MPS 配置拿到 Windows 原目录启动。网页模型只在实际门控晋升后按冠军发布流程同步；新导出不自动替换冠军。其他机器定时任务不会通过 Git 自动迁移到 Mac。

## 门控候选调度的具名变更

所有者已授权本次由逐个补赛改为新快照优先。正常保存后，在新的冻结检出使用 `--protocol-change=<实际原因> --set='{"gateSchedule":{"mode":"new-first-v1","minNewStep":743487,"activatedAt":"2026-11-06T02:40:43.451697+00:00","historicalChampions":2,"historyIntervalHours":3}}'`；此处为已经采用的参数，不是再次切换的命令。普通恢复沿用当前配置，不重设激活时间或最低步数，不增加第二个窗口。运行中的源码不原地改写，普通历史模型与完整历史成绩不删除。
