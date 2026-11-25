// turnstile_browser_solver.js — solver Turnstile managed berbasis browser sungguhan.
// Strategi ini mengikuti apa yang dipakai layanan berbayar/open-source:
// render widget di halaman stub dengan sitekey target, klik widget jika perlu,
// lalu baca input cf-turnstile-response.
const { connect } = require("puppeteer-real-browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escAttr(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildHtml({ sitekey, action, cdata }) {
    const attrs = [
        `data-sitekey="${escAttr(sitekey)}"`,
        action ? `data-action="${escAttr(action)}"` : "",
        cdata ? `data-cdata="${escAttr(cdata)}"` : ""
    ].filter(Boolean).join(" ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turnstile</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
<div class="cf-turnstile" style="background:#fff;width:300px;height:65px" ${attrs}></div>
</body>
</html>`;
}

async function solve(payload) {
    const websiteUrl = String(payload.websiteURL || "");
    const sitekey = String(payload.websiteKey || payload.sitekey || "");
    if (!websiteUrl || !sitekey) throw new Error("websiteURL dan websiteKey wajib");

    const ua = payload.userAgent || payload.ua || "";
    const proxy = payload.proxy ? String(payload.proxy) : "";
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
        const html = buildHtml({
            sitekey,
            action: payload.action,
            cdata: payload.cdata
        });

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
        for (let round = 0; round < 2 && Date.now() < deadline; round++) {
            if (round > 0) {
                try { await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }); } catch (_) {}
            }
            while (Date.now() < deadline) {
                lastToken = await page.evaluate(() => {
                    const el = document.querySelector('input[name="cf-turnstile-response"]');
                    return el ? String(el.value || "") : "";
                }).catch(() => "");
                if (lastToken) {
                    const usedUa = await page.evaluate(() => navigator.userAgent).catch(() => ua);
                    return { ok: true, token: lastToken, user_agent: usedUa };
                }
                // Managed widget bisa meminta klik; klik elemen widget aslinya.
                try { await page.click(".cf-turnstile"); } catch (_) {}
                await sleep(1000);
            }
        }
        return { ok: false, error: "NO_TURNSTILE_TOKEN" };
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
