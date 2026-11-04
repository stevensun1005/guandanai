# 持续自对弈训练

本系统让主价值网络在本机无人值守地连续训练：多个采样进程不停地打完整比赛，训练进程边收数据边更新，联赛对手池随训练增长，冠军由自动门控选出。它**不会**修改网页默认模型；把冠军发布到网页仍需留出验收和人工确认（见[模型研究报告](MODEL_STUDY.md)第 5.3 节与 [AGENTS.md](../AGENTS.md)）。

方法、已验证的范围和尚未成立的结论记录在[模型研究报告](MODEL_STUDY.md)第 4.5 节。

## 启动、查看、停止

```bash
npm ci
python -m pip install -r requirements-training.txt
npm run train:continuous
```

默认运行目录是 `work/continuous/main`（已被 Git 忽略）。常用参数：

| 参数                | 作用                                                   |
| ------------------- | ------------------------------------------------------ |
| `--run=<目录>`      | 运行目录；同一目录再次启动即断点续跑                   |
| `--hours=<小时>`    | 运行时长上限，`0` 表示一直运行                         |
| `--config='<JSON>'` | 仅首次启动时覆盖默认配置，之后配置冻结在 `config.json` |
| `--python=<命令>`   | 训练进程使用的 Python，默认 `python`                   |

例如用 8 个采样进程、把整场结果按一半权重计入目标：

```bash
npm run train:continuous -- --run=work/continuous/match-half --config='{"actors":8,"learner":{"targetMatchWeight":0.5}}'
```

查看进度：

```bash
npm run train:status
npm run train:status -- --run=work/continuous/match-half
```

### 实时进度面板

```bash
npm run train:dashboard
```

