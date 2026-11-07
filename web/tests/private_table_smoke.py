"""Real PeerJS host-only tool, ordinary opponents, complete-network rollouts and collection exclusion.
The final completion probe is constructed, not a completed strength match or human game.
"""
from pathlib import Path
import json,sys,time,os
from playwright.sync_api import sync_playwright
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
URL=next((v for v in sys.argv[1:] if v.startswith('http')),'http://127.0.0.1:8765/')
OUT=ROOT/'web/artifacts/validation/private-table';OUT.mkdir(parents=True,exist_ok=True)
ENDPOINT=json.loads((ROOT/'web/src/collection/config.json').read_text())['endpoint']
CHAMPION=json.loads((ROOT/'web/src/ai/model-catalog.json').read_text())['selection']['danMCaiChampions'][0]
PROBE="""const Native=Worker;window.privateProbe={requests:[],replies:[]};window.Worker=class extends Native{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.result)privateProbe.replies.push(e.data.result)})}postMessage(d,...r){privateProbe.requests.push(structuredClone(d));return super.postMessage(d,...r)}};"""
with sync_playwright() as p:
 b=p.chromium.launch(channel=os.environ.get('BROWSER_CHANNEL','chrome'),headless=True)
 hc=b.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce');gc=b.new_context(viewport={'width':390,'height':844},reduced_motion='reduce')
 errors=[];uploads=[]
 hc.add_init_script(PROBE);gc.add_init_script(PROBE)
 def stop_upload(route):
  uploads.append(route.request.post_data);route.fulfill(status=503,body='isolated test')
 hc.route(ENDPOINT,stop_upload)
 host,guest=hc.new_page(),gc.new_page()
 for page in [host,guest]:page.on('pageerror',lambda e:errors.append(str(e)))
 host.goto(URL+'?test=1',wait_until='networkidle');host.locator('#nick').fill('ordinary');host.locator('[data-mode=host]').click()
 host.wait_for_function('()=>NET.peerOpen',timeout=30000)
 assert host.locator('#privateTableBox').is_hidden()
 host.locator('#nick').fill('stezer0');assert host.locator('#privateTableBox').is_visible()
 host.locator('[data-seat=S]').click();host.locator('#privateTableAllowed').check()
 assert host.locator('#coachStartEnabled').is_enabled();host.locator('#coachStartEnabled').check()
 assert not host.locator('#coachRoomAllowed').is_checked()
 host.locator('#botStyleBox summary').click()
 for d in ['E','N','W']:host.locator(f'[data-bot-seat={d}]').select_option('clint-rule')
 code=host.locator('#roomCodeShow').inner_text()
 guest.goto(URL+'?test=1&room='+code,wait_until='networkidle');guest.locator('#nick').fill('stezer0');guest.locator('#joinBtn').click()
 guest.wait_for_function('()=>NET.hostConn?.open',timeout=30000);guest.locator('[data-seat=E]').click()
 host.wait_for_function("()=>NET.lobby.E==='stezer0'")
 assert guest.locator('#privateTableBox').is_hidden()
 assert guest.locator('#coachStartEnabled').is_disabled()
 assert host.evaluate("!Object.keys(RULES).some(k=>/private|oracle/i.test(k))")
 host.locator('#sitBtn').click()
 for _ in range(400):
  if host.evaluate("G.phase==='prep'") and guest.evaluate("G.phase==='prep'"):break
  for page in [host,guest]:
   button=page.locator('#deckBtn')
   if button.is_visible() and button.is_enabled():button.click()
  host.wait_for_timeout(80)
 host.locator('#readyBtn').click();guest.locator('#readyBtn').click()
 host.wait_for_function("()=>G.phase==='play'");host.evaluate('G.paused=true');guest.evaluate('G.paused=true')
 for _ in range(500):
  state=host.evaluate('({turn:G.turn,count:G.log.length})')
  if state['turn']==0:break
  if state['turn']<0:host.wait_for_timeout(80);continue
  event=host.evaluate('async()=>playEvt(G.turn,await TableBot.decide(G.turn))');event['automatic']=True
  host.evaluate('e=>act(e)',event);host.wait_for_function('n=>G.log.length>n',arg=state['count'])
 host.wait_for_function("()=>G.turn===0&&document.querySelectorAll('#coachTop5 .coach-choice').length>0",timeout=60000)
 reply=host.evaluate('privateProbe.replies.filter(r=>r.search?.fullInformation).at(-1)')
 assert reply and reply['modelId']==CHAMPION
 print(json.dumps({'stage':'private-inference','search':reply['search']}),flush=True)
 assert host.evaluate('privateProbe.requests.some(r=>r.type==="coach"&&r.state.oracle?.hands.length===4)')
 assert host.locator('#privateHands').is_visible()
 assert host.locator('#privateHandRows .coach-card').count()==host.evaluate('G.hands.slice(1).reduce((n,h)=>n+h.length,0)')
 for selector in ['#privateTableToggle','#privateHands','#coachToggle','#coachSuggestions']:assert guest.locator(selector).is_hidden()
 before=host.evaluate('privateProbe.requests.length')
 host.evaluate('async()=>{const p=await TableBot.decide(2);if(p&&!p.cards.every(c=>G.hands[2].includes(c)))throw Error("Illegal partner move")}')
 partner=host.evaluate('n=>privateProbe.requests.slice(n)',before);assert any(r['type']=='oracle' for r in partner)
 before=host.evaluate('privateProbe.requests.length');host.evaluate('async()=>await TableBot.decide(3)')
 opponent=host.evaluate('n=>privateProbe.requests.slice(n)',before)
 assert any(r['type']=='rule' for r in opponent)
 assert all(r['type']!='oracle' and 'oracle' not in (r.get('state') or {}) for r in opponent)
 before=host.evaluate('privateProbe.requests.length')
 host.evaluate('''async id=>{const trick=G.trick,model=botModels[3];G.trick=null;botModels[3]=id;try{await TableBot.decide(3)}finally{G.trick=trick;botModels[3]=model}}''',CHAMPION)
 neural=host.evaluate('n=>privateProbe.requests.slice(n)',before)
 assert any(r['type']=='decide' for r in neural)
 assert all(r['type']!='oracle' and 'oracle' not in (r.get('state') or {}) and 'hands' not in (r.get('state') or {}) for r in neural)
 # Rate a legal action outside the bounded private beam, using the same four-ply evaluation.
 omitted=host.evaluate('''()=>{const keys=new Set(privateProbe.replies.filter(r=>r.search?.fullInformation).flatMap(r=>r.actions.map(a=>a.map(id=>id%54).sort((a,b)=>a-b).join(','))));return TableBot.candidates(G.hands[0],G.L,G.trick?.play).map(p=>p?.cards.map(c=>c.id)||[]).find(a=>!keys.has(a.map(id=>id%54).sort((a,b)=>a-b).join(',')))}''')
 if omitted is not None:
  reply_count=host.evaluate('privateProbe.replies.length')
  host.evaluate('a=>{sel=new Set(a);renderHand()}',omitted)
  host.wait_for_function('n=>privateProbe.replies.length>n',arg=reply_count,timeout=60000)
  host.wait_for_function("()=>document.querySelector('#coachPreview').textContent.includes('合理性 ')",timeout=60000)
  assert host.evaluate('privateProbe.requests.some(r=>r.type==="coach"&&r.state.onlyAction!==undefined&&r.state.oracle)')

 layouts=[]
 for w,h in [(1440,1000),(390,844),(844,390)]:
  host.set_viewport_size({'width':w,'height':h});host.wait_for_timeout(300)
  if host.locator('#coachSuggestions').is_hidden():host.locator('#coachTopToggle').click()
  if host.evaluate("getComputedStyle(document.body).overflowY==='auto'"):
   host.evaluate("""()=>{const a=document.querySelector('#coachPanel').getBoundingClientRect(),b=document.querySelector('#coachSuggestions').getBoundingClientRect();document.scrollingElement.scrollBy({top:(a.top+b.bottom)/2-innerHeight/2,behavior:'instant'})}""")
   host.wait_for_timeout(100)
  top=host.locator('#coachSuggestions').bounding_box();assert top and top['x']>=0 and top['y']>=0 and top['x']+top['width']<=w+1 and top['y']+top['height']<=h+1
  host.screenshot(path=str(OUT/f'private-{w}.png'))
  layouts.append({'width':w,'height':h,'topFiveInViewport':True})
 host.set_viewport_size({'width':1440,'height':1000});host.wait_for_timeout(250)
 host.locator('#optBtn').click();host.locator('#privateTableToggle').click();host.locator('#optBtn').click()
 assert host.locator('#privateHands').is_hidden();assert host.locator('#coachSuggestions').is_hidden()
 before=host.evaluate('privateProbe.requests.length');host.evaluate('async()=>await TableBot.decide(2)')
 normal=host.evaluate('n=>privateProbe.requests.slice(n)',before);assert any(r['type']=='rule' for r in normal) and all(r['type']!='oracle' for r in normal)
 # A pending captured record is deliberately given a result to exercise the real enqueue guard.
 host.evaluate("G.result={order:[0,2,1,3]}")
 assert host.evaluate("completedRecord(G,{mode:'host',practice:false})!==null")
 host.evaluate('collectCompleted()');host.wait_for_timeout(500)
 assert not uploads, 'Privileged match reached the upload queue after being switched off'
 assert not errors,errors
 report={'kind':'test','strengthMatches':0,'completedRounds':0,'trainingUpdates':0,'realPeerJS':True,'hostOnlyNicknameGate':True,'guestSameNameDenied':True,'noPrivateRuleFlagBroadcast':True,'privateCoach':{'modelId':reply['modelId'],'search':reply['search']},'partnerUsesOracle':True,'opponentStaysRules':True,'neuralOpponentUsesOnlyPublicObservation':True,'manualOutsideBeamRated':omitted is not None,'offRestoresPartnerRules':True,'privateHandsMatchHeldCounts':True,'constructedCompletionExcluded':True,'uploads':len(uploads),'layouts':layouts,'pageErrors':errors}
 (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps(report,ensure_ascii=True));gc.close();hc.close();b.close()
