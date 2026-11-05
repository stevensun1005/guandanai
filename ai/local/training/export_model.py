"""One-time faithful export of the policy checkpoint to browser ONNX."""

from pathlib import Path
import sys
import onnx
from onnx import helper, numpy_helper, TensorProto

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT))
from ai.local.reference.numpy_engine import PolicyNetwork

model = PolicyNetwork(ROOT / "ai/local/models/baseline/policy.ckpt")
nodes, initializers = [], []
first_weight, first_bias = model.layers[0]
initializers += [
    numpy_helper.from_array(first_weight[:513].copy(), "state_weight"),
    numpy_helper.from_array(first_weight[513:].copy(), "action_weight"),
    numpy_helper.from_array(first_bias, "first_bias"),
]
nodes += [
    helper.make_node("Gemm", ["state", "state_weight", "first_bias"], ["state_hidden"]),
    helper.make_node("MatMul", ["actions", "action_weight"], ["action_hidden"]),
    helper.make_node("Add", ["state_hidden", "action_hidden"], ["first_linear"]),
    helper.make_node("Tanh", ["first_linear"], ["hidden0"]),
]
previous = "hidden0"
for i, (weight, bias) in enumerate(model.layers[1:], start=1):
    initializers += [
        numpy_helper.from_array(weight, f"w{i}"),
        numpy_helper.from_array(bias, f"b{i}"),
    ]
    output = f"linear{i}" if i < 5 else "values"
    nodes.append(helper.make_node("Gemm", [previous, f"w{i}", f"b{i}"], [output]))
    if i < 5:
        previous = f"hidden{i}"
        nodes.append(helper.make_node("Tanh", [output], [previous]))
    else:
        previous = output
graph = helper.make_graph(
    nodes,
    "GuanDanPolicy",
    [
        helper.make_tensor_value_info("state", TensorProto.FLOAT, [1, 513]),
        helper.make_tensor_value_info("actions", TensorProto.FLOAT, ["batch", 54]),
    ],
    [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 1])],
    initializers,
)
exported = helper.make_model(
    graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI"
)
exported.ir_version = 8
onnx.checker.check_model(exported)
onnx.save(exported, ROOT / "ai/local/models/baseline/policy.onnx")
print("Exported original float32 weights to ai/local/models/baseline/policy.onnx")
