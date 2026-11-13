"""Real PeerJS random seating, credential rebinding and host/guest restoration; no cloud data."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').exists())
URL = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8789/').rstrip('/') + '/?test=1'
OUT = ROOT / 'web/artifacts/validation/clint-seats-20261113'
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    errors, layouts, contexts = [], [], []
    def context(width=1280, height=850):
        c = browser.new_context(viewport={'width': width, 'height': height})
        c.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**', lambda route: route.abort())
        contexts.append(c)
        return c
    def page(c):
        v = c.new_page()
        v.on('pageerror', lambda e: errors.append(str(e)))
        v.goto(URL, wait_until='networkidle')
        v.wait_for_function("()=>typeof window.RULES==='object'",timeout=30000)
        return v
    for width, height in [(1440,1000),(1024,768),(390,844),(844,390),(320,640)]:
        c = context(width,height)
        c.add_init_script("localStorage.setItem('guandan-rules',JSON.stringify({seatMode:'invalid'}))")
        v = page(c)
        assert v.evaluate("RULES.seatMode==='pick'")
        v.locator('[data-rule=seatMode][data-val=random]').click()
        assert v.locator('.seat-btn').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
        assert '随机' in v.locator('#rulesNote').inner_text()
        # Remove the one-shot init script by testing persistence in a fresh page without overrides.
        assert v.evaluate("JSON.parse(localStorage.getItem('guandan-rules')).seatMode==='random'")
        assert v.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
        v.screenshot(path=str(OUT/f'lobby-{width}x{height}.png'),full_page=True)
        v.locator('[data-mode=join]').click()
        assert v.locator('[data-rule=seatMode]').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
        v.locator('[data-mode=solo]').click()
        v.locator('[data-rule=seatMode][data-val=pick]').click()
        assert v.locator('.seat-btn').evaluate_all('(xs)=>xs.every(x=>!x.disabled)')
        layouts.append([width,height])
        c.close()
    solo_context=context()
    solo=page(solo_context)
    solo.locator('[data-rule=seatMode][data-val=random]').click()
    solo.reload(wait_until='networkidle')
    solo.wait_for_function("()=>typeof window.RULES==='object'",timeout=30000)
    assert solo.evaluate("RULES.seatMode==='random'")
    solo.locator('#nick').fill('soloseat')
    solo.locator('details.bot-setup').evaluate('(element)=>element.open=true')
    assert solo.locator('[data-bot-seat]').evaluate_all('(xs)=>xs.every(x=>!x.disabled)')
    solo.locator('[data-bot-seat=S]').select_option('clint-rule')
    expect(solo.locator('#sitBtn')).to_be_enabled()
    solo.evaluate("()=>{const r=Math.random;Math.random=()=>.5;document.querySelector('#sitBtn').click();Math.random=r}")
    assert solo.evaluate("myDir==='N' && NET.mode==='solo'")
    assert solo.evaluate("botModels[2]==='clint-rule' && botModels[1]==='029' && botModels[3]==='029'")
    solo_context.close()
    hc=context(); host=page(hc)
    host.locator('#nick').fill('hostseat')
    host.locator('[data-rule=seatMode][data-val=random]').click()
    host.locator('[data-mode=host]').click()
    host.wait_for_function("()=>NET.peerOpen && myDir==='S'",timeout=30000)
    host.locator('#coachRoomAllowed').check()
    assert host.locator('[data-bot-seat]').evaluate_all('(xs)=>xs.every(x=>!x.disabled)')
    code=host.evaluate('NET.code')
    guests=[]
    for i,direction in enumerate(['E','N','W']):
        c=context(); v=page(c)
        v.locator('#nick').fill('guest'+str(i))
        v.locator('[data-mode=join]').click()
        v.locator('#roomCode').fill(code)
        v.locator('#joinBtn').click()
        v.wait_for_function('(d)=>myDir===d',arg=direction,timeout=30000)
        expect(v.locator('#coachRoomAllowed')).to_be_disabled()
        expect(v.locator('#coachRoomAllowed')).to_be_checked()
        assert v.locator('.seat-btn').evaluate_all('(xs)=>xs.every(x=>x.disabled)')
        credential=v.evaluate("JSON.parse(sessionStorage.getItem('guandan-rejoin-seat'))")
        guests.append((v,credential))
    guests[0][0].evaluate("()=>NET.hostConn.send({t:'sit',dir:'S',name:'guest0',ver:'old-build'})")
    expect(host.locator('#sitBtn')).to_be_disabled()
    assert guests[0][0].evaluate("myDir==='E'")
    guests[0][0].evaluate("()=>sendSit('S')")
    expect(host.locator('#sitBtn')).to_be_enabled()
    full_context=context(); full=page(full_context)
    full.locator('#nick').fill('waiting')
    full.locator('[data-mode=join]').click()
    full.locator('#roomCode').fill(code)
    full.locator('#joinBtn').click()
    full.wait_for_function("()=>document.querySelector('#lobbyStatus').textContent.includes('坐满')",timeout=30000)
    assert full.evaluate("myDir===''")
    # Draw N,W,E,S, changing both the host's physical direction and the original partnerships.
    host.evaluate("()=>{const r=Math.random,seq=[0,.5,0];Math.random=()=>seq.length?seq.shift():r();document.querySelector('#sitBtn').click();Math.random=r}")
    host.wait_for_function("()=>NET.started && myDir==='N'",timeout=15000)
    assigned=['W','E','S']
    for (v,credential),direction in zip(guests,assigned):
        v.wait_for_function("(d)=>NET.mode==='guest' && myDir===d",arg=direction,timeout=20000)
        saved=v.evaluate("JSON.parse(sessionStorage.getItem('guandan-rejoin-seat'))")
        assert saved['token']==credential['token'] and saved['dir']==direction
    assert host.evaluate('NET.humans.size===4')
    assert full.evaluate("myDir==='' && NET.mode!=='guest'")
    # Synthetic paused complete deck; records are local-only and the cloud endpoint is blocked.
    host.evaluate("""()=>{
      G.tok++;resetGame();G.round=1;G.deck=[];G.hands=Array.from({length:4},(_,p)=>makeDeck().slice(p*27,p*27+27));
      Object.assign(G,{phase:'play',turn:0,L:2,paused:true,pausedBy:0,fixed:[],myOrder:[],reveal:0,gives:[],trib:[],seen:[],log:[],pw:[],clock:{who:0,left:60000,total:60000}});
      setHumans([0,1,2,3],NET.names);collectDealt();collectStarted();render();saveHost();
    }""")
    snapshot="()=>({dir:myDir,host:NET.hostDir,names:NET.names,hands:G.hands.map(h=>h.map(c=>c.id)),record:snapshotRecord(G).pending.id,room:snapshotRecord(G).pending.room,recordNames:snapshotRecord(G).pending.seats.map(s=>s.name),seatMode:RULES.seatMode,coach:RULES.coachAllowed})"
    before=host.evaluate(snapshot)
    assert before['dir']=='N' and before['host']=='N' and before['coach'] is True
    assert before['recordNames']==['hostseat','guest0','guest2','guest1']
    guests[1][0].reload(wait_until='networkidle')
    guests[1][0].wait_for_function("()=>typeof window.NET==='object'",timeout=30000)
    guests[1][0].wait_for_function("()=>NET.mode==='guest' && myDir==='E' && NET.off===3 && G.phase==='play'",timeout=70000)
    host.wait_for_function('()=>NET.humans.size===4',timeout=30000)
    host.evaluate('saveHost()')
    host.reload(wait_until='networkidle')
    host.wait_for_function("()=>typeof window.NET==='object'",timeout=30000)
    host.wait_for_function("()=>NET.started && NET.humans.size===4 && G.phase==='play'",timeout=90000)
    assert host.evaluate(snapshot)==before
    for (v,_),direction in zip(guests,assigned):
        v.wait_for_function("(d)=>NET.mode==='guest' && myDir===d && !NET.gone && G.phase==='play'",arg=direction,timeout=30000)
    # Returning to the lobby is explicit; recovery never draws again.
    assert not errors,errors
    host.evaluate('forgetHost()')
    host.evaluate("()=>setMode('host')")
    host.wait_for_function("()=>NET.peerOpen && !NET.started && myDir==='S'",timeout=30000)
    expect(host.locator('#sitBtn')).to_be_enabled()
    report={'upstream':'f97f0fe9051131f32cc142d1b9079c183ea1776b','viewports':layouts,'savedDefaultAndSoloRandom':True,'fourRealPeersRandomized':True,'hostDirectionChanged':True,'partnershipChanged':True,'opaqueTokensPreservedAndRebound':True,'fullRoomCannotChooseSeat':True,'serverIgnoresRequestedRandomSeat':True,'versionMismatchBlocksStart':True,'freshLobbyResetsStartedFlag':True,'guestAndHostReloadKeepDrawAndCards':True,'hostCoachPermissionPreserved':True,'roomAndHumanNameCollectionMapping':True,'mixedBotPhysicalDirectionsPreserved':True,'default029Unchanged':True,'pageErrors':errors,'strengthGames':0,'cloudUploadsBlocked':True}
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=False))
    browser.close()
