"""Real PeerJS public spectators: no private state, no player actions, voice control and new rounds."""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

ROOT = next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
OUT = ROOT/'web/artifacts/validation/spectators'
OUT.mkdir(parents=True, exist_ok=True)
URL = (sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/')+'?test=1'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome', args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    contexts = [browser.new_context(viewport={'width':1440,'height':1000}, permissions=['microphone']) for _ in range(3)]
    host,guest,watcher = [ctx.new_page() for ctx in contexts]
    errors,models = [],[]
    for page in [host,guest,watcher]:
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto(URL, wait_until='networkidle')
    watcher.on('request',lambda request:models.append(request.url) if '.onnx' in request.url else None)
    host.locator('#nick').fill('房主')
    host.locator('[data-mode="host"]').click()
    host.wait_for_function('()=>NET.peerOpen')
    code=host.evaluate('NET.code')
    host.locator('[data-seat="S"]').click()
    host.locator('#botStyleBox summary').click()
    for seat in ['E','N','W']:
        host.locator(f'[data-bot-seat="{seat}"]').select_option('clint-rule')
    guest.locator('#nick').fill('牌友')
    guest.locator('[data-mode="join"]').click()
    guest.locator('#roomCode').fill(code)
    guest.locator('#joinBtn').click()
    guest.locator('[data-seat="N"]').wait_for(state='visible')
    guest.wait_for_function("()=>NET.hostConn?.open && document.querySelector('[data-seat=N]').disabled===false")
    guest.locator('[data-seat="N"]').click()
    host.wait_for_function('()=>NET.lobby.N===\'牌友\'')
    host.locator('#sitBtn').click()
    for _ in range(250):
        if host.evaluate("G?.phase==='prep'"):
            break
        for page in [host,guest]:
            deck=page.locator('#deckBtn')
            if deck.is_visible() and deck.is_enabled():
                deck.click()
        host.wait_for_timeout(100)
    assert host.evaluate("G.phase==='prep'")
    host.evaluate("""()=>{
      G.clock=null;window.watchPackets=[];
      NET.peer.on('connection',conn=>{const send=conn.send.bind(conn);conn.send=d=>{watchPackets.push({peer:conn.peer,...structuredClone(d)});send(d)}});
    }""")
    watcher.locator('#nick').fill('旁观者')
    watcher.locator('#spectatorBtn').click()
    watcher.locator('#spectatorCode').fill(code)
    watcher.locator('#spectatorGo').click()
    watcher.locator('#spectatorView').wait_for(state='visible',timeout=30000)
    watcher.wait_for_function("()=>document.querySelectorAll('#spectatorSeats section').length===4")
    assert watcher.evaluate('NET.mode')=='spectator'
    assert watcher.evaluate('isHost()') is False
    assert host.evaluate('NET.humans.size')==2
    assert host.evaluate('NET.conns.size')==1
    assert host.evaluate('NET.spectators.size')==1
    assert watcher.locator('[data-watch-seat="0"] strong').inner_text()=='1号 房主'
    assert watcher.locator('[data-watch-seat="2"] strong').inner_text()=='3号 牌友'
    assert watcher.locator('[data-watch-seat="0"] strong').evaluate('(el)=>getComputedStyle(el).color')=='rgb(0, 0, 0)'
    guest.reload(wait_until='networkidle')
    guest.wait_for_function("()=>NET.mode==='guest' && G.phase==='prep' && !NET.gone",timeout=30000)
    watcher.wait_for_function("()=>document.querySelector('[data-watch-seat=\"2\"] strong').textContent==='3号 牌友'")
    watcher.wait_for_function("()=>document.querySelectorAll('audio').length>=2",timeout=20000)
    watcher.evaluate("""()=>new Promise(resolve=>{
      const peer=window.probePeer=new Peer();window.probePackets=[];
      peer.on('open',()=>{const conn=window.probeConn=peer.connect('guandanai-room-'+NET.lastCode,{reliable:true});
        conn.on('data',d=>probePackets.push(d));conn.on('open',()=>resolve());});
    })""")
    host.evaluate("broadcast({t:'unseated-role-probe',payload:'not-for-unseated-peers'})")
    watcher.wait_for_timeout(200)
    assert watcher.evaluate("!probePackets.some(d=>d.t==='unseated-role-probe')")
    watcher.evaluate("probeConn.send({t:'watch',name:'version-test',ver:'incompatible-version'})")
    watcher.wait_for_function("()=>probePackets.some(d=>d.t==='watch-error')")
    watcher.evaluate('probePeer.destroy()')
    before=host.evaluate('JSON.stringify({hands:G.hands.map(h=>h.map(c=>c.id)),log:G.log,humans:[...NET.humans]})')
    watcher.evaluate("""()=>{
      NET.hostConn.send({t:'act',e:{k:'begin'}});
      NET.hostConn.send({t:'act',e:{k:'play',p:0,ids:[0]}});
      NET.hostConn.send({t:'sit',dir:'E',name:'intruder'});
      NET.hostConn.send({t:'hello',token:'intruder',ver:document.querySelector('meta[name=app-version]').content});
      NET.hostConn.send({t:'sync',ver:document.querySelector('meta[name=app-version]').content});
      act({k:'begin'});
    }""")
    token=guest.evaluate("JSON.parse(sessionStorage.getItem('guandan-rejoin-seat')).token")
    watcher.evaluate("token=>NET.hostConn.send({t:'hello',token,ver:document.querySelector('meta[name=app-version]').content})",token)
    watcher.wait_for_timeout(350)
    assert host.evaluate('JSON.stringify({hands:G.hands.map(h=>h.map(c=>c.id)),log:G.log,humans:[...NET.humans]})')==before
    watcher.locator('#spectatorMic').click()
    watcher.wait_for_function("()=>document.querySelector('#spectatorMic').getAttribute('aria-pressed')==='true'")
    host.locator('#optBtn').click()
    assert host.locator('#roomOptNum').inner_text()==code
    host.locator('#spectatorVoices button').click()
    watcher.wait_for_function("()=>document.querySelector('#spectatorMic').disabled")
    assert watcher.locator('#spectatorMic').inner_text()=='语音已关闭'
    assert host.evaluate('Object.values(NET.mics).filter(Boolean).length')==0
    host.locator('#spectatorVoices button').click()
    watcher.wait_for_function("()=>!document.querySelector('#spectatorMic').disabled")
    assert watcher.locator('#spectatorMic').get_attribute('aria-pressed')=='false'
    host.evaluate("""()=>{
      const d=makeDeck();G.round=2;G.L=9;G.levels=[9,8];G.hands=[d.slice(0,27),d.slice(27,54),d.slice(54,81),d.slice(81)];
      const c=G.hands[0].pop();G.last=[{play:{cards:[c],type:'single',value:c.r}},'pass',null,null];
      G.log=[{p:0,cards:[c],lead:true},{p:1,cards:null}];G.turn=-1;G.phase='prep';G.clock=null;
    }""")
    watcher.wait_for_function("()=>document.querySelector('#spectatorStatus').textContent.includes('第 2 局')")
    assert '剩 26 张' in watcher.locator('[data-watch-seat="0"]').inner_text()
    assert watcher.locator('#spectatorSeats .card').count()==1
    assert watcher.locator('#spectatorLog li').count()==2
    assert watcher.locator('.watch-pass').first.evaluate('(el)=>getComputedStyle(el).borderTopWidth')=='0px'
    packets=host.evaluate('peer=>watchPackets.filter(row=>row.peer===peer)',watcher.evaluate('NET.peer.id'))
    assert not any(row['t'] in ['evt','resume','start'] for row in packets)
    tables=[row['table'] for row in packets if row['t']=='public-table']
    assert tables and not any(key in json.dumps(tables) for key in ['"hands"','"deck"','"seed"','"coach"','"assisted"'])
    assert not models,models
    for width,height in [(1440,1000),(1024,768),(390,844)]:
        watcher.set_viewport_size({'width':width,'height':height})
        watcher.wait_for_timeout(150)
        assert not watcher.evaluate('document.documentElement.scrollWidth>innerWidth')
        watcher.screenshot(path=str(OUT/f'watch-{width}.png'),full_page=True)
    host.evaluate('leaveNet()')
    watcher.wait_for_function("()=>document.querySelector('#spectatorStatus').textContent.includes('观战') && document.querySelector('#spectatorStatus').classList.contains('ended')")
    assert not errors,errors
    report={'roomCodeShown':True,'twoHumansRemainTwo':True,'spectatorCannotActSitRecoverOrSync':True,'unseatedReceivesNoGameBroadcast':True,'incompatibleVersionRejected':True,'spectatorNeuralDownloads':len(models),'publicSnapshotsOnly':True,'guestRecoveryWhileWatching':True,'twoPlayerAudioLines':True,'hostVoiceLockAndUnlock':True,'nextRoundFreshState':True,'nicknamesAndBlackNames':True,'viewports':[1440,1024,390],'hostExitEndsSpectating':True,'pageErrors':errors,'purpose':'Browser interaction/security regression, no strength evaluation or real human training data'}
    (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
    print(json.dumps(report))
    browser.close()
