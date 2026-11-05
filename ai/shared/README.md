# 共享模拟与测试数据

- [simulation](simulation)：完整比赛模拟、单把模拟、规则对手、统计和网页 WASM 评测入口。
- [fixtures](fixtures)：固定局面及编码、残局、应牌参考数据。
- [tests](tests)：共享模拟及比较口径的测试。

牌规使用唯一实现 [web/src/core](../../web/src/core)，公开信息编码与浏览器推理复用 [web/src/ai](../../web/src/ai)。两条训练路线通过导入共享，不复制规则。

规则基线显式区分 `original` 与 `rules-v2`（Clint）；历史原版规则成绩不能改名为 Clint。固定种子和公开信息边界由共享模拟器及测试核对。

真人牌谱下载和预处理在 [data](data/README.md)，接收端在 [web/collector](../../web/collector/README.md)。原始数据及生成样本被忽略，不自动混入两条训练路线或独立验收。
