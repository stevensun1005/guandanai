import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {encode, cardsArray} from '../src/ai/encoding.mjs';

test('browser features match the independent NumPy reference on recorded real positions',()=>{
  const states=JSON.parse(readFileSync(new URL('./fixtures/positions.json',import.meta.url),'utf8'));
  const program="import json,sys; from ai.reference.numpy_engine import encode; from pathlib import Path; s=json.loads(Path('tests/fixtures/positions.json').read_text()); print(json.dumps([encode(x).tolist() for x in s]))";
  const expected=JSON.parse(execFileSync('python',['-c',program],{cwd:new URL('../',import.meta.url),encoding:'utf8',maxBuffer:20*1024*1024}));
  for(let i=0;i<states.length;i++)assert.deepEqual(Array.from(encode(states[i])),expected[i],`snapshot ${i}`);
  assert.equal(states.length,834);
});
test('54 feature positions preserve suits and duplicate deck copies',()=>{
  for(let id=0;id<54;id++){
    const a=cardsArray([id]),b=cardsArray([id+54]);
    assert.deepEqual(a,b);assert.equal(a.reduce((x,y)=>x+y),1);
  }
  assert.deepEqual(cardsArray([-1]),new Float32Array(54).fill(-1));
});
