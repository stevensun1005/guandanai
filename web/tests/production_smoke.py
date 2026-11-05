"""Use the actual UI without exposing test-mode globals."""

from pathlib import Path
import sys
import os
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
OUT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file()) / "web/artifacts/validation/production"
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("BROWSER_CHANNEL", "chrome"))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""const NativeWorker=Worker;window.policyTurns=0;window.policyModels=[];window.policyReplies=[];
      window.Worker=class extends NativeWorker{
        constructor(...args){super(...args);this.ids=new Map();this.addEventListener('message',({data})=>{
          if(this.ids.has(data.id)&&data.result)window.policyReplies.push(this.ids.get(data.id));});}
        postMessage(data,...rest){if(data.type==='decide'){window.policyTurns++;window.policyModels.push(data.state.modelId);this.ids.set(data.id,data.state.modelId);}return super.postMessage(data,...rest)}};""")
    page.goto(URL, wait_until="networkidle")
    assert page.evaluate("typeof G") == "undefined"
    version = page.locator('meta[name="app-version"]').get_attribute("content")
    assert page.locator("#verTag").inner_text().endswith(version)
    page.locator("#nick").fill("牌友")
    page.locator('[data-seat="S"]').click()
    page.locator('#botStyleBox summary').click()
    default = page.locator('[data-bot-seat="N"]').input_value()
    page.locator('[data-bot-seat="E"]').select_option('001')
    page.locator("#sitBtn").click()
    for _ in range(250):
        if page.locator("#readyBtn").is_visible():
            break
        button = page.locator("#deckBtn")
        if button.is_visible() and button.is_enabled():
            button.click()
        page.wait_for_timeout(100)
    page.locator("#readyBtn").click()
    for _ in range(400):
        if page.evaluate("models => models.every(id => window.policyReplies.includes(id))", ['001', default]):
            break
        if page.locator("#hintBtn").is_enabled():
            page.locator("#hintBtn").click()
            if page.locator("#playBtn").is_enabled():
                page.locator("#playBtn").click()
        page.wait_for_timeout(100)
    page.wait_for_function('models => models.every(id => window.policyReplies.includes(id))', arg=['001', default], timeout=30000)
    expected = page.request.get(URL.rstrip('/') + '/models/catalog.json').json()
    ids = {model['id'] for model in expected['models']}
    assert all(model in ids for model in page.evaluate('window.policyModels'))
    assert set(page.evaluate('window.policyReplies')) == {'001', default}
    assert not page.locator('#retryTableBtn').is_visible()
    assert not errors, errors
    page.screenshot(path=str(OUT / "table.png"))
    print(
        {
            "productionGlobalsHidden": True,
            "policyTurns": page.evaluate("window.policyTurns"),
            "successfulModelIds": sorted(set(page.evaluate('window.policyReplies'))),
            "pageErrors": errors,
        }
    )
    browser.close()
