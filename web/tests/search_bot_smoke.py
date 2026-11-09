"""Solo round with the belief-search research bot (menu 9001) in three seats: the dedicated search
worker loads the shipped champion and belief networks, bot turns are searched or fall back to the
champion without the error panel, and the shared AI worker still serves the human seat's hints."""

from pathlib import Path
import hashlib
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
OUT = ROOT / "web/artifacts/validation/search-bot"
OUT.mkdir(parents=True, exist_ok=True)
catalog = json.loads((ROOT / "web/src/ai/model-catalog.json").read_text(encoding="utf8"))
bot = catalog["searchBots"][0]
base = next(m for m in catalog["models"] if m["id"] == bot["base"])

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("BROWSER_CHANNEL", "chrome"))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors, workers, loaded = [], [], {}
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("worker", lambda worker: workers.append(worker.url))

    def remember(response):
        name = response.url.split("?")[0].rsplit("/", 1)[-1]
        if name in (bot["belief"]["file"], base["file"]) and response.ok:
            loaded[name] = hashlib.sha256(response.body()).hexdigest()

    page.on("response", remember)
    page.goto(URL + "?test=1", wait_until="networkidle")
    page.locator("#nick").fill("牌友")
    page.locator('[data-seat="S"]').click()
    page.locator("#botStyleBox summary").click()
    for seat in "ENW":
        assert page.locator(f'[data-bot-seat="{seat}"]').input_value() == catalog["selection"].get("defaultChoice", catalog["defaultId"])
        page.locator(f'[data-bot-seat="{seat}"]').select_option(bot["id"])
    labels = page.locator('[data-bot-seat="E"] option').all_text_contents()
    assert labels == ["Clint规则机器人", labels[1], "danMCai-v000855042", "danMCai-reason-v000855042"], labels
    page.locator("#sitBtn").click()
    for _ in range(250):
        if page.locator("#readyBtn").is_visible():
            break
        button = page.locator("#deckBtn")
        if button.is_visible() and button.is_enabled():
            button.click()
        page.wait_for_timeout(100)
    page.locator("#readyBtn").click()
    for _ in range(3000):
        if page.evaluate("G.phase !== 'play' && G.log.length > 0"):
            break
        if page.locator("#retryTableBtn").is_visible():
            break
        if page.locator("#hintBtn").is_enabled():
            page.locator("#hintBtn").click()
            if page.locator("#playBtn").is_enabled():
                page.locator("#playBtn").click()
            elif page.locator("#passBtn").is_enabled():
                page.locator("#passBtn").click()
        page.wait_for_timeout(100)
    stats = page.evaluate("JSON.parse(JSON.stringify(TableBot.searchStats))")
    assert not page.locator("#retryTableBtn").is_visible()
    assert not errors, errors
    assert page.evaluate("G.phase") in ("roundEnd", "over"), page.evaluate("G.phase")
    assert stats and stats["requests"] > 0, stats
    assert stats["searched"] > 0, stats
    assert sum(1 for url in workers if "search-worker.mjs" in url) >= 1, workers
    assert loaded.get(bot["belief"]["file"]) == bot["belief"]["sha256"], loaded
    page.screenshot(path=str(OUT / "round.png"))
    report = {
        "requests": stats["requests"],
        "searched": stats["searched"],
        "differs": stats["differs"],
        "fallbacks": stats["fallbacks"],
        "device": stats["device"],
        "searchMs": {
            "p50": sorted(stats["ms"])[len(stats["ms"]) // 2] if stats["ms"] else None,
            "max": max(stats["ms"]) if stats["ms"] else None,
        },
        "workers": sorted({url.split("?")[0].rsplit("/", 1)[-1] for url in workers}),
        "beliefSHA256": loaded.get(bot["belief"]["file"]),
        "pageErrors": errors,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print(report)
    browser.close()
