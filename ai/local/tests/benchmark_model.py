"""Compare identical float32 policy weights in a real browser Worker."""

from pathlib import Path
import json
import sys
import onnx
from onnx import helper, numpy_helper, TensorProto
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT))
from ai.local.reference.numpy_engine import PolicyNetwork, encode, cards_array


def baseline_model():
    model = PolicyNetwork()
    nodes = []
    initializers = []
    previous = "features"
    for i, (w, b) in enumerate(model.layers):
        initializers.extend(
            [numpy_helper.from_array(w, f"w{i}"), numpy_helper.from_array(b, f"b{i}")]
        )
        output = f"linear{i}" if i < 5 else "values"
        nodes.append(helper.make_node("Gemm", [previous, f"w{i}", f"b{i}"], [output]))
        if i < 5:
            previous = f"hidden{i}"
            nodes.append(helper.make_node("Tanh", [output], [previous]))
        else:
            previous = output
    graph = helper.make_graph(
        nodes,
        "BenchmarkPolicy",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["batch", 567])],
        [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 1])],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    return model.SerializeToString()


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
    url += ("&" if "?" in url else "?") + "test=1"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context()
        context.route(
            "**/models/benchmark-baseline.onnx",
            lambda route: route.fulfill(
                body=baseline_model(), content_type="application/octet-stream"
            ),
        )
        page = context.new_page()
        page.goto(url, wait_until="networkidle")
        page.evaluate("TableBot.check()")
        page.wait_for_function("TableBot.ready", timeout=90000)
        state = page.evaluate("""() => {
          resetGame();G.L=2;G.levels=[2,2];G.log=[];
          const deck=makeDeck();let seed=9183;
          for(let i=deck.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
          G.hands=[[],[],[],[]];deck.forEach((c,i)=>G.hands[i%4].push(c));
          return TableBot.state(0,TableBot.candidates(G.hands[0],G.L,null));
        }""")
        payload = {
            "features": encode(state).tolist(),
            "actions": [cards_array(action).tolist() for action in state["actions"]],
        }
        result = page.evaluate(
            """payload=>new Promise((resolve,reject)=>{
          const base=new URL('../../../web/tests/',document.baseURI).href;
          const code=`
            import * as ort from '${base}assets/vendor/ort.wasm.min.mjs';
            ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths='${base}assets/vendor/';
            let original,optimized;
            const models=Promise.all([
              ort.InferenceSession.create('${base}models/benchmark-baseline.onnx',{executionProviders:['wasm']}),
              ort.InferenceSession.create('${base}models/policy.onnx',{executionProviders:['wasm']})]);
            async function run(payload,split){
              const started=performance.now(),scores=[];
              const stateTensor=new ort.Tensor('float32',Float32Array.from(payload.features),[1,513]);
              for(let first=0;first<payload.actions.length;first+=128){
                const actions=payload.actions.slice(first,first+128),size=split?54:567,data=new Float32Array(size*actions.length);
                for(let i=0;i<actions.length;i++){if(!split)data.set(payload.features,i*size);data.set(actions[i],i*size+(split?0:513));}
                const tensor=new ort.Tensor('float32',data,[actions.length,size]);
                const out=await(split?optimized.run({state:stateTensor,actions:tensor}):original.run({features:tensor}));
                scores.push(...out.values.data);tensor.dispose();out.values.dispose();
              }
              stateTensor.dispose();return{ms:performance.now()-started,scores};
            }
            self.onmessage=async({data})=>{
              try{
                [original,optimized]=await models;
                const a=[],b=[];let maxError=0;
                for(let i=0;i<32;i++){
                  const first=i%2?await run(data,true):await run(data,false);
                  const second=i%2?await run(data,false):await run(data,true);
                  const old=i%2?second:first,fresh=i%2?first:second;
                  if(i>=4){a.push(old.ms);b.push(fresh.ms);}
                  for(let j=0;j<old.scores.length;j++)maxError=Math.max(maxError,Math.abs(old.scores[j]-fresh.scores[j]));
                }
                a.sort((x,y)=>x-y);b.sort((x,y)=>x-y);
                self.postMessage({baselineMedianMs:a[Math.floor(a.length/2)],optimizedMedianMs:b[Math.floor(b.length/2)],maxError,candidates:data.actions.length});
              }catch(error){self.postMessage({error:String(error)});}
            };
          `;
          const objectURL=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
          const worker=new Worker(objectURL,{type:'module'});
          const timer=setTimeout(()=>{worker.terminate();reject(Error('Benchmark timeout'))},90000);
          worker.onmessage=({data})=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(objectURL);data.error?reject(Error(data.error)):resolve(data)};
          worker.onerror=error=>reject(Error(error.message));worker.postMessage(payload);
        })""",
            payload,
        )
        assert result["maxError"] < 2e-4, result
        result["inputReductionPercent"] = round(100 * (1 - (513 + 128 * 54) / (128 * 567)), 1)
        result["medianSpeedup"] = round(result["baselineMedianMs"] / result["optimizedMedianMs"], 3)
        out = ROOT / "web/artifacts/validation/model-performance.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result))
        browser.close()


if __name__ == "__main__":
    main()
