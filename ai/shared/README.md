# 共享模拟与测试数据

- [simulation](simulation)：完整比赛模拟、单把模拟、规则对手、统计和网页 WASM 评测入口。
- [fixtures](fixtures)：固定局面及编码、残局、应牌参考数据。
- [tests](tests)：共享模拟及比较口径的测试。

牌规使用唯一实现 [web/src/core](../../web/src/core)，公开信息编码与浏览器推理复用 [web/src/ai](../../web/src/ai)。两条训练路线通过导入共享，不复制规则。