打开 [本机训练进度](http://127.0.0.1:8766/)，也可把此地址放在 Codex 的右侧浏览器面板。页面每 5 秒读取真实状态，显示当前交接步骤、运行时间、整场采样数、学习决策、全网络更新步数、进程状态、最近保存模型、门控冠军、进行中的对战检查及报告发布状态。

时间进度条仅表示本次运行时限的完成比例，不能解释为棋力、胜率或整个交接的完成比例；完成一次训练也不会自动把后续步骤标为已完成。采样数据与开发门控均不等于独立验收。状态过期、进程退出或连接中断时页面会提醒，最后记录不会被显示成持续训练的证明。

面板是独立的只读本机服务，默认端口 8766，只监听 `127.0.0.1`，不访问任意文件、不提供训练修改接口，不随 GitHub Pages 发布。关闭面板不停止训练；若电脑重启或服务退出，重新运行上述命令即可。可用 `--run=<目录>`、`--port=<端口>` 指定其他运行和端口。

停止：在运行窗口按 Ctrl+C，或在运行目录里新建一个名为 `STOP` 的文件。各进程会结束当前比赛、保存检查点后退出；再次执行同一命令即从断点继续。

需要开机后自动续跑时，可用 Windows「任务计划程序」新建任务：触发器选「登录时」，操作为在仓库目录执行 `npm run train:continuous`。

## 结构

```text
 采样进程 ×N（Node + onnxruntime-node，每进程 1 线程）
   每场开始读取最新模型；按比例选择对手：
     自对弈（四席最新模型）／联赛池（按 PFSP 抽取）／规则机器人
   按探索规则选牌，按整场写出 int8 样本分片
        │ shards/*.x.i8 + *.y.f32 + *.json
        ▼
 训练进程（Python + PyTorch）
   最新若干百万行的重放缓冲区 → 回归 Q(o,a) 到蒙特卡洛回报
   每隔若干分钟导出 ONNX → models/latest.json
        │
        ▼
 调度进程（supervisor）
   崩溃重启、汇总对局结果（PFSP 统计）、定时把最新模型存入联赛池、
   对每个新快照启动门控：与当前冠军配对对局，SPRT 判定是否更替冠军
```

| 文件                                                   | 作用                                     |
| ------------------------------------------------------ | ---------------------------------------- |
| [supervisor.mjs](../scripts/continuous/supervisor.mjs) | 启动、重启、联赛、快照、门控、停止规则   |
| [actor.mjs](../scripts/continuous/actor.mjs)           | 采样进程                                 |
| [learner.py](../scripts/continuous/learner.py)         | 持续训练进程                             |
| [gate.mjs](../scripts/continuous/gate.mjs)             | 冠军门控                                 |
| [value_net.py](../scripts/continuous/value_net.py)     | 网络读写与网页兼容的 ONNX 导出           |
| [lib.mjs](../scripts/continuous/lib.mjs)               | 默认配置、样本格式、PFSP、SPRT、种子区间 |
| [status.mjs](../scripts/continuous/status.mjs)         | 进度摘要                                 |

## 训练目标

### 显卡训练（AMD ROCm / CUDA）

学习器默认使用 CPU。显卡运行需要对应的 PyTorch 环境；AMD ROCm 同样使用 `cuda:0` 设备接口。本机已经验证 RX 7800 XT 可用，GPU 环境位于 `D:\vibecoding\guandan\work\gpu-runtime\Scripts\python.exe`。该环境从本机已有的 Python 3.12 ROCm 安装创建，不要用 CPU 版 `requirements-training.txt` 覆盖其中的 PyTorch。

```bash
npm run train:continuous -- --run=D:/vibecoding/guandan/work/continuous/gpu-main --hours=24 --python=D:/vibecoding/guandan/work/gpu-runtime/Scripts/python.exe --config='{"actors":2,"actorSeedOffset":1000000,"evaluationBlockOffset":100,"learner":{"device":"cuda:0","threads":1}}'
```

此示例应在支持 GPU 的最新源码工作树执行。当前 CPU 基线源码冻结在原工作树，GPU 对照工作树为 `D:\vibecoding\guandan\work\gpu-training`；实际运行使用绝对的 `--run=D:/vibecoding/guandan/work/continuous/gpu-main`，使报告器能同时看到两组记录。运行中的 `config.json` 不得改写；更换后端须开新运行目录。显卡不可用会报错，不以 CPU 冒充 GPU。

`actorSeedOffset` 默认 0，在各采样槽的训练种子块内设置起点；恢复仍优先使用保存的下一种子。`evaluationBlockOffset` 默认 0，只改变首次分配的门控／锚点块序号，后续持久化和耗尽保护不变。这两个偏移不改变训练、门控、锚点及留出的用途边界。

进度面板另列 GPU 运行的设备名称、实际场数、更新次数和张量分配显存。设备短测见研究报告第 7.9 节；约 10.12 倍是不同运行库下训练计算的短测比值，整场采样效率和棋力提升仍需另测。原 CPU 24 小时基线不被这项对照替代。

网络结构与网页的 P0 完全相同（$567\to512\times5\to1$），导出的 ONNX 与 `ai/policy.onnx` 使用同一输入输出，网页 Worker 和 `npm run eval:table -- --policy=<文件>` 都能直接加载。

每条样本保存四个目标分量：本局升级分（本队 +1～+3 或对方 −1～−3）、整场结果（+1／−1／平局 0）、局序号、整场局数。训练目标为

$$
G = (1-w)\cdot\text{本局升级分} + w\cdot 3\cdot\text{整场结果},
$$

$w$ 即 `targetMatchWeight`，默认 0，即延续 P0 原有的单局升级分尺度；改变 $w$ 不需要重新采样。损失为 $(Q_\theta(o,a)-G)^2$，可选对初始模型输出的保持项 `anchorWeight`。

## 默认配置

| 项目                    | 默认值                                                                      |
| ----------------------- | --------------------------------------------------------------------------- |
| 采样进程                | 6                                                                           |
| 对手比例                | 自对弈 0.5、联赛 0.3、规则 0.2                                              |
| 训练席位探索            | softmax(Q/0.02)，见下文                                                     |
| 重放缓冲区              | 2,000,000 行（约 1.1 GB 内存）                                              |
| 开始训练前最少样本      | 100,000 行                                                                  |
| batch／学习率／梯度裁剪 | 2048／1e-5（Adam）／1.0                                                     |
| 重放比上限              | 每行样本平均最多训练 4 次                                                   |
| 导出新版本              | 每 10 分钟                                                                  |
| 联赛快照                | 每 60 分钟，池上限 24 个                                                    |
| 门控                    | SPRT，μ₀=0.5，μ₁=0.53，α=β=0.05，100～1000 对                               |
| 锚点监控                | 每 3 小时最新模型对初始 P0，固定 150 对；连续两次得分区间上限低于 0.5 停止  |
| 停止规则                | 同一进程 10 分钟内崩溃超过 5 次；磁盘超过 20 GB；损失非有限值时训练进程退出 |

## 探索规则

`exploration` 可取 `{"type":"softmax","temperature":T}`、`{"type":"epsilon","epsilon":ε}` 或 `{"type":"greedy"}`。默认 softmax T=0.02 来自一次开发测量：探索方与贪心对手都是 P0，150 对种子、300 场，平局记 0.5。

| 规则           | 平均得分 | 非贪心决策占比 |
| -------------- | -------: | -------------: |
| 贪心（对照）   |    0.500 |             0% |
| ε=0.01 均匀    |    0.422 |           0.8% |
| softmax T=0.02 |    0.517 |          10.3% |
| softmax T=0.05 |    0.357 |          19.1% |

均匀探索偶尔随机打出炸弹或拆牌，代价约 8 个百分点；T=0.02 的 softmax 只在分数接近的出法之间探索，在这个样本量下看不出代价。每组约有 ±6 个百分点的不确定性，只用于选择默认值。复现：

```bash
node scripts/continuous/explore-cost.mjs --pairs=150 --exploration='{"type":"softmax","temperature":0.02}'
```

## 种子与数据用途

研究报告迄今使用的开发与留出种子都小于 1e9。持续训练的采样种子从 1,000,000,000 起，每个采样进程独占 5,000 万个；探索测量从 3,400,000,000 起；门控种子从 3,500,000,000 起，每次门控独占 10 万个。门控和监控对局都属于开发用途，不能当作留出验收。

门控使用区间 [3,500,000,000, 3,600,000,000)，锚点独占 [3,600,000,000, 3,700,000,000)，每次检查占用 100,000 个种子的块，实际只运行配置要求的前缀。块序号在启动检查前持久化，恢复后不重用本运行已经分配的块；区间耗尽即报错，不回绕。不同开发运行可重用开发种子，但它们不构成独立留出证据。

锚点双方均贪心出牌，不启用网页性格、残局搜索或直接出完捷径；每个种子交换阵营各打一场。胜记 1、平记 0.5、负记 0，按两个结果的种子簇均值计算双侧 95% Hoeffding 区间。只有完整 150 对才计入连续退步；不完整或恢复到阈值以上会重置连续计数。每次区间是单次检查的界限，没有校正长期反复监控的整体误报率。

运行首次启动时记录训练、模拟与编码源码的 SHA-256（文本按 LF 规范化）。重启或运行期间发现源码变化会停止，须换新运行目录；不要修改既有 `config.json` 绕过协议检查。累计运行时间跨恢复累加，不含暂停时间。`STOP` 导致的正常退出不会触发崩溃重启。

## 持续更新研究报告

训练工作目录现为 `D:\vibecoding\guandan`。训练参数和权重留在该目录的 `work/continuous/`，专用报告工作树只更新两份小文件：`docs/MODEL_STUDY.md` 和 `docs/evaluation/model-study-progress.json`。

```bash
python scripts/update-model-study.py --workspace D:/vibecoding/guandan
python scripts/update-model-study.py --workspace D:/vibecoding/guandan --publish --watch-minutes=1500 --interval-seconds=3600
```

第二条命令只能在专用干净工作树运行。报告器每至多 60 秒检查新完成的门控、锚点评测、有限实验周期及停机记录，发现变化即汇总并开始发布检查；检查与推送本身另需时间。没有新结论时，`--interval-seconds=3600` 表示每小时同步一次训练进展，不会因采样计数不断增加而每分钟提交。仅检测完成事件时读取小记录，不反复散列全部历史训练权重。

每次汇总保留实际采样、训练步数、门控及锚点的逐种子结果与指纹，运行 `npm test`、`npm run format:check` 和相关 Python 测试后正常推送 `HEAD:main`。遇到其他修改、远端分叉、报告器源码变化或推送竞争就停止；不强推，不暂存其他文件，不发布权重。观察窗口至多 25 小时，定时汇报本身不代表 24 小时训练已完成。

每局发牌种子由比赛种子派生，不同比赛种子在极少数情况下可能得到相同的某一局发牌；这只影响单局牌面，不影响种子区间的用途划分。

## 发布冠军到网页

冠军文件在 `<运行目录>/champion/champion.onnx`。替换网页默认模型前：

1. 用此前从未使用过的锁定种子，以 `npm run eval:table -- --policy=<冠军文件>` 做整场留出验收，并与当前默认模型配对比较；
2. 运行浏览器数值检查；
3. 把结果写入研究报告，再由人工决定是否修改 `src/ai/models.mjs` 与 `ai/policy.onnx`。

## 目录内容

| 路径                          | 内容                                           |
| ----------------------------- | ---------------------------------------------- |
| `config.json`                 | 首次启动时冻结的配置与初始模型 SHA-256         |
| `models/`                     | 最近几个导出版本、`latest.json`、`anchor.onnx` |
| `shards/`                     | 未被缓冲区淘汰的样本分片                       |
| `league/`                     | 联赛成员与 PFSP 统计                           |
| `champion/`                   | 当前冠军及更替历史                             |
| `gate/`                       | 每次门控的逐对结果                             |
| `anchor/`                     | 每次锚点检查的逐对结果与检查期间冻结的候选副本 |
| `learner/`                    | 检查点、训练日志、状态                         |
| `actors/`                     | 每个采样进程的状态与逐场结果                   |
| `status.json`、`events.jsonl` | 汇总状态与事件记录                             |
