"""Four real PeerJS clients play multiple rounds, including tribute and one host timeout."""
from pathlib import Path
import json,sys,time
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'work/validation/multiround';OUT.mkdir(parents=True,exist_ok=True)
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/'
URL+=('&' if '?' in URL else '?')+'test=1'
TARGET=int(sys.argv[2]) if len(sys.argv)>2 else 3
snapshot="""()=>({round:G.round,phase:G.phase,L:G.L,
 levels:[G.levels[NET.off%2],G.levels[(NET.off+1)%2]],
 hands:Array.from({length:4},(_,seat)=>G.hands[toLocal(seat)].concat((G.rest||[]).filter(rest=>rest.p===toLocal(seat)).flatMap(rest=>rest.cards)).map(card=>card.id).sort((a,b)=>a-b)),
 log:G.log.map(entry=>({p:toAbs(entry.p),cards:entry.cards?.map(card=>card.id).sort((a,b)=>a-b)||null})),
 out:G.out.map(toAbs)})"""
status="""()=>{
 const all=G.hands.flat().map(card=>card.id).concat((G.log||[]).flatMap(entry=>entry.cards?.map(card=>card.id)||[]),(G.rest||[]).flatMap(rest=>rest.cards.map(card=>card.id)));
 return {phase:G.phase,round:G.round,turn:G.turn,log:G.log?.length||0,count:all.length,unique:new Set(all).size};
}"""
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    contexts=[];pages=[];errors=[];reports=[]
    for _ in range(4):
        context=browser.new_context(viewport={'width':1280,'height':850},permissions=['clipboard-read','clipboard-write'])
        contexts.append(context);page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)));pages.append(page)
    host=pages[0];host.goto(URL,wait_until='networkidle');host.locator('#nick').fill('房主')
    host.locator('[data-mode="host"]').click();host.wait_for_function('NET.peerOpen',timeout=30000)
    code=host.locator('#roomCodeShow').inner_text();host.locator('[data-seat="W"]').click()
    for page,direction,name in zip(pages[1:],['S','E','N'],['一号','二号','三号']):
        page.goto(URL+'&room='+code,wait_until='networkidle');page.locator('#nick').fill(name);page.locator('#joinBtn').click()
        page.wait_for_function('NET.hostConn?.open',timeout=30000);page.locator(f'[data-seat="{direction}"]').click()
        host.wait_for_function('NET.lobby.'+direction+'!==null')
    host.locator('#sitBtn').click()
    for page in pages:page.wait_for_function("NET.started||NET.mode==='guest'",timeout=15000)
    assert not host.evaluate('TableBot.ready'),'four human seats should not predownload the model'
    forced=False;timeout_completed=False;rounds=0;started=time.monotonic();last_progress=started
    while rounds<TARGET and time.monotonic()-started<900:
        states=[page.evaluate(status) for page in pages]
        for state in states:
            if state['phase'] not in ['start','shuffle','cut','deal']:
                assert state['count']==108 and state['unique']==108,('card conservation',states)
        if all(state['phase'] in ['roundEnd','over'] for state in states):
            snaps=[page.evaluate(snapshot) for page in pages]
            assert all(snap==snaps[0] for snap in snaps[1:]),('round divergence',snaps)
            rounds+=1;reports.append({'round':snaps[0]['round'],'moves':len(snaps[0]['log']),'levels':snaps[0]['levels'],'allClientsEqual':True})
            print(json.dumps(reports[-1]),flush=True)
            if rounds>=TARGET:break
            for page in pages:
                page.locator('#nextBtn').wait_for(state='visible',timeout=15000)
                if page.locator('#nextBtn').is_enabled():page.locator('#nextBtn').click()
            host.wait_for_function("!['roundEnd','over'].includes(G.phase)",timeout=15000)
            continue
        for page,state in zip(pages,states):
            button=page.locator('#deckBtn')
            if button.is_visible() and button.is_enabled():button.click()
            if state['phase'] in ['prep','return','tribPick']:
                returning=page.locator('#returnBtn')
                if returning.is_visible() and returning.is_enabled():
                    page.evaluate("""()=>{
                      let cards;
                      if(G.phase==='tribPick')cards=tribOptions(0);
                      else {cards=G.hands[0].filter(card=>card.r<=10&&!isWild(card,G.L));
                        if(!cards.length){const pool=G.hands[0].filter(card=>!isWild(card,G.L));const low=Math.min(...pool.map(card=>val(card,G.L)));cards=pool.filter(card=>val(card,G.L)===low);}}
                      if(cards.length){sel=new Set([cards[0].id]);renderHand();}
                    }""")
                    returning.click()
                ready=page.locator('#readyBtn')
                if ready.is_visible() and ready.is_enabled():ready.click()
        if states[0]['phase']=='play' and not forced:
            host.evaluate('if(G.clock)G.clock.left=1');forced=True
        if forced and not timeout_completed:
            timeout_completed=host.evaluate('G.log.length>0')
            if timeout_completed:assert host.evaluate('TableBot.ready')
        if timeout_completed:
            for page in pages:
                if page.evaluate("G.phase==='play'&&G.turn===0"):
                    if page.locator('#hintBtn').is_enabled():page.locator('#hintBtn').click()
                    if page.locator('#playBtn').is_enabled():page.locator('#playBtn').click()
                    elif page.locator('#passBtn').is_enabled():page.locator('#passBtn').click()
        if time.monotonic()-last_progress>30:
            print(json.dumps({'progress':states[0],'elapsed':round(time.monotonic()-started)}),flush=True);last_progress=time.monotonic()
        host.wait_for_timeout(60)
    assert rounds==TARGET,('timeout',reports,[page.evaluate(status) for page in pages])
    assert not errors,errors
    for page in pages[1:]:assert not page.evaluate('TableBot.ready')
    host.screenshot(path=str(OUT/'final-host.png'))
    report={'clients':4,'hostDirection':'W','rounds':reports,'cardConservation':True,'realGuestActions':True,'hostTimeoutUsedLearnedPolicy':timeout_completed,'guestsAvoidModelDownload':True,'pageErrors':errors,'elapsedSeconds':time.monotonic()-started}
    (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report),flush=True)
    browser.close()
