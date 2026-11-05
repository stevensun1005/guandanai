"""Actual Clint turns without neural downloads, then all five selectable WASM models."""
from pathlib import Path
import json, sys
from playwright.sync_api import sync_playwright

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
OUT=ROOT/'web/artifacts/validation/clint-bot'
OUT.mkdir(parents=True,exist_ok=True)
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/')+'?test=1'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors,downloads=[],[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.on('request',lambda r:downloads.append(r.url) if '.onnx' in r.url else None)
    page.add_init_script("""const Native=Worker;window.calls=[];window.replies=[];
      window.Worker=class extends Native {constructor(...args){super(...args);this.ids=new Map();this.addEventListener('message',({data})=>{if(this.ids.has(data.id)&&!data.error)window.replies.push(this.ids.get(data.id))})}
      postMessage(d,...args){if(d.type!=='init'){const x={type:d.type,model:d.state?.modelId};window.calls.push(x);this.ids.set(d.id,x)}return super.postMessage(d,...args)}};""")
    page.goto(URL,wait_until='networkidle')
    page.locator('#nick').fill('规则测试')
    page.locator('[data-seat=S]').click()
    page.locator('#botStyleBox summary').click()
    for seat in ['E','N','W']:page.locator(f'[data-bot-seat={seat}]').select_option('clint-rule')
    page.screenshot(path=str(OUT/'menu.png'))
    page.locator('#sitBtn').click()
    for _ in range(250):
        if page.locator('#readyBtn').is_visible():break
        button=page.locator('#deckBtn')
        if button.is_visible() and button.is_enabled():button.click()
        page.wait_for_timeout(80)
    page.locator('#readyBtn').click()
    for _ in range(400):
        if page.evaluate('G.log.length>=8'):break
        if page.evaluate("G.phase==='play'&&G.turn===0"):
            page.locator('#hintBtn').click()
            if page.locator('#playBtn').is_enabled():page.locator('#playBtn').click()
            elif page.locator('#passBtn').is_enabled():page.locator('#passBtn').click()
        page.wait_for_timeout(80)
    assert page.evaluate('G.log.length>=8')
    rule_turns=page.evaluate("replies.filter(x=>x.type==='rule').length")
    assert rule_turns>=3
    assert not page.evaluate("calls.some(x=>x.type==='decide')")
    assert not downloads,downloads
    page.screenshot(path=str(OUT/'rules-table.png'))
    # Real controller + Worker + five actual ONNX files on a controlled, conserved deal.
    # These are compatibility decisions, not strength matches.
    for model in ['001','007','008','009','010']:
        result=page.evaluate("""async id=>{
          TableBot.cancelTurn();resetGame();const d=makeDeck();G.hands=[[],[],[],[]];d.forEach((c,i)=>G.hands[i%4].push(c));
          G.phase='prep';G.turn=1;G.round=1;G.log=[];G.seen=[];G.rest=[];G.fixed=[];G.trib=[];G.returns=[];G.myOrder=[];
          G.clock=null;botModels=['009',id,'009','009'];
          const play=await TableBot.decide(1);return {valid:!!play&&play.cards.every(c=>G.hands[1].includes(c)),type:play?.type};
        }""",model)
        assert result['valid'],(model,result)
    neural=page.evaluate("replies.filter(x=>x.type==='decide').map(x=>x.model)")
    assert sorted(neural)==['001','007','008','009','010'],neural
    assert not errors,errors
    report={'actualRuleReplies':rule_turns,'allRuleGameNeuralDownloads':0,'wasmModels':neural,'fixtureScope':'Eight real opening actions; five controlled compatibility decisions, no strength estimates','pageErrors':errors}
    (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))
    browser.close()
