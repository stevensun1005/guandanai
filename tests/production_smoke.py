"""Use the actual UI without exposing test-mode globals."""
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright
URL=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765/'
OUT=Path(__file__).resolve().parents[1]/'work/validation/production'
OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel='chrome')
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.add_init_script("""const NativeWorker=Worker;window.policyTurns=0;
      window.Worker=class extends NativeWorker{postMessage(data,...rest){if(data.type==='decide')window.policyTurns++;return super.postMessage(data,...rest)}};""")
    page.goto(URL,wait_until='networkidle')
    assert page.evaluate('typeof G')=='undefined'
    version=page.locator('meta[name="app-version"]').get_attribute('content')
    assert page.locator('#verTag').inner_text().endswith(version)
    page.locator('#nick').fill('试玩')
    page.locator('[data-seat="S"]').click();page.locator('#sitBtn').click()
    for _ in range(250):
        if page.locator('#readyBtn').is_visible():break
        button=page.locator('#deckBtn')
        if button.is_visible() and button.is_enabled():button.click()
        page.wait_for_timeout(100)
    page.locator('#readyBtn').click()
    for _ in range(200):
        if page.evaluate('window.policyTurns>0'):break
        if page.locator('#hintBtn').is_enabled():
            page.locator('#hintBtn').click()
            if page.locator('#playBtn').is_enabled():page.locator('#playBtn').click()
        page.wait_for_timeout(100)
    page.wait_for_function('window.policyTurns>0',timeout=30000)
    page.wait_for_timeout(1200)
    assert not errors,errors
    page.screenshot(path=str(OUT/'table.png'))
    print({'productionGlobalsHidden':True,'policyTurns':page.evaluate('window.policyTurns'),'pageErrors':errors})
    browser.close()
