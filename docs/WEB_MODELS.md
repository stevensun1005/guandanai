# 网页电脑：按编号选模型

大厅的「电脑模型」为每个空位独立选择编号。001 是原始 P0，002 起是新增训练模型；编号代表身份，不代表强弱排名。新玩家默认用最近发布的模型；已保存的旧编号继续生效，点「全部使用最新模型」可重置。朋友房间由房主设置，加入者只查看。重连及房主退出后继续单机均保留座位对应模型。

## 每四小时更新

所有者已授权每 4 小时把当前最新、完整导出的训练检查点放进网页。定时任务在本机 Codex 中运行；机器需开机、联网且 Codex 正在运行。没有新导出则不重复创建编号。发布失败保留当前网页版本，报告失败，不覆盖旧附件。

1. 在 `main` 拉取最新代码，保留其他开发者的修改，确认当前模型清单。
2. 运行 `node scripts/publish-web-model.mjs --run=work/continuous/gpu-main`，先冻结导出，核对完整 SHA-256 并检查 1／3／129 个候选的 ONNX 输出。
3. 加 `--publish` 上传不可变的 `web-model-NNN` Release 附件，验证公网下载的完整 SHA-256，注册新的编号并更新默认值、成果索引、研究报告及发布证据。
4. 运行 `npm test`、`npm run format:check`、相关 Python 测试、`npm run build` 及真实浏览器 WASM 检查。只暂存本次发布的明确文件，直接提交、推送 `main`；检查 GitHub Pages 部署结果。

训练目录不被修改，二进制不进入 Git；构建时从清单指定的 Release 下载权重并校验 SHA-256，然后打包为同源 Pages 资源。旧编号、源文件与完整校验码保留。页面版本包含模型内容摘要，已有牌局不热切；刷新页面后取得新清单。新旧网页的房间版本检查继续生效。

“上线”与“更强”是两个结论。本流程只保证可追溯部署与兼容性，不能替代整场留出评测，也不能据此宣称胜率超过 80%。最新版本可能退步，玩家可以主动选旧编号。

## 另一台电脑如何加入 bot

先拉取最新 `main`，不要事先抢占编号。在自己的机器运行：

```powershell
node scripts/publish-web-model.mjs --model=D:/your-run/model.onnx --source=guanAI --version=your-checkpoint --config=D:/your-run/web-config.json
# 检查准备结果后，以同样参数加 --publish
```

`web-config.json` 的普通价值网络配置：

```json
{ "stateFeatures": 513, "actionFeatures": 54 }
```

与仓库 GuanZero 编码一致的 LSTM 网络配置：

```json
{ "stateFeatures": 513, "actionFeatures": 54, "history": "guanzero-v1" }
```

输入分别为 `state: [1,513]`、`actions: [N,54]`，LSTM 另需 `history: [1,5,216]`，输出 `values: [N,1]`。动作批次必须动态，所有权重包含在单个 ONNX 内。支持既有 `extraFeatures: 53/61`、提案 Actor 的 `rerankCandidates` 等配置；它们必须与实际导出匹配。不同编码、输入或算法需新增适配器和数值／浏览器检查，不能仅改编号假装兼容。

完成后提交清单及证据，推送 `main`。上传时发现编号冲突就停止并重新同步；不得覆盖他人的 Release、编号或训练数据。没有新模型文件时，只保留接入文档，不创建空占位编号。

## 文件职责

| 文件                                   | 用途                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| `src/ai/model-catalog.json`            | 编号、默认值、SHA-256、Release 地址、网络配置与来源的唯一清单 |
| `src/ai/model-catalog.mjs`             | 校验清单、解析编号和缺省选择                                  |
| `scripts/publish-web-model.mjs`        | 冻结、验证、上传及记录；不自动提交或推送                      |
| `scripts/lib/web-models.mjs`           | 构建时获取权重并验证 SHA-256                                  |
| `docs/evaluation/web-model-NNN.json`   | 每次真实发布的机器可读证据                                    |
| `docs/evaluation/model-artifacts.json` | 权重与网页模型成果索引                                        |

历史风格代码与 `src/ai/models.mjs` 的 P0／R1 配置仍服务于可复现研究；大厅、控制器及房间协议使用独立的编号清单，不在编号选择后叠加性格偏好。
