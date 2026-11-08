"""Actual PeerJS host refresh/closed-tab recovery with synthetic cards; cloud uploads blocked."""
from pathlib import Path
import json,sys
from playwright.sync_api import sync_playwright,expect
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/').rstrip('/')+'/?test=1'
OUT=ROOT/'web/artifacts/validation/host-restore';OUT.mkdir(parents=True,exist_ok=True)
SETUP="""()=>{G.tok++;resetGame();G.round=1;G.deck=[];G.hands=Array.from({length:4},(_,p)=>makeDeck().slice(p*27,p*27+27));Object.assign(G,{phase:'play',turn:0,L:2,paused:true,pausedBy:0,fixed:[],myOrder:[],reveal:0,gives:[],trib:[],seen:[],log:[],pw:[],clock:{who:0,left:60000,total:60000}});setHumans([0,1],NET.names);collectDealt();collectStarted();render();saveHost();}"""
SNAP="()=>({hands:G.hands.map(h=>h.map(c=>c.id)),code:NET.code,record:snapshotRecord(G).pending.id,room:snapshotRecord(G).pending.room,names:snapshotRecord(G).pending.seats.map(s=>s.name)})"
with sync_playwright() as p:
 browser=p.chromium.launch(channel='chrome',headless=True)
 hc,gc=browser.new_context(),browser.new_context();errors=[];uploads=[]
 for context in [hc,gc]:
  def block(route):uploads.append(True);route.fulfill(status=503,body='isolated test')
  context.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**',block)
 def page(context):
  value=context.new_page();value.on('pageerror',lambda e:errors.append(str(e)));return value
 host,guest=page(hc),page(gc)
 for value in [host,guest]:value.goto(URL,wait_until='networkidle')
 host.locator('#nick').fill('hosttest');host.locator('[data-mode="host"]').click();host.wait_for_function('()=>NET.peerOpen',timeout=30000);code=host.evaluate('()=>NET.code')
 guest.locator('#nick').fill('guest');guest.locator('[data-mode="join"]').click();guest.locator('#roomCode').fill(code);guest.locator('#joinBtn').click();guest.locator('[data-seat="E"]').click();guest.wait_for_function('()=>myDir==="E"')
 host.locator('[data-seat="S"]').click();expect(host.locator('#sitBtn')).to_be_enabled();host.locator('#sitBtn').click();guest.wait_for_function('()=>G!==null')
 host.evaluate(SETUP);before=host.evaluate(SNAP);cases=[]
 for action in ['refresh','closed-tab']:
  if action=='refresh':host.reload(wait_until='networkidle')
  else:host.close();host=page(hc);host.goto(URL,wait_until='networkidle')
  host.wait_for_function('()=>NET.started && G?.phase==="play"',timeout=70000)
  host.wait_for_function('()=>NET.humans.has(1)',timeout=30000)
  guest.wait_for_function('()=>NET.hostConn?.open && !NET.gone && G?.phase==="play"',timeout=30000)
  assert host.evaluate(SNAP)==before
  cases.append({'action':action,'sameRoomAndPhysicalHands':True,'anonymousRecordIdentity':True,'opaqueGuestSeatRecovered':True})
 assert not errors,errors
 # Expose a real rating, turn the personal UI off, then refresh. No new preview can supply the flag.
 host.evaluate("()=>{RULES.coachAllowed=true;G.paused=false;hideOverlay();G.turn=0;setCoachEnabled(true);render();}")
 host.wait_for_function('()=>coachAssisted()',timeout=60000)
 host.evaluate('()=>{setCoachEnabled(false);saveHost();}')
 host.reload(wait_until='networkidle');host.wait_for_function('()=>NET.started && G?.phase==="play"',timeout=70000)
 assert host.evaluate('()=>coachAssisted()')
 expect(host.locator('#coachPanel')).to_be_hidden()
 assert not errors,errors
 host.evaluate('()=>forgetHost()');host.reload(wait_until='networkidle');expect(host.locator('#lobby')).to_be_visible();assert host.evaluate('()=>G?.phase==="start" && !NET.started')
 report={'cases':cases,'explicitForgetDoesNotRestore':True,'actualPreviewBeforeRefreshPreservedWithPersonalSwitchNowOff':True,'roomAndHumanNamesRestored':True,'pageErrors':errors,'uploads':len(uploads),'scope':'Synthetic UI/network correctness, no strength games or real human records'}
 (OUT/'report.json').write_bytes((json.dumps(report,indent=2)+'\n').encode());print(json.dumps(report));browser.close()
