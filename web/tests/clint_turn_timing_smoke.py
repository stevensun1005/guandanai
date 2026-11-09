"""Solo round with Clint (rules-v2 with its 残局大脑) in three seats: every computer move is decided
within the owner's 60 s turn (reasoning by 50 s from the turn start, rules-only fallback after),
never shows the table-failure panel, and the brain runs in the endgame."""

from pathlib import Path
import json
import os
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
OUT = ROOT / "web/artifacts/validation/clint-turn-timing"
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get("BROWSER_CHANNEL", "chrome"))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # count rule requests that carried a brain budget (brainMs > 0) and their budgets
    page.add_init_script(
        """const Native = Worker; window.ruleBudgets = [];
        window.Worker = class extends Native {
          constructor(...a) {
            super(...a);
            this.rules = new Map();
            this.addEventListener('message', ({ data }) => {
              const r = this.rules.get(data && data.id);
              if (r) r.replyMs = Math.round(performance.now() - r.at);
            });
          }
          postMessage(d, ...a) {
            if (d && d.type === 'rule') {
              const r = { brainMs: d.state.brainMs, at: performance.now(),
                most: Math.max(...d.state.hands.map((h) => h.length)) };
              this.rules.set(d.id, r);
              window.ruleBudgets.push(r);
            }
            return super.postMessage(d, ...a);
          }
        };"""
    )
    page.goto(URL + "?test=1", wait_until="networkidle")
    page.locator("#nick").fill("牌友")
    page.locator('[data-seat="S"]').click()
    page.locator("#botStyleBox summary").click()
    for seat in "ENW":
        page.locator(f'[data-bot-seat="{seat}"]').select_option("clint-rule")
    page.locator("#sitBtn").click()
    for _ in range(250):
        if page.locator("#readyBtn").is_visible():
            break
        button = page.locator("#deckBtn")
        if button.is_visible() and button.is_enabled():
            button.click()
        page.wait_for_timeout(100)
    page.locator("#readyBtn").click()
    for _ in range(9000):
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
    assert not page.locator("#retryTableBtn").is_visible(), "table failure panel"
    assert not errors, errors
    assert page.evaluate("G.phase") in ("roundEnd", "over"), page.evaluate("G.phase")
    move_ms = page.evaluate("TableBot.moveTimes")["clint"]
    fallbacks = page.evaluate("TableBot.clintFallbacks")
    budgets = page.evaluate("ruleBudgets")
    assert move_ms and max(move_ms) < 52000, move_ms
    assert all(0 < b["brainMs"] <= 30000 for b in budgets), budgets
    endgame = [b for b in budgets if b["most"] <= 12]
    page.screenshot(path=str(OUT / "round.png"))
    report = {
        "clintMoves": len(move_ms),
        "moveMsFromTurnStart": {
            "p50": sorted(move_ms)[len(move_ms) // 2],
            "p95": sorted(move_ms)[int(len(move_ms) * 0.95)],
            "max": max(move_ms),
        },
        "ruleReplyMs": {
            "all max": max(b.get("replyMs", 0) for b in budgets),
            "brain phase (all hands <= 12)": sorted(b.get("replyMs", 0) for b in endgame),
        },
        "ruleRequests": len(budgets),
        "brainPhaseRequests": len(endgame),
        "brainMsSent": {"min": min(b["brainMs"] for b in budgets), "max": max(b["brainMs"] for b in budgets)},
        "rulesOnlyFallbacks": fallbacks,
        "pageErrors": errors,
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2))
    print(report)
    browser.close()
