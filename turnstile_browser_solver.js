// turnstile_browser_solver.js — solver Turnstile managed berbasis browser sungguhan.
// Render widget dengan sitekey target, simpan token lewat callback DAN hidden
// input, serta coba klik checkbox/iframe bila Cloudflare meminta interaksi.
const { connect } = require("puppeteer-real-browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escAttr(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildHtml({ sitekey, action, cdata, theme }) {
    const attrs = [
        `data-sitekey="${escAttr(sitekey)}"`,
        `data-theme="${escAttr(theme || "light")}"`,
        `data-callback="__cfTurnstileToken"`,
        action ? `data-action="${escAttr(action)}"` : "",
        cdata ? `data-cdata="${escAttr(cdata)}"` : ""
    ].filter(Boolean).join(" ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turnstile</title>
<script>
window.__tsToken = "";
window.__cfTurnstileToken = function(token) { window.__tsToken = String(token || ""); };
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body style="margin:0;background:#fff">
<div class="cf-turnstile" style="width:300px;height:65px;margin:24px" ${attrs}></div>
</body>
</html>`;
}

async function readToken(page) {
    return page.evaluate(() => {
        if (window.__tsToken) return String(window.__tsToken);
        const el = document.querySelector('input[name="cf-turnstile-response"]')
            || document.querySelector('textarea[name="cf-turnstile-response"]');
        return el ? String(el.value || "") : "";
    }).catch(() => "");
}

async function interact(page) {
    // Turnstile bisa berada di iframe Cloudflare. Klik widget utama dan
    // checkbox di iframe bila tersedia. Aman bila tidak ada.
    try { await page.click(".cf-turnstile"); } catch (_) {}
    try {
        for (const frame of page.frames()) {
            const url = String(frame.url() || "");
            if (!/challenges\.cloudflare\.com/.test(url)) continue;
            for (const sel of ["input[type=checkbox]", ".cb-container", "body"]) {
                try { await frame.click(sel); break; } catch (_) {}
            }
        }
    } catch (_) {}
    try {
        await page.evaluate(() => {
            try {
                const el = document.querySelector(".cf-turnstile");
                const id = el && el.getAttribute("data-widget-id");
                if (window.turnstile && id) window.turnstile.execute(id);
            } catch (_) {}
        });
    } catch (_) {}
}

async function solve(payload) {
    const websiteUrl = String(payload.websiteURL || "");
    const sitekey = String(payload.websiteKey || payload.sitekey || "");
    if (!websiteUrl || !sitekey) throw new Error("websiteURL dan websiteKey wajib");

    const ua = payload.userAgent || payload.ua || "";
    const proxy = payload.proxy ? String(payload.proxy) : "";
    const theme = payload.theme || "light";
    const timeoutMs = Math.min(120000, Math.max(20000, parseInt(payload.timeoutMs, 10) || 90000));
    const headless = process.env.CF_BROWSER_HEADLESS !== "0";

    const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
    if (ua) args.push("--user-agent=" + ua);

    let browser = null;
    try {
        const conn = await connect({
            headless,
            turnstile: true,
            customConfig: {
                chromePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
                args
            }
        });
        browser = conn.browser;
        const page = await browser.newPage();
        if (ua) await page.setUserAgent(ua);

        if (proxy) {
            try {
                let p = proxy;
                if (!/^[a-zA-Z]+:\/\//.test(p)) p = "http://" + p;
                const u = new URL(p);
                if (u.username || u.password) {
                    await page.authenticate({
                        username: decodeURIComponent(u.username || ""),
                        password: decodeURIComponent(u.password || "")
                    });
                }
            } catch (e) {
                console.error("[TS-Browser] proxy parse warning: " + e.message);
            }
        }

        const stubUrl = websiteUrl.endsWith("/") ? websiteUrl : websiteUrl + "/";
        const html = buildHtml({ sitekey, action: payload.action, cdata: payload.cdata, theme });

        await page.setRequestInterception(true);
        page.on("request", (req) => {
            try {
                if (req.url() === stubUrl || req.url() === websiteUrl) {
                    req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
                } else {
                    req.continue();
                }
            } catch (_) {
                try { req.continue(); } catch (_) {}
            }
        });

        await page.goto(stubUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

        const deadline = Date.now() + timeoutMs;
        let lastToken = "";
        let round = 0;
        while (Date.now() < deadline && !lastToken) {
            lastToken = await readToken(page);
            if (lastToken) break;
            if (round === 0 || Math.floor((deadline - Date.now()) / 1000) % 10 === 0) {
                await interact(page);
            }
            if (Date.now() + 5000 > deadline && round === 0) {
                // Reset sekali sebelum waktu habis, tanpa reload seluruh halaman.
                round = 1;
                try {
                    await page.evaluate(() => {
                        try { if (window.turnstile) window.turnstile.reset(); } catch (_) {}
                    });
                } catch (_) {}
            }
            await sleep(1000);
        }
        if (!lastToken) return { ok: false, error: "NO_TURNSTILE_TOKEN" };

        const usedUa = await page.evaluate(() => navigator.userAgent).catch(() => ua);
        return { ok: true, token: lastToken, user_agent: usedUa };
    } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

process.stdin.on("data", async (data) => {
    let result;
    try {
        result = await solve(JSON.parse(data.toString()));
    } catch (e) {
        result = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    console.log(JSON.stringify(result));
    process.exit(0);
});
