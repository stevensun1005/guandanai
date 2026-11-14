"""Desktop/tablet equal-cell lobby and preserved mobile/feature order; no strength games."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').exists())
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8792').rstrip('/')+'/?test=1'
ENGINE=sys.argv[2] if len(sys.argv)>2 else 'chromium'
OUT=ROOT/'web/artifacts/validation/clint-lobby-20261114'/ENGINE
OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=getattr(p,ENGINE).launch(**({'channel':'chrome','headless':True} if ENGINE=='chromium' else {'headless':True}))
    cases=[];errors=[];uploads=[]
    for width,height in [(1440,1000),(1024,768),(768,1024),(820,1180),(601,900),(600,900),(390,844),(844,390),(320,640)]:
        c=browser.new_context(viewport={'width':width,'height':height},has_touch=width in [768,820])
        c.route('**/guandan-human-games-collector.couple-ledger-service.workers.dev/**',lambda r:(uploads.append(r.request.url),r.abort())[1])
        v=c.new_page();v.on('pageerror',lambda e:errors.append(str(e)))
        v.goto(URL,wait_until='networkidle');v.wait_for_function("()=>typeof window.RULES==='object'")
        version=v.locator('meta[name=app-version]').get_attribute('content')
        v.locator('#nick').fill('一二三四五六七八')
        assert v.evaluate("()=>[...document.querySelectorAll('[id]')].every(e=>document.querySelectorAll('[id=\"'+e.id+'\"]').length===1)")
        assert v.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        geometry=v.evaluate("""()=>{const rect=e=>{let r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom,right:r.right}}, left=document.querySelector('.lobby-left'),right=document.querySelector('.lobby-right');return {left:rect(left),right:rect(right),table:rect(document.querySelector('#lobbyTable')),seats:[...document.querySelectorAll('.seat-btn')].map(rect),nick:rect(document.querySelector('.lobby-name')),modes:rect(document.querySelector('.lobby-modes')),rules:rect(document.querySelector('#rulesBox')),go:rect(document.querySelector('#sitBtn'))}}""")
        if width>=601:
            assert v.locator('.lobby-box').bounding_box()['width']>=min(880,width-32)-2
            assert v.locator('.mode-btn').evaluate_all('(xs)=>xs.every(e=>e.scrollWidth<=e.clientWidth+1 && e.getBoundingClientRect().height<=50)')
            assert geometry['left']['right']<=geometry['right']['left'],geometry
            assert abs(geometry['left']['width']/geometry['right']['width']-2/3)<.01
            assert abs(geometry['table']['width']-geometry['table']['height'])<1
            sizes=geometry['seats'];assert max(s['width'] for s in sizes)-min(s['width'] for s in sizes)<1
            assert all(abs(s['width']-s['height'])<1 for s in sizes),sizes
            expect(v.locator('#sitBtn')).to_have_text('开始游戏')
            expect(v.locator('.lobby-ver2')).to_be_visible();expect(v.locator('#verTag')).to_be_hidden()
            assert v.locator('.lobby-ver2').inner_text().endswith(version)
        else:
            assert geometry['nick']['top']<geometry['modes']['top']<geometry['rules']['top']<geometry['table']['top']<geometry['go']['top'],(width,height,geometry)
            expect(v.locator('#sitBtn')).to_have_text('坐下开始')
            expect(v.locator('#verTag')).to_be_visible();expect(v.locator('.lobby-ver2')).to_be_hidden()
        v.locator('details.bot-setup').evaluate('(e)=>e.open=true')
        choices=v.locator('[data-bot-seat=S] option').evaluate_all('(xs)=>xs.map(x=>x.value)')
        assert choices==['clint-rule','028','029'],choices
        assert v.locator('[data-bot-seat=S]').input_value()=='029'
        v.locator('details.bot-setup').evaluate('(e)=>e.open=false')
        expect(v.locator('#coachStartEnabled')).to_be_visible()
        v.locator('#levelBtn').click();expect(v.locator('#levelPick')).to_be_visible()
        v.locator('[data-level-team=SN][data-lv="7"]').click();v.locator('[data-done]').click()
        assert v.evaluate('RULES.startLevel')==7
        v.screenshot(path=str(OUT/f'solo-{width}x{height}.png'),full_page=True)
        v.locator('[data-mode=join]').click();expect(v.locator('#joinPad')).to_be_visible()
        expect(v.locator('#sitBtn')).to_be_hidden()
        for digit in '1234':v.locator(f'#joinPad [data-k="{digit}"]').click()
        assert v.locator('#roomCode').input_value()=='1234'
        assert v.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        v.screenshot(path=str(OUT/f'join-{width}x{height}.png'),full_page=True)
        v.locator('[data-mode=solo]').click()
        v.set_viewport_size({'width':390 if width>=601 else 1024,'height':900})
        expect(v.locator('#sitBtn')).to_have_text('坐下开始' if width>=601 else '开始游戏')
        cases.append({'width':width,'height':height,'geometry':geometry,'soloJoinResize':True,'sameChoicesAndDefault029':True,'levelPicker':True})
        c.close()
    assert not errors,errors
    assert not uploads,uploads
    report={'engine':ENGINE,'version':version,'cases':cases,'pageErrors':errors,'uploads':len(uploads),'scope':'Synthetic browser layout/controls; WebKit engine is not physical iPad acceptance; no training or strength games'}
    (OUT/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'engine':ENGINE,'version':version,'cases':len(cases),'errors':errors,'uploads':len(uploads)}))
    browser.close()
