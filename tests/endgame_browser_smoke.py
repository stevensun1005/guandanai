"""A real browser Worker and controller must keep proved public-information endings."""
from pathlib import Path
import json,sys
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/'
URL+=('&' if '?' in URL else '?')+'test=1'
fixtures=json.loads((ROOT/'tests/fixtures/endgame-positions.json').read_text(encoding='utf-8'))
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    page=browser.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(URL,wait_until='networkidle');page.wait_for_function('TableBot.ready',timeout=90000)
    reports=[]
    for fixture in fixtures:
        state=fixture['state'];expected=fixture['expectedIndex']
        result=page.evaluate("""state=>new Promise((resolve,reject)=>{
          const worker=new Worker(new URL('./assets/ai-worker.mjs',document.baseURI),{type:'module'});
          worker.onmessage=({data})=>{worker.terminate();if(data.error)reject(Error(data.error));else resolve(data.result)};
          worker.onerror=event=>reject(Error(event.message));worker.postMessage({id:1,type:'decide',state});
        })""",state)
        assert result['endgame']['winning'],result
        assert result['index']==expected,(result,expected)
        # A style must not replace a proved continuation with a losing close-score action.
        chosen=page.evaluate("""async ({state,style})=>{
          resetGame();const deck=makeDeck(),known=new Set(state.hand.concat(state.log.flatMap(entry=>entry.cards || [])));
          G.hands=[[],[],[],[]];G.hands[state.p]=state.hand.map(id=>deck[id]);
          const other=state.counts.findIndex((count,seat)=>seat!==state.p&&count>0);
          G.hands[other]=deck.filter(card=>!known.has(card.id));
          G.L=state.level;G.levels=[state.selfLevel,state.opponentLevel];
          if(state.p%2)G.levels.reverse();
          G.log=state.log.map(entry=>({...entry,cards:entry.cards?.map(id=>deck[id]) || null}));
          G.trick=state.endgame.trick;G.passes=state.endgame.passes;G.phase='play';G.turn=state.p;G.clock=null;
          botStyles=Array(4).fill(style);
          const play=await TableBot.decide(state.p);
          return play ? {ids:play.cards.map(card=>card.id).sort((a,b)=>a-b),type:play.type,value:play.value} : null;
        }""",{'state':state,'style':'aggressive'})
        assert chosen['ids']==sorted(state['actions'][expected])
        assert chosen['type']==state['endgame']['shapes'][expected]['type']
        reports.append({'expected':expected,'baseline':fixture['baselineIndex'],'nodes':result['endgame']['nodes'],'searchMs':result['endgame']['elapsedMs']})
    assert not errors,errors
    print(json.dumps({'provedEndings':len(reports),'protectedFromStyleOverride':True,'pageErrors':errors,'positions':reports}))
    browser.close()
