"""Actual champion WASM evaluation, local preferences, races and optional real PeerJS rooms."""
from pathlib import Path
import json, os, sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
URL = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://127.0.0.1:8765/')
OUT = ROOT/'web/artifacts/validation/coach'; OUT.mkdir(parents=True, exist_ok=True)
CHAMPION = json.loads((ROOT/'web/src/ai/model-catalog.json').read_text(encoding='utf-8'))['selection']['localChampions'][0]
PROBE = """const Native=Worker; window.coachProbe={requests:[],replies:[],held:[],terminated:0};
window.Worker=class extends Native {
 constructor(...args){super(...args);this.coachIds=new Set();this.addEventListener('message',e=>{
  if(!this.coachIds.has(e.data.id))return;
  if(window.failCoachReply){window.failCoachReply=false;e.stopImmediatePropagation();this.onmessage?.({data:{id:e.data.id,error:'injected test error'}});return;}
  if(e.data.result)window.coachProbe.replies.push(e.data.result);
  if(window.holdCoachReply){e.stopImmediatePropagation();window.coachProbe.held.push(()=>this.onmessage?.({data:e.data}));}
 });}
 postMessage(d,...rest){if(d.type==='coach'){this.coachIds.add(d.id);window.coachProbe.requests.push(structuredClone(d.state));}return super.postMessage(d,...rest);}
 terminate(){if(this.coachIds.size)window.coachProbe.terminated++;return super.terminate();}
};"""

def toggle(page):
    page.locator('#optBtn').click()
    page.locator('#coachToggle').click()
    page.locator('#optBtn').click()

def score_checks(page):
    before = page.evaluate('coachProbe.requests.length')
    toggle(page)
    page.wait_for_function('n=>coachProbe.replies.length>n', arg=0, timeout=60000)
    first = page.evaluate('coachProbe.replies.at(-1)')
    assert first['modelId'] == CHAMPION
    assert page.evaluate('r=>JSON.stringify(r.hand)===JSON.stringify(G.hands[0].map(c=>c.id))', page.evaluate('coachProbe.requests.at(-1)'))
    assert page.evaluate("coachProbe.requests.every(s=>!('hands' in s)&&s.counts.length===4)")
    values = first['values']; high=max(range(len(values)),key=lambda i:values[i]); low=min(range(len(values)),key=lambda i:values[i])
    def pick(ids): page.evaluate('ids=>{sel=new Set(ids);renderHand()}', ids)
    pick(first['actions'][high]); page.wait_for_function("() => document.querySelector('#coachPreview').textContent.includes('合理性 100%')")
    if max(values)-min(values)>=1e-6:
        pick(first['actions'][low]); assert '合理性 0%' in page.locator('#coachPreview').inner_text()
    for ids in first['actions'][:20]:pick(ids)
    assert page.evaluate('coachProbe.requests.length') == before+1, 'selection changes repeated full inference'
    invalid = page.evaluate("""()=>{const h=G.hands[0];for(let i=0;i<h.length;i++)for(let j=i+1;j<h.length;j++)if(!analyze([h[i],h[j]],G.L).length)return [h[i].id,h[j].id];return null}""")
    if invalid:
        pick(invalid); assert '不评分' in page.locator('#coachPreview').inner_text()
    page.locator('#coachClose').click(); assert page.locator('#coachPanel').is_hidden()
    page.evaluate('holdCoachReply=true'); toggle(page)
    page.wait_for_function('() => coachProbe.held.length>0',timeout=60000)
    page.locator('#coachClose').click()
    page.evaluate('()=>{holdCoachReply=false;coachProbe.held.splice(0).forEach(f=>f())}')
    assert page.locator('#coachPanel').is_hidden(), 'disabled coach accepted stale result'
    page.evaluate('failCoachReply=true'); toggle(page)
    pick(first['actions'][high])
    page.wait_for_function("() => document.querySelector('#coachPreview').textContent.includes('暂不可用')",timeout=60000)
    assert '%' not in page.locator('#coachPreview').inner_text()
    page.locator('#coachRetry').click()
    page.wait_for_function("() => document.querySelector('#coachPreview').textContent.includes('合理性 100%')",timeout=60000)
    assert page.evaluate('coachAssisted()') is True
    assert page.evaluate('coachProbe.terminated') >= 2
    return {'modelId':first['modelId'],'candidates':len(values),'minValue':min(values),'maxValue':max(values),'relativeExtremaChecked':True,'selectionUsesCachedValues':True,'invalidSelectionNotRated':True,'disabledStaleReplyIgnored':True,'injectedFailureNotScored':True,'retrySucceeded':True}, first['actions'][high]

