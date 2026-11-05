"""GuanZero DMC network: one shared random-initialized Q model for all seats."""
import argparse
import copy
import json
import os
import time
from pathlib import Path
import torch
from torch import nn

# FP32 throughout, including CUDA matrix products and cuDNN LSTM.
torch.set_float32_matmul_precision("highest")
torch.backends.cudnn.allow_tf32 = False

class GuanZeroNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.lstm = nn.LSTM(216, 128, batch_first=True)
        layers = [nn.Linear(695, 512), nn.ReLU()]
        for _ in range(4): layers += [nn.Linear(512,512), nn.ReLU()]
        layers += [nn.Linear(512,1)]
        self.dense = nn.Sequential(*layers)

    def forward(self, state, history, actions):
        hidden = self.lstm(history)[0][:,-1,:]
        count = actions.shape[0]
        inputs = torch.cat((hidden.expand(count,-1),state.expand(count,-1),actions),dim=-1)
        return self.dense(inputs)

def replace_atomic(temporary, file):
    """Windows readers/scanners can briefly deny replacement; never hide permanent failure."""
    for attempt in range(20):
        try:
            os.replace(temporary, file)
            return
        except PermissionError:
            if attempt == 19: raise
            time.sleep(min(.25, .01 * 2**attempt))

def atomic_json(file, value):
    file = Path(file)
    temporary = file.with_name(file.name + f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, indent=2),encoding='utf-8')
    replace_atomic(temporary,file)

def export_onnx(model, file):
    file = Path(file)
    file.parent.mkdir(parents=True,exist_ok=True)
    temporary = file.with_name(file.name + f'.{os.getpid()}.tmp')
    exported = copy.deepcopy(model).cpu().eval()
    with torch.no_grad():
        torch.onnx.export(exported,(torch.zeros(1,513),torch.zeros(1,5,216),torch.zeros(3,54)),str(temporary),
            input_names=['state','history','actions'],output_names=['values'],opset_version=17,
            dynamic_axes={'actions':{0:'candidates'},'values':{0:'candidates'}},dynamo=False,
            external_data=False)
    replace_atomic(temporary,file)

def optimizer(model):
    return torch.optim.RMSprop(model.parameters(),lr=1e-4,alpha=0.99,eps=1e-5,momentum=0)

def update(model, optim, features, targets, device):
    x = torch.as_tensor(features,dtype=torch.float32,device=device)
    y = torch.as_tensor(targets,dtype=torch.float32,device=device).reshape(-1,1)
    model.train()
    optim.zero_grad(set_to_none=True)
    values = model(x[:,:513],x[:,513:1593].reshape(-1,5,216),x[:,1593:])
    loss = ((values-y)**2).mean()
    if not torch.isfinite(loss): raise FloatingPointError('Non-finite GuanZero loss; training stopped')
    loss.backward()
    nn.utils.clip_grad_norm_(model.parameters(),40,error_if_nonfinite=True)
    optim.step()
    if any(not torch.isfinite(p).all() for p in model.parameters()):
        raise FloatingPointError('Non-finite GuanZero parameters; training stopped')
    return float(loss.detach().cpu())

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True)
    parser.add_argument('--seed',type=int,default=20261104)
    args=parser.parse_args()
    torch.set_num_threads(1)
    torch.manual_seed(args.seed)
    model=GuanZeroNet()
    export_onnx(model,args.output)
    print(json.dumps({'parameters':sum(p.numel() for p in model.parameters()),'seed':args.seed}))
