# danMCai 尾盘明牌引导训练

所有者 2026-11-07 授权：保留另一台电脑的 danMCai 训练不动，在本 MacBook 上单独训练一个尾盘模型，之后再接入 danMCai；方法按 PerfectDou／Suphx 的"训练时看明牌、执行时只看自己的牌"来做，训练期间开启面板。

本目录是一条**独立实验**，不修改网页冠军、清单、奖励定义或任何正在运行的冻结训练。结果与协议见[研究主报告](../../research/MODEL_STUDY.md)和 [evaluation/endgame-oracle-20261107](../../research/evaluation/endgame-oracle-20261107/)。

## 方法

- **什么算尾盘**：全桌剩余手牌合计不超过阈值（默认 32 张）。阈值以前的出牌全部由冠军 017 贪心决定；进入尾盘后由当前学生模型决定（softmax 温度 0.02 探索）并记录样本。
- **训练标签**：做出这手牌的一方本局最终的签名升级分（±1／±2／±3），与 danMCai 现行目标一致；不使用牌权、压牌、炸弹等中间信号。
- **明牌引导（Suphx oracle guiding）**：网络＝冠军的 567→512×5→1 价值网络，首层额外加一个 162→512 的投影，输入另外三家的真实手牌（只在训练时提供）。起点是冠军的精确拷贝（明牌投影为零）。每个样本的明牌信息按保留率 p 输入、否则置零；p 从 1 线性降到 0，之后继续只用自己的牌训练。
- **导出**：学生模型去掉明牌投影，与网页现有 ONNX 格式完全相同（`state`／`actions` → `values`），可按"尾盘时换用"的方式接入，也可作为 danMCai 尾盘的教师。接入需要另行的独立验收。
- **精确求解器**（`solver.mjs`）：四家明牌下的团队极小极大精确解，用于评测时描述性地比较"学生／冠军的选择离明牌最优解差多少"。它不进训练标签。基准：全桌剩 20 张以内大多 1 秒内解完，24 张起开始有超出预算的局面。

## 文件

| 文件                 | 作用                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `run.mjs`            | 调度：冻结配置与源码 SHA、固定截止、启动学习器与采样进程                                                     |
| `actor.mjs`          | 采样：冠军打到尾盘，学生接手并记录样本与明牌特征                                                             |
| `learner.py`         | 学习器：Apple MPS，明牌保留率衰减，定时导出学生 ONNX                                                         |
| `dashboard.mjs`      | 只读本机面板，默认 <http://127.0.0.1:8768/>；顶部“现在在做什么”按真实进程与文件显示阶段                      |
| `evaluate.mjs`       | 留出评测：同副牌交换阵营，学生接管尾盘 vs 纯冠军                                                             |
| `solver.mjs`         | 明牌精确求解器（评测诊断用）                                                                                 |
| `human-endgames.mjs` | 真人牌局尾盘精确最优审计：逐手对比真人／冠军／学生与明牌最优，模型接管一家 vs 明牌最优对手（只诊断，不训练） |
| `pimc-actor.mjs`     | 求解器标注采样：冠军打到 ≤20 张，每个尾盘决策的每个候选用 8 个公开信息抽样世界的精确值平均作标签（第 68 节） |

## 运行

```bash
node ai/danMCai/endgame/run.mjs --run=ai/danMCai/runs/<运行名> --python=ai/danMCai/environment/mac/bin/python
node ai/danMCai/endgame/dashboard.mjs --run=ai/danMCai/runs/<运行名>
```

面板顶部“现在在做什么”只根据真实状态判断当前阶段：采样＋训练、采样种子用完后仅等待固定截止、`post-run-evaluate.sh` 启动的独立评测（读取 `eval-final/run.json`、分片和评测进程），以及 `summary.json` 写出后的结果。评测分片只在结束时写出，中途没有更细的进度；页面上的时间一律按多伦多时间（America/Toronto，标"美东"）显示；仓库里的证据文件仍保留原始 ISO／UTC 时间戳。面板不控制训练，也不把阶段或损失当成棋力。

运行目录放在 iCloud 同步之外（例如 `~/guandan-runtime.noindex/<运行名>`，再在 `ai/danMCai/runs/` 建链接）：桌面若开启 iCloud 同步，样本分片会被上传和索引。学习器按 `keepShardRows`（默认 200 万行）删除已摄入的旧分片数据文件，保留 JSON 元数据。

首次启动冻结 `config.json`（冠军 SHA、种子块、阈值、学习率、固定截止、源码 SHA）；重启只用原截止前的剩余时间，源码变化则拒绝启动。运行目录下新建 `STOP` 文件即可让所有进程保存后退出。运行数据、模型和样本都在忽略的 `ai/danMCai/runs/`。

测试：`node --test ai/danMCai/tests/endgame-*.test.mjs`、`ai/danMCai/environment/mac/bin/python ai/danMCai/tests/endgame_learner_test.py`。
