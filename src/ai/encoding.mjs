// Feature layout is defined by the supplied checkpoint's client, not paper labels.
export function cardIndex(id) {
  const n = id % 54;
  return n >= 52 ? n : (n % 13) * 4 + [1,0,2,3][Math.floor(n / 13)];
}
export function cardsArray(ids) {
  const a = new Float32Array(54);
  if (ids?.length === 1 && ids[0] === -1) return a.fill(-1);
  for (const id of ids || []) a[cardIndex(id)]++;
  return a;
}
function universalFlags(hand, level) {
  const result = new Float32Array(12), wild = (level - 2) * 4;
  if (!hand[wild]) return result;
  result[0] = 1;
  for(let suit=0;suit<4 && !result[1];suit++)for(let start=0;start<8;start++){
    let missing=0;
    for(let rank=start;rank<start+5;rank++)if(suit+rank*4===wild || !hand[suit+rank*4])missing++;
    if(missing<=1){result[1]=1;break;}
  }
  const counts=Array.from({length:13},(_,rank)=>[0,1,2,3].filter(suit=>suit+rank*4!==wild && hand[suit+rank*4]).length);
  for(let i=8-Math.max(1,Math.min(6,Math.max(...counts)));i<8;i++)result[i]=1;
  let tail=0;
  for(let i=0;i<13;i++){
    const c=counts[i];
    if(!c){tail=0;continue;}
    tail++;
    if(i>=1){const prev=counts[i-1];if((c===2&&prev>=3)||(c>=3&&prev===2))result[9]=1;else if(c===2&&prev===2)result[11]=1;}
    if(i>=2){const a=counts[i-2],b=counts[i-1];if((a===1&&b>=2&&c>=2)||(a>=2&&b===1&&c>=2)||(a>=2&&b>=2&&c===1))result[10]=1;}
  }
  if(tail>=4)result[8]=1;
  return result;
}
function replay(log){
  const histories=[[],[],[],[]],sequence=[],out=[],remaining=[27,27,27,27];let flag=1;
  const append=(p,cards)=>{histories[p].push(cards);sequence.push(cards);};
  for(const e of log){
    const p=e.p,cards=e.cards||[];append(p,cards);
    if(out.length===1){
      if(cards.length&&flag===1){flag=2;if(p===(out[0]+3)%4)append(out[0],[-1]);}
      else if(flag===1&&(p+1)%4===out[0]){flag=2;append(out[0],[-1]);append((p+2)%4,[]);}
      else if(p===(out[0]+3)%4&&flag===2)append(out[0],[-1]);
    }else if(out.length===2){
      if(cards.length&&flag<=2){flag=3;if(out.includes((p+1)%4)){append((p+1)%4,[-1]);append((p+2)%4,[-1]);}}
      else if(flag<=2&&out.includes((p+1)%4)){flag=3;append((p+1)%4,[-1]);append((p+2)%4,[-1]);if(p===(out.at(-1)+2)%4)append((p+3)%4,[]);}
      else if(out.includes((p+1)%4)&&flag===3){append((p+1)%4,[-1]);append((p+2)%4,[-1]);}
    }
    remaining[p]-=cards.length;if(remaining[p]===0&&!out.includes(p))out.push(p);
  }
  return {histories,sequence,out};
}
export function encode(state){
  const {p,log}=state,hand=cardsArray(state.hand),unseen=new Float32Array(54).fill(2);
  for(let i=0;i<54;i++)unseen[i]-=hand[i];
  for(const e of log)for(const id of e.cards||[])unseen[cardIndex(id)]--;
  const {histories,sequence,out}=replay(log),mate=(p+2)%4;
  const lastMate=histories[mate].length&&!out.includes(mate)?histories[mate].at(-1):[-1];
  const parts=[hand,universalFlags(hand,state.level),unseen,cardsArray(sequence.length?sequence.at(-1):[-1]),cardsArray(lastMate)];
  for(const offset of [1,2,3])parts.push(cardsArray(log.filter(e=>e.p===(p+offset)%4).flatMap(e=>e.cards||[])));
  for(const offset of [1,2,3]){const one=new Float32Array(28);one[state.counts[(p+offset)%4]]=1;parts.push(one);}
  for(const name of ['selfLevel','opponentLevel','level']){const one=new Float32Array(13);one[state[name]-2]=1;parts.push(one);}
  const result=new Float32Array(513);let at=0;
  for(const part of parts){result.set(part,at);at+=part.length;}
  if(at!==513)throw new Error('Invalid model feature size');
  return result;
}
