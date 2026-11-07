"""Synthetic continuity UI check; no cloud account or ingestion credential is accessed."""
import json,sys,os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file());OUT=ROOT/'web/artifacts/validation/clint-sync-20261107-2006';OUT.mkdir(parents=True,exist_ok=True)
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/')+'?test=1'
with sync_playwright() as p:
 b=p.chromium.launch(channel=os.environ.get('BROWSER_CHANNEL','chrome'),headless=True);page=b.new_page(viewport={'width':390,'height':844});errors=[];uploads=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 def block(route):uploads.append(route.request.post_data);route.fulfill(status=503,body='isolated test')
 page.route('**/rounds',block)
 page.add_init_script('''const state={levels:{SN:14,EW:8},playSide:'EW',order:['S','N','E','W'],aFails:{SN:1,EW:0},aOut:'SN'};localStorage.setItem('guandan-match-continuity-v1',JSON.stringify({id:crypto.randomUUID(),players:Array.from({length:4},()=>crypto.randomUUID()),nextRound:8,state,rules:{trib:true,aFail:'once'},excluded:true,savedAt:Date.now()}));''')
 page.goto(URL,wait_until='networkidle');page.locator('#continueMatch').wait_for(state='visible');page.locator('#continueMatch').click()
 assert page.evaluate("RULES.startState.levels.SN===14&&RULES.startState.playSide==='EW'&&RULES.startState.aOut==='SN'")
 page.locator('#nick').fill('继续测试');page.locator('[data-seat=E]').click();page.locator('#botStyleBox summary').click()
 for seat in ['S','N','W']:page.locator(f'[data-bot-seat={seat}]').select_option('clint-rule')
 page.locator('#sitBtn').click();page.wait_for_function('()=>G&&G.round===1')
 assert page.evaluate('G.levels[0]===8&&G.levels[1]===14&&G.aOut===1&&G.aFails[1]===1')
 assert page.evaluate('JSON.stringify(G.prevOut)')=='[3,1,0,2]'
 assert not uploads and not errors
 result={'restoredRule':'once','rotatedSeat':'E','levels':[8,14],'aOut':1,'previousOrder':[3,1,0,2],'roundIdentityAndPrivateExclusion':'covered by executable Node restart/collection tests','uploads':len(uploads),'pageErrors':errors}
 (OUT/'continuity-ui.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result));b.close()
