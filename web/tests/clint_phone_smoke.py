"""Real phone geometry and deal-animation targets; synthetic UI only, uploads blocked."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8784/').rstrip('/')+'/?test=1'
OUT=ROOT/'web/artifacts/validation/clint-sync-20261108-0435';OUT.mkdir(parents=True,exist_ok=True)
SETUP="""()=>{G.tok++;resetGame();G.round=1;Object.assign(G,{phase:'play',turn:0,L:2,paused:true,pausedBy:0,fixed:[],myOrder:[],reveal:0,gives:[],trib:[],seen:[],log:[],pw:[],out:[],clock:{who:0,left:60000,total:60000}});G.hands=Array.from({length:4},(_,p)=>makeDeck().slice(p*27,p*27+27));G.deck=[];hideOverlay();render();}"""
MEASURE="""()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {hand:r('#hand').height,nameY:r('#mebar .meinfo').y,ownX:r('#mebar .meinfo').x+r('#mebar .meinfo').width/2,partnerX:r('#seat2 .who').x+r('#seat2 .who').width/2,classes:document.documentElement.className}}"""
with sync_playwright() as p:
 browser=p.chromium.launch(channel='chrome',headless=True);errors=[];reports=[]
 for width,height,mobile in [(390,844,True),(375,667,True),(844,390,True),(1440,1000,False)]:
  context=browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile,reduced_motion='no-preference');context.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**',lambda route:route.abort())
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(URL,wait_until='networkidle');assert page.locator('.lobby-by').inner_text()=='made by Clint & SteZero';assert page.locator('#roomInfo small').count()==0
  page.locator('#nick').fill('手机长名字');page.locator('[data-seat=S]').click();page.locator('#sitBtn').click();page.wait_for_function('()=>G!==null');page.evaluate(SETUP);page.wait_for_timeout(150)
  first=page.evaluate(MEASURE);states=[]
  for n in [27,8,1,0]:
   page.evaluate('(n)=>{G.hands[0]=makeDeck().slice(0,n);render()}',n);page.wait_for_timeout(80);m=page.evaluate(MEASURE);states.append({'cards':n,**m})
   if mobile:assert abs(m['hand']-first['hand'])<1,(first,m)
   if 'rows' in m['classes'] and mobile:assert abs(m['ownX']-m['partnerX'])<2,m
  if mobile:
   assert max(s['nameY'] for s in states)-min(s['nameY'] for s in states)<1,states
   page.evaluate("()=>{G.round++;G.hands[0]=makeDeck().slice(0,1);render()}");small=page.evaluate(MEASURE);natural=page.evaluate('()=>Math.max(handGeo(1,handKeys(G.hands[0].map(c=>c.id))).height,phoneRows()&&!document.querySelector("#btns").hidden?document.querySelector("#btns").offsetHeight+6:0)');assert abs(page.evaluate('()=>parseFloat(document.querySelector("#hand").style.height)')-natural)<1,(small,natural)
   page.evaluate('()=>{G.hands[0]=[];render()}');page.set_viewport_size({'width':height,'height':width});page.wait_for_timeout(250);page.evaluate('()=>render()');assert page.evaluate('()=>document.querySelector("#hand").style.height')=='','Resize with empty hand retained stale height'
  # Hidden backs have no DOM box; every flyer must land on the visible seat plate.
  page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(150);page.evaluate(SETUP);targets=page.evaluate("""()=>[1,2,3].map(p=>{fly(p);const f=document.querySelector('.flyer:last-of-type');const m=f.style.transform.match(/translate\\(([-.\\d]+)px,\\s*([-.\\d]+)px\\)/);const r=document.querySelector('#seat'+p+' .who').getBoundingClientRect();return {p,x:+m[1],y:+m[2],expectedX:r.x+r.width/2,expectedY:r.y+r.height/2}})""")
  assert all(abs(t['x']-t['expectedX'])<1 and abs(t['y']-t['expectedY'])<1 for t in targets),targets
  page.screenshot(path=str(OUT/f'{width}x{height}.png'));reports.append({'viewport':[width,height],'mobile':mobile,'states':states,'flyTargets':targets});context.close()
 assert not errors,errors
 report={'scope':'Synthetic browser geometry, no strength games, uploads or training','cases':reports,'pageErrors':errors};(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps({'cases':len(reports),'pageErrors':errors}));browser.close()
