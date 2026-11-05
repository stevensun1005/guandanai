# 共享环境

- `requirements-models.txt`：NumPy、ONNX 与 ONNX Runtime。
- `requirements-training.txt`：上述依赖及固定 PyTorch；不要覆盖已验证的 Windows ROCm 专用环境。
- `requirements-dev.txt`：模型检查与浏览器开发工具。
- `setup-mac.sh`：原生 Apple silicon 的独立 Python 3.12 环境与 Node 依赖安装；MPS 不可用时停止，不冒充 GPU。

本次 MacBook 只执行一个 24 小时续训窗口，迁移附件、冻结工作树、资源预算与停止规则统一见 [MAC_HANDOFF](../research/MAC_HANDOFF.md)。Windows 环境和运行原件保留；新环境位于忽略的 `ai/danMCai/environment/mac/`，不复制 Windows 的虚拟环境、目录连接或 node_modules。
