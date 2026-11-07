"""Real standalone Clint Worker, bounded solve/replay and responsive controls; synthetic only."""
from pathlib import Path
import json,sys,time,os
from playwright.sync_api import sync_playwright
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
OUT=ROOT/'web/artifacts/validation/clint-sync-20261107-2006';OUT.mkdir(parents=True,exist_ok=True)
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8775/')+'?test=1'
with sync_playwright() as p:
 b=p.chromium.launch(channel=os.environ.get('BROWSER_CHANNEL','chrome'),headless=True);page=b.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
 errors=[];uploads=[];models=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:models.append(r.url) if '.onnx' in r.url else None)
 def collect(route):uploads.append(route.request.post_data);route.fulfill(status=503,body='isolated test')
 page.route('**/rounds',collect)
 page.goto(URL,wait_until='networkidle');page.locator('#practiceBtn').click();page.locator('#practiceEndgame').click()
 assert page.locator('#endgamePractice').is_visible()
 page.locator('#endLimit').select_option('3');page.locator('#endLevel').select_option('9')
 solves=[]
 for attempt in range(3):
  page.locator('#endNew').click();page.wait_for_function("()=>document.querySelector('#endStatus').textContent.includes('求解完成')||document.querySelector('#endStatus').textContent.includes('未算完')||document.querySelector('#endStatus').textContent.includes('失败')",timeout=16000)
  solves.append(page.locator('#endStatus').inner_text())
  if not page.locator('#endReplay').is_disabled():break
 assert not page.locator('#endReplay').is_disabled(),solves
 assert page.locator('#endHands .end-seat').count()==4
 page.locator('#endNext').click();assert page.locator('#endStep').input_value()=='1'
 page.locator('#endPrev').click();assert page.locator('#endStep').input_value()=='0'
 page.locator('#endReplay').click();page.wait_for_timeout(1000);assert int(page.locator('#endStep').input_value())>=1
 page.locator('#endStep').fill('0');page.locator('#endStep').dispatch_event('input')
 with page.expect_download() as d:page.locator('#endExport').click()
 d.value.save_as(str(OUT/'endgame.json'));record=json.loads((OUT/'endgame.json').read_text())
 assert record['kind']=='clint-open-endgame-practice' and record['assisted'] and record['result']['complete']
 layouts=[]
 for w,h in [(1440,1000),(900,700),(844,390),(390,844)]:
  page.set_viewport_size({'width':w,'height':h});page.wait_for_timeout(100)
  checks=page.evaluate('''()=>{const result=[];for(const e of document.querySelectorAll('#endgamePractice button:not(:disabled),#endgamePractice select')){e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);result.push({id:e.id,visible:r.x>=0&&r.right<=innerWidth+1&&r.y>=0&&r.bottom<=innerHeight+1,clickable:hit===e||e.contains(hit)});}return result;}''')
  assert all(x['visible'] and x['clickable'] for x in checks),(w,h,checks)
  page.locator('#endNew').scroll_into_view_if_needed();page.screenshot(path=str(OUT/f'endgame-{w}.png'))
  layouts.append({'width':w,'height':h,'controls':len(checks),'allHitTests':True})
 page.locator('#endClose').click();assert page.locator('#practiceDialog').is_visible()
 page.locator('#practiceEndgame').click();page.locator('#endSaved').select_option('0');assert not page.locator('#endReplay').is_disabled()
 page.locator('#endLimit').select_option('10');page.locator('#endBudget').select_option('2000');page.locator('#endNew').click()
 page.wait_for_function("()=>document.querySelector('#endStop').disabled",timeout=12000)
 high_card_status=page.locator('#endStatus').inner_text()
 if '求解完成' not in high_card_status:assert page.locator('#endReplay').is_disabled() and page.locator('#endExport').is_disabled()
 page.locator('#endNew').click();page.locator('#endStop').click();assert '已停止' in page.locator('#endStatus').inner_text()
 page.locator('#endClose').click();page.keyboard.press('Escape')
 assert not uploads and not models and not errors,(uploads,models,errors)
 result={'solves':solves,'legalReplayMoves':len(record['result']['line']),'nodes':record['result']['nodes'],'layouts':layouts,'actualWorker':True,'tenCardBoundedResult':high_card_status,'stopAndReturn':True,'localRecordReload':True,'neuralDownloads':len(models),'uploads':len(uploads),'pageErrors':errors}
 (OUT/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False));b.close()
