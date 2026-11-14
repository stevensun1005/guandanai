"""Real Chrome keypad/layout, equal tribute and PeerJS audio/rejoin; synthetic data only."""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').exists())
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8791').rstrip('/') + '/?test=1'
OUT = ROOT / 'web/artifacts/validation/clint-voice-20261114'
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True, args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    errors, uploads, layouts = [], [], []
    def context(width=1440, height=1000):
        c = browser.new_context(viewport={'width': width, 'height': height}, permissions=['microphone'])
        c.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**', lambda r: (uploads.append(r.request.url), r.abort())[1])
        return c
    def page(c):
        v = c.new_page()
        v.on('pageerror', lambda e: errors.append(str(e)))
        v.goto(URL, wait_until='networkidle')
        v.wait_for_function("()=>typeof window.RULES==='object'")
        return v
    for w, h in [(1440,1000),(1024,768),(390,844),(844,390),(320,640)]:
        c=context(w,h);v=page(c)
        v.locator('[data-mode=join]').click()
        expect(v.locator('#joinPad')).to_be_visible()
        assert v.locator('#roomCode').get_attribute('inputmode') == 'none'
        for key in ['1','2','3','4','5','del','0']:v.locator(f'#joinPad [data-k="{key}"]').click()
        assert v.locator('#roomCode').input_value() == '1230'
        assert v.evaluate("document.querySelector('#joinRow').compareDocumentPosition(document.querySelector('#rulesBox')) & Node.DOCUMENT_POSITION_FOLLOWING")
        assert v.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), (w,h,v.evaluate('document.documentElement.scrollWidth'))
        v.screenshot(path=str(OUT/f'keypad-{w}x{h}.png'),full_page=True)
        v.locator('[data-mode=solo]').click();expect(v.locator('#joinPad')).to_be_hidden()
        v.evaluate("""()=>{hideOverlay();document.querySelector('#lobby').hidden=true;resetGame();G.hands=Array.from({length:4},(_,p)=>makeDeck().slice(p*27,p*27+27));Object.assign(G,{phase:'play',turn:0,L:2,paused:true,fixed:[],myOrder:[],gives:[],trib:[],seen:[],log:[],pw:[],clock:null});render()}""")
        v.wait_for_timeout(300)
        geometry=v.evaluate("""()=>Object.fromEntries(['fanBtn','rowsBtn','sortBtn','emoteBtn','clearBtn','passBtn'].map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,height:r.height,visible:!!e.offsetHeight&&!e.hidden}]}))""")
        for id,g in geometry.items():
            if g['visible']:
                assert g['x']>=-1 and g['x']+g['width']<=w+1,(w,h,id,g)
                if h>=700:assert g['y']>=-1 and g['y']+g['height']<=h+1,(w,h,id,g)
        if w>=561 and h>=700:
            assert abs(geometry['fanBtn']['width']-40)<1,geometry
            assert abs(geometry['fanBtn']['x']+20-(geometry['clearBtn']['x']+geometry['clearBtn']['width']/2))<2
        v.screenshot(path=str(OUT/f'table-{w}x{h}.png'),full_page=True)
        layouts.append({'width':w,'height':h,'controls':geometry})
        # All four rotations of equal double tribute: physical mapping and leader must be invariant.
        if w==1440:
            for first in range(4):
                v.evaluate("""first=>{G.tok++;resetGame();const deck=makeDeck();G.hands=Array.from({length:4},()=>[]);const givers=[(first+1)%4,(first+3)%4],cards=deck.filter(c=>c.r===14).slice(0,2),used=new Set(cards.map(c=>c.id));givers.forEach((g,i)=>G.hands[g].push(cards[i]));let seat=0;for(const c of deck.filter(c=>!used.has(c.id))){while(G.hands[seat].length===27)seat=(seat+1)%4;G.hands[seat].push(c)};Object.assign(G,{phase:'tribPick',L:2,paused:true,prevOut:[first,(first+2)%4,...givers],tribGivers:givers,tribPick:Object.fromEntries(givers.map((g,i)=>[g,cards[i].id])),retPick:{},fixed:[],myOrder:[],gives:[],trib:[],seen:[],log:[],pw:[],clock:null});NET.humans=new Set([0,1,2,3]);tribWait();} """,first)
                assert v.evaluate('G.leader')==(first+1)%4
                assert sorted(v.evaluate('G.returns.map(x=>[x.to,x.from])'))==sorted([[g,(g+3)%4] for g in [(first+1)%4,(first+3)%4]])
                v.wait_for_timeout(1900)
                assert v.evaluate('new Set(G.hands.flat().map(c=>c.id)).size')==108
            for phase in ['tribPick','return']:
                v.evaluate("phase=>{G.phase=phase;render()}",phase)
                expect(v.locator('#sfBtn')).to_be_visible()
        c.close()
    hc,gc=context(),context();host,guest=page(hc),page(gc)
    host.locator('#nick').fill('vhost');host.locator('[data-mode=host]').click()
    host.wait_for_function('()=>NET.peerOpen',timeout=40000)
    code=host.evaluate('NET.code');host.locator('[data-seat=S]').click()
    guest.locator('#nick').fill('vguest');guest.locator('[data-mode=join]').click()
    guest.locator('#roomCode').fill(code);guest.locator('#joinPad [data-k=go]').click()
    guest.wait_for_function('()=>NET.hostConn?.open',timeout=40000)
    expect(guest.locator('#joinPad')).to_be_hidden()
    guest.locator('[data-seat=E]').click();host.wait_for_function("()=>NET.lobby.E==='vguest'")
    host.locator('#sitBtn').click()
    host.wait_for_function('()=>VC.info().active');guest.wait_for_function('()=>VC.info().active')
    host.evaluate("""()=>{G.tok++;resetGame();G.round=1;G.hands=Array.from({length:4},(_,p)=>makeDeck().slice(p*27,p*27+27));Object.assign(G,{phase:'play',turn:0,L:2,paused:true,pausedBy:0,fixed:[],myOrder:[],gives:[],trib:[],seen:[],log:[],pw:[],clock:null});setHumans([0,1],NET.names);render();saveHost()}""")
    for v in [host,guest]:v.evaluate('()=>hideOverlay()')
    host.locator('#micBtn').click();guest.locator('#micBtn').click()
    host.wait_for_function('()=>NET.mics[1]===true')
    for v in [host,guest]:
        v.wait_for_function("()=>document.querySelectorAll('audio').length===1 && [...document.querySelectorAll('audio')].every(a=>a.srcObject?.getAudioTracks().length===1)",timeout=30000)
        expect(v.locator('#myVc')).to_have_class(re.compile(r'vc show on( talk)?'))
    old_peer=guest.evaluate('NET.peer.id')
    guest.reload(wait_until='networkidle')
    guest.wait_for_function("()=>NET.mode==='guest' && !NET.gone && G.phase==='play'",timeout=40000)
    assert guest.evaluate('NET.peer.id')!=old_peer
    host.wait_for_function('()=>NET.mics[1]!==true',timeout=10000)
    for v in [host,guest]:
        v.wait_for_function("()=>document.querySelectorAll('audio').length===1 && [...document.querySelectorAll('audio')].every(a=>a.srcObject?.getAudioTracks().length===1)",timeout=30000)
    assert guest.evaluate('VC.info().on') is False
    expect(guest.locator('#myVc')).to_have_class('vc show')
    guest.evaluate('()=>hideOverlay()')
    guest.locator('#micBtn').click();host.wait_for_function('()=>NET.mics[1]===true')
    # Rebind the same credential while the old tab is still live and has its mic on.
    saved=guest.evaluate("sessionStorage.getItem('guandan-rejoin-seat')")
    replacement=page(gc)
    replacement.evaluate("saved=>sessionStorage.setItem('guandan-rejoin-seat',saved)",saved)
    replacement.reload(wait_until='networkidle')
    replacement.wait_for_function("()=>NET.mode==='guest' && !NET.gone && G.phase==='play'",timeout=40000)
    host.wait_for_function('()=>NET.mics[1]!==true')
    assert replacement.evaluate('VC.info().on') is False
    replacement.wait_for_function("()=>document.querySelectorAll('audio').length===1 && [...document.querySelectorAll('audio')].every(a=>a.srcObject?.getAudioTracks().length===1)",timeout=30000)
    host.screenshot(path=str(OUT/'voice-after-rejoin.png'),full_page=True)
    assert not errors,errors
    assert not uploads,uploads
    report={'version':host.locator('meta[name=app-version]').get_attribute('content'),'layouts':layouts,'equalDoubleTributeRotations':4,'straightFlushDuringTributeAndReturn':True,'realPeerJSChangedIdReconnected':True,'audioStreamsBeforeAndAfter':True,'staleMicCleared':True,'liveTabCredentialReplacementClearsMic':True,'micRetoggleAfterRefresh':True,'pageErrors':errors,'cloudUploads':len(uploads),'scope':'Synthetic Chrome/WebRTC correctness; fake microphone, no physical audio or network reachability guarantee'}
    (OUT/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=False))
    browser.close()
