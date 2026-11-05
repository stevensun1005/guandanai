# 贡献指南

欢迎从一手牌、一个操作或一个明确问题开始改进。

## 开发环境

Node.js 20.19+，推荐与 CI 一致的 Node.js 24。克隆仓库后运行 `npm ci`、`npm run build`、`npm run dev`。

源码在 `web/src`，构建结果在 `web/dist`。不要直接修改 `web/dist`；不要把浏览器缓存、临时训练缓冲区或本机配置提交到仓库。已完成的实验报告、成果索引和研究检查点依照 [AGENTS.md](./AGENTS.md) 归档，与网页默认权重分开。

## 文件放对地方

- 牌型、比较和验证放 `core`。
- 回合流程放 `game`。
- 手牌操作放 `hand` 和 `input`。
- 房间行为放 `network`。
- 网页模型控制器与推理放 `web/src/ai`，Clint 纯规则放 `web/src/rule-bot`；训练分别放 `ai/danMCai` 和 `ai/guanzero`。`ai/danMCai/models/baseline` 是参考权重目录，新增权重按 Release 归档。
- 样式与图片放 `styles`、`assets`。

新增模块先明确它需要什么输入、会改变什么状态、由谁调用。不要因为顺手把另一个功能也塞进去。

## 提交前

```bash
npm run format:check
npm test
npm run build
```

格式需要调整时，对实际修改的文件运行 `npx prettier --write 文件路径`，避免顺带重写其他人的进行中改动。纯文档变更检查格式、链接、引用和事实一致性即可，不需要为文字修改重跑模型训练或整场对局。

UI 改动附实际截图并检查手机宽度；规则改动加入具体手牌用例；联机改动跑双浏览器检查；模型改动记录数值一致性、耗时和真实对战结果。

浏览器 CI 使用 Python 3.13。开发验证依赖见 `ai/environment/requirements-dev.txt`，模型导出与应牌训练依赖见 `ai/environment/requirements-models.txt`，完整主网训练还需 `ai/environment/requirements-training.txt`。例如 `python -m pip install -r ai/environment/requirements-training.txt` 会安装完整主网训练所需的 PyTorch；这些依赖不进入浏览器生产环境。Python 格式调整同样只针对本次修改的文件。

## 文档的职责

每次交付功能、接口、命名、配置或发布策略变更，都在同一提交范围核对并更新受影响的文档，然后推送 GitHub。中英文入口保持事实一致。

README 负责开局与开发入口；玩法、房间、练习和部署指南说明各自的操作边界。`MODEL_STUDY.md` 负责当前研究方法与证据结论，`TRAINING_RUN.md` 保留训练过程和历史协议，`IMPROVEMENT_PROPOSAL.md` 保留审查建议及实施状态，`ROADMAP.md` 只汇总已完成内容和下一步方向。

文档检查清单：

| 变更范围             | 同步入口                                                                       |
| -------------------- | ------------------------------------------------------------------------------ |
| 玩家功能与操作       | 中英文 README、`web/README.md`、对应玩法／房间／练习指南、CHANGELOG            |
| 电脑菜单、命名和发布 | `WEB_MODELS.md`、`BOTS.md`、发布 README、架构／部署及交接说明                  |
| 训练、评测或结果     | 对应 AI README、训练／测试指南、研究报告和原始证据                             |
| 云端采集与研究数据   | 采集 README、共享数据 README、房间／部署说明；说明采集条件、私有导出和训练隔离 |

过时的进行时应按实际结果更新；历史负结果、原始评测和曾使用的协议继续保留。没有被 Markdown 链接引用，不等于文件无用，例如 GitHub 自动读取的 PR 模板和文件夹 README。

## 提交与 PR

一个提交处理一件完整的事。PR 描述先说明玩家遇到什么问题、改完后的行为，再写验证方法。避免只有「优化」「修复一些问题」这样的标题。

需要调整记录格式或模型接口时，说明旧记录、缓存或旧页面版本如何处理。

## 反馈一个好用的问题

请提供：设备和浏览器、页面版本、房间或单人模式、可以重现的步骤、预期与实际结果。牌型问题尽量列出手牌与桌面牌；模型问题同时说明座位、剩余张数和公开出牌。

不要在公开 Issue 中附带私人连接信息、麦克风数据或与问题无关的个人资料。
