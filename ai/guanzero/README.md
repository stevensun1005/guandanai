# GuanZero 模型

与danMCai 模型分开的训练路线。网络接收当前观察、候选动作和公开出牌历史，方法与实测以[研究报告第 13 节](../research/MODEL_STUDY.md#13-guanzero从随机初始化开始的-dmc-对照实验)为准。

| 找什么                 | 位置                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| 网络结构、优化器与导出 | [training/model.py](training/model.py)                                                                         |
| 训练启动与进程管理     | [training/run.mjs](training/run.mjs)                                                                           |
| 学习器                 | [training/learner.py](training/learner.py)                                                                     |
| 采样器                 | [training/actor.mjs](training/actor.mjs)                                                                       |
| GPU 推理服务及客户端   | [training/inference.py](training/inference.py)、[training/inference-client.mjs](training/inference-client.mjs) |
| 公开历史编码           | [training/history.mjs](training/history.mjs)、[training/history_reference.py](training/history_reference.py)   |
| 评测                   | [training/evaluate.mjs](training/evaluate.mjs)                                                                 |
| 训练面板               | [training/dashboard.mjs](training/dashboard.mjs)、[training/dashboard](training/dashboard)                     |
| 测试                   | [tests](tests)                                                                                                 |

新运行默认放在 `ai/guanzero/runs/`，大权重和缓冲区不进入 Git。根目录使用 `npm run train:guanzero` 或 `npm run train:guanzero:dashboard`。

另一台电脑若仍在训练，先保留当前冻结源码检出，再升级目录；不要在运行中把新路径代码直接覆盖进去。[具体迁移步骤](../research/STRUCTURE_MIGRATION.md)。

网页名称统一使用 `训练任务名-版本数值`，如 `guanzero-adp-gpubatch-44752`。网页只保留最近两代 GuanZero，默认仍为danMCai 门控冠军；[当前菜单](../../web/docs/WEB_MODELS.md) 为唯一版本入口。GuanZero 的训练量与开发结果不能直接等同原论文或独立验收成绩。

## 开发评测对手

默认对手为随机出牌（`random`）、原版规则（`rule`，`original`）、P0（`p0`）和 Clint规则机器人（`clint`，`rules-v2`）。Clint 与网页纯规则分支使用同一版本策略，仅读取自己的牌及公开信息，不加载模型；旧报告中的 `rule` 仍代表原版规则，不能改名为 Clint。

```powershell
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=100
# 仅运行 Clint
node ai/guanzero/training/evaluate.mjs --run=<运行目录> --pairs=100 --opponents=clint
```

每个对手使用同一冻结检查点，100 对种子交换阵营共 200 场完整比赛；报告保存对手版本、实际胜负平、模型与评测源码 SHA。评测数据不进入训练缓冲区。

正在运行的旧检出不覆盖源码，可独立补充 Clint：

```powershell
node ai/guanzero/training/supplement-evaluations.mjs --run=<冻结运行目录> --from-block=2 --guardian-state=<该轮运行守护状态文件>
```

补充进程读取原批次的模型、种子与样本量，将结果写入 `eval/block-NNNN/clint/report.json`；原报告保持不动。面板仅在模型 SHA、批次、种子范围与样本量全部一致时合并展示。它会跟随之后的新批次，包括守护完成前的最终评测；守护完成且现有批次已处理后退出。`.clint-supplement.lock` 阻止同一运行重复启动，`clint-supplement-status.json` 保存当前状态。异常时保留已有证据，不能将未完成或不匹配的报告当成成绩。
