import * as ort from './vendor/ort.wasm.min.mjs';
import {encode,cardsArray} from './encoding.mjs';

ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
let sessionPromise;
const modelURL=new URL('../models/policy.onnx',import.meta.url);
modelURL.search=self.location.search;
const session=()=>sessionPromise ||= ort.InferenceSession.create(modelURL.href,
  {executionProviders:['wasm'],graphOptimizationLevel:'all'});

async function decide(state){
  const engine=await session(),features=encode(state);
  const started=performance.now();let best=-Infinity,index=0;
  const stateTensor=new ort.Tensor('float32',features,[1,513]);
  for(let first=0;first<state.actions.length;first+=128){
    const chunk=state.actions.slice(first,first+128),batch=new Float32Array(chunk.length*54);
    for(let i=0;i<chunk.length;i++)batch.set(cardsArray(chunk[i]),i*54);
    const actionTensor=new ort.Tensor('float32',batch,[chunk.length,54]);
    const output=await engine.run({state:stateTensor,actions:actionTensor});
    const values=output.values.data;
    for(let i=0;i<values.length;i++){if(!Number.isFinite(values[i]))throw Error('Invalid model output');if(values[i]>best){best=values[i];index=first+i;}}
    actionTensor.dispose();
    for(const tensor of Object.values(output))tensor.dispose();
  }
  stateTensor.dispose();
  return {index,value:best,candidates:state.actions.length,elapsedMs:Math.round(performance.now()-started)};
}
let queue=Promise.resolve();
self.onmessage=event=>{
  const {id,type,state}=event.data;
  queue=queue.then(async()=>{
    try{const result=type==='init'?(await session(),{ready:true}):await decide(state);self.postMessage({id,result});}
    catch(error){sessionPromise=undefined;self.postMessage({id,error:String(error.message||error)});}
  });
};