def layouts(page):
    result=[]
    for w,h in [(1440,1000),(390,844),(844,390)]:
        page.set_viewport_size({'width':w,'height':h});page.wait_for_timeout(250)
        box=page.locator('#coachPanel').bounding_box();assert box and box['x']>=0 and box['y']>=0 and box['x']+box['width']<=w+1 and box['y']+box['height']<=h
        overlaps=page.evaluate("""()=>{const a=document.querySelector('#coachPanel').getBoundingClientRect();return [...document.querySelectorAll('#btns .btn')].some(e=>{const b=e.getBoundingClientRect();return b.width&&b.height&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1})}""")
        assert not overlaps, 'evaluation panel overlaps play controls'
        page.screenshot(path=str(OUT/f'coach-{w}.png'))
        result.append({'width':w,'height':h,'panelInViewport':True,'actionButtonsOverlap':False,'bounds':box})
    page.set_viewport_size({'width':1280,'height':850})
    return result

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel=os.environ.get('BROWSER_CHANNEL','chrome'))
    errors=[];report={'kind':'test','strengthMatches':0,'trainingUpdates':0}
    def context():
        c=browser.new_context(viewport={'width':1280,'height':850},reduced_motion='reduce');c.add_init_script(PROBE)
        c.on('page',lambda page:page.on('pageerror',lambda e:errors.append(str(e))))
        return c
    if '--solo-only' in sys.argv:
        c=context();page=c.new_page();page.goto(URL+'?test=1',wait_until='networkidle')
        page.locator('#nick').fill('Coach');page.locator('[data-seat=S]').click();page.locator('#sitBtn').click()
        page.evaluate("""()=>{G.tok++;const deck=makeDeck();G.hands=[0,1,2,3].map(p=>deck.slice(p*27,p*27+27));Object.assign(G,{phase:'play',turn:0,trick:null,log:[],out:[],seen:[],paused:true,clock:null,myOrder:[],fixed:[],fresh:[]});render()}""")
        report['scoring'],ids=score_checks(page)
        if ids:page.evaluate('onPlay()')
        else:page.evaluate('onPass()')
        page.wait_for_function("() => document.querySelector('#coachLast').textContent.includes('合理性 100%')")
        report['postMoveRetained']=True;report['layouts']=layouts(page);c.close()
    else:
        def room(allow):
            hc,gc=context(),context()
            if not allow:
                for c in [hc,gc]:c.add_init_script("try{localStorage.setItem('guandan-coach-v1','true')}catch{}")
            host,guest=hc.new_page(),gc.new_page()
            host.goto(URL+'?test=1',wait_until='networkidle');host.locator('#nick').fill('CoachH');host.locator('[data-mode=host]').click()
            host.wait_for_function('() => NET.peerOpen',timeout=30000);host.locator('[data-seat=W]').click()
            host.locator('#botStyleBox summary').click()
            for direction in ['S','E','N']:host.locator(f'[data-bot-seat={direction}]').select_option('clint-rule')
            code=host.locator('#roomCodeShow').inner_text()
            guest.goto(URL+'?test=1&room='+code,wait_until='networkidle');guest.locator('#nick').fill('CoachG');guest.locator('#joinBtn').click()
            guest.wait_for_function('() => NET.hostConn?.open',timeout=30000);guest.locator('[data-seat=S]').click()
            host.wait_for_function("() => NET.lobby.S==='CoachG'")
            assert guest.locator('#coachRoomAllowed').is_disabled()
            assert not host.locator('#coachRoomAllowed').is_checked()
            guest.evaluate("NET.hostConn.send({t:'rules',rules:{coachAllowed:true}})");host.wait_for_timeout(150)
            assert host.evaluate('RULES.coachAllowed') is False
            host.locator('#coachRoomAllowed').check();guest.wait_for_function('() => RULES.coachAllowed===true')
            host.locator('#coachRoomAllowed').uncheck();guest.wait_for_function('() => RULES.coachAllowed===false')
            if allow:host.locator('#coachRoomAllowed').check();guest.wait_for_function('() => RULES.coachAllowed===true')
            host.locator('#sitBtn').click();host.evaluate("botModels=Array(4).fill('clint-rule')")
            for _ in range(350):
                if host.evaluate("G.phase==='prep'") and guest.evaluate("G.phase==='prep'"):break
                for page in [host,guest]:
                    b=page.locator('#deckBtn')
                    if b.is_visible() and b.is_enabled():b.click()
                host.wait_for_timeout(80)
            host.locator('#readyBtn').click();guest.locator('#readyBtn').click()
            host.wait_for_function("() => G.phase==='play'");host.evaluate('G.paused=true')
            guest.wait_for_function("() => G.phase==='play'");guest.evaluate('G.paused=true')
            return hc,gc,host,guest
        hc,gc,host,guest=room(False)
        for page in [host,guest]:
            assert page.locator('#coachToggle').is_hidden();page.evaluate("document.querySelector('#coachToggle').click()")
            assert page.evaluate('coachProbe.requests.length')==0
        report['hostDeniedEnforced']=True;gc.close();hc.close()
        hc,gc,host,guest=room(True)
        target=guest.evaluate('NET.off')
        for _ in range(500):
            state=host.evaluate('({turn:G.turn,count:G.log.length})')
            if state['turn']==target:break
            if state['turn']<0:host.wait_for_timeout(100);continue
            event=host.evaluate('async()=>playEvt(G.turn,await TableBot.decide(G.turn))')
            event['automatic']=True;host.evaluate('e=>act(e)',event)
            host.wait_for_function('n=>G.log.length>n',arg=state['count'])
        guest.wait_for_function('() => G.turn===0')
        report['scoring'],ids=score_checks(guest)
        assert host.evaluate('coachProbe.requests.length')==0
        guest.evaluate("()=>{const send=NET.hostConn.send.bind(NET.hostConn);NET.hostConn.send=d=>{if(d.t==='act'&&['play','pass'].includes(d.e.k))window.sentAssisted=d.e.assisted;return send(d)}}")
        old=host.evaluate('G.log.length')
        if ids:guest.evaluate('onPlay()')
        else:guest.evaluate('onPass()')
        host.wait_for_function('n=>G.log.length>n',arg=old)
        guest.wait_for_function("() => document.querySelector('#coachLast').textContent.includes('合理性 100%')")
        assert guest.evaluate('sentAssisted') is True
        report.update({'postMoveRetained':True,'independentPlayerPreferences':True,'assistedEventMarked':True,'realPeerJSDataChannel':True,'hostWGuestS':True,'layouts':layouts(guest)})
        guest.reload(wait_until='networkidle');guest.wait_for_function("() => NET.mode==='guest'&&RULES.coachAllowed===true&&G.phase==='play'",timeout=30000)
        assert guest.locator('#coachToggle').get_attribute('aria-pressed')=='true'
        assert guest.locator('#coachPanel').is_visible()
        report['rejoinRestoresPermissionAndPreference']=True;gc.close();hc.close()
    assert not errors,errors
    report['pageErrors']=errors
    (OUT/('solo.json' if '--solo-only' in sys.argv else 'rooms.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False));browser.close()
