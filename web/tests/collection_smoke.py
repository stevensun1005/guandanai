"""Two real browser peers, a complete synthetic round, durable upload and private export.

--local-build serves the checked build on the real Pages origin before release.
All diagnostic games use ?test=1 and are stored as kind=test, never human training.
"""
from pathlib import Path
import json,sys,time,mimetypes
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
BASE='https://stevensun1005.github.io/guandanai/'
ENDPOINT=json.loads((ROOT/'web/src/collection/config.json').read_text(encoding='utf-8'))['endpoint']
OUT=ROOT/'web/artifacts/validation/collection';OUT.mkdir(parents=True,exist_ok=True)
token_path=Path(sys.argv[sys.argv.index('--token-file')+1]) if '--token-file' in sys.argv else ROOT/'ai/danMCai/workspace/collection/export-token.txt'
TOKEN=token_path.read_text(encoding='utf-8').strip()
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    errors,uploads,responses=[],[],[]
    contexts=[browser.new_context(viewport={'width':1280,'height':850},reduced_motion='reduce') for _ in range(2)]
    if '--local-build' in sys.argv:
        def build_route(route):
            rel=urlparse(route.request.url).path.removeprefix('/guandanai/') or 'index.html'
            file=(ROOT/'web/dist'/rel).resolve()
            if not file.is_relative_to((ROOT/'web/dist').resolve()) or not file.is_file():route.abort();return
            route.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
        for context in contexts:context.route(BASE+'**',build_route)
    host,guest=[context.new_page() for context in contexts]
    for page in [host,guest]:page.on('pageerror',lambda e:errors.append(str(e)))
    def capture_upload(r):
        if r.url==ENDPOINT and r.method=='POST':
            record=json.loads(r.post_data);uploads.append(record)
            (OUT/'synthetic-round.json').write_text(json.dumps(record),encoding='utf-8')
    host.on('request',capture_upload)
    host.on('response',lambda r:responses.append({'status':r.status,'body':r.text()[:200]}) if r.url==ENDPOINT else None)
    host.goto(BASE+'?test=1',wait_until='networkidle')
    host.locator('#nick').fill('CollectH');host.locator('[data-mode=host]').click()
    host.wait_for_function('() => NET.peerOpen',timeout=30000)
    code=host.locator('#roomCodeShow').inner_text();host.locator('[data-seat=S]').click()
    host.locator('#botStyleBox summary').click()
    for seat in ['E','N','W']:host.locator(f'[data-bot-seat={seat}]').select_option('clint-rule')
    guest.goto(BASE+'?test=1&room='+code,wait_until='networkidle')
    guest.locator('#nick').fill('CollectG');guest.locator('#joinBtn').click()
    guest.wait_for_function('() => NET.hostConn?.open',timeout=30000);guest.locator('[data-seat=E]').click()
    host.wait_for_function("() => NET.lobby.E==='CollectG'")
    host.locator('#sitBtn').click()
    host.evaluate("botModels=Array(4).fill('clint-rule')")
    for _ in range(300):
        if host.evaluate("G.phase==='prep'") and guest.evaluate("G.phase==='prep'"):break
        for page in [host,guest]:
            button=page.locator('#deckBtn')
            if button.is_visible() and button.is_enabled():button.click()
        host.wait_for_timeout(80)
    host.locator('#readyBtn').click();guest.locator('#readyBtn').click()
    host.wait_for_function("() => G.phase==='play'");host.evaluate('G.paused=true');guest.evaluate('G.paused=true')
    assert not uploads,'private hands uploaded before round end'
    injected_timeout=False
    for _ in range(2200):
        state=host.evaluate('({phase:G.phase,turn:G.turn,log:G.log.length})')
        if state['phase'] in ['roundEnd','over']:break
        if state['turn']<0:host.wait_for_timeout(50);continue
        action=host.evaluate("""async()=>{const seat=G.turn,play=await TableBot.decide(seat);return playEvt(seat,play)}""")
        if state['turn']==1:guest.evaluate('e=>act(e)',action)
        else:
            if state['turn']==0 and not injected_timeout:action['automatic']=True;injected_timeout=True
            elif state['turn']>=2:action['automatic']=True
            host.evaluate('e=>act(e)',action)
        host.wait_for_function('n=>G.log.length>n',arg=state['log'],timeout=10000)
        if host.evaluate("G.phase==='play'"):assert not uploads
    assert host.evaluate("G.phase==='roundEnd'||G.phase==='over'")
    try:host.wait_for_function("() => document.querySelector('#collectionStatus').textContent==='牌谱已同步'",timeout=40000)
    except Exception:
        print(json.dumps({'uploads':len(uploads),'responses':responses,'status':host.locator('#collectionStatus').inner_text(),'errors':errors}));raise
    assert len(uploads)==1, len(uploads)
    assert host.locator('#collectionStatus').is_visible()
    raw=uploads[0];assert raw['kind']=='test' and raw['humanMask']==3
    assert {a['actor'] for a in raw['actions']}=={'human','bot','timeout'}
    assert len(raw['actions'])==host.evaluate('G.log.length')
    assert 'CollectH' not in json.dumps(raw) and 'CollectG' not in json.dumps(raw)
    headers={'Authorization':'Bearer '+TOKEN}
    admin=ENDPOINT.rsplit('/',1)[0]+'/admin/export?includeTests=1'
    response=host.request.get(admin,headers=headers);assert response.ok
    saved=next(x for x in response.json()['records'] if x['record']['id']==raw['id'])
    assert len(saved['record']['actions'])==len(raw['actions'])
    duplicate=host.request.post(ENDPOINT,data=json.dumps(raw),headers={'Content-Type':'application/json','Origin':'https://stevensun1005.github.io'})
    assert duplicate.status==200 and duplicate.json()['duplicate']
    assert host.request.get(admin).status==401
    assert not errors,errors
    host.screenshot(path=str(OUT/'completed.png'))
    report={'stage':'predeployment-local-build' if '--local-build' in sys.argv else 'deployed-pages','recordId':raw['id'],'kind':'test','humanTrainingGames':0,'actions':len(raw['actions']),'actorCounts':{a:sum(x['actor']==a for x in raw['actions']) for a in ['human','bot','timeout']},'hostUploads':len(uploads),'durableCloudRow':saved['seq'],'duplicateAcknowledged':True,'anonymousReadDenied':True,'preEndUploads':0,'pageErrors':errors}
    (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
    browser.close()
