"""One-time faithful export of the policy checkpoint to browser ONNX."""
from pathlib import Path
import sys
import onnx
from onnx import helper, numpy_helper, TensorProto

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai.reference.numpy_engine import PolicyNetwork

model = PolicyNetwork(ROOT / 'ai/policy.ckpt')
nodes, initializers = [], []
previous = 'features'
for i, (weight, bias) in enumerate(model.layers):
    initializers += [numpy_helper.from_array(weight, f'w{i}'), numpy_helper.from_array(bias, f'b{i}')]
    output = f'linear{i}' if i < 5 else 'values'
    nodes.append(helper.make_node('Gemm', [previous, f'w{i}', f'b{i}'], [output]))
    if i < 5:
        previous = f'hidden{i}'
        nodes.append(helper.make_node('Tanh', [output], [previous]))
    else:
        previous = output
graph = helper.make_graph(nodes, 'GuanDanPolicy',
    [helper.make_tensor_value_info('features', TensorProto.FLOAT, ['batch', 567])],
    [helper.make_tensor_value_info('values', TensorProto.FLOAT, ['batch', 1])], initializers)
exported = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)],
                             producer_name='GuandanAI')
exported.ir_version = 8
onnx.checker.check_model(exported)
onnx.save(exported, ROOT / 'ai/policy.onnx')
print('Exported original float32 weights to ai/policy.onnx')
