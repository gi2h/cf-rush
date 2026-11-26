// turnstile_browser_solver.js — blank-page Turnstile solver.
// Inject halaman kosong dengan widget Turnstile, tunggu token muncul dari
// callback / hidden input, dan bantu klik checkbox di iframe bila diminta.
const { connect } = require("puppeteer-real-browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (value) => JSON.stringify(String(value == null ? "" : value));

function buildHtml({ siteKey, action, cdata, pagedata }) {
    const actionLine = action ? `action: ${js(action)},` : "";
    const cdataLine = cdata ? `cData: ${js(cdata)},` : "";
    const pageLine = pagedata ? `chlPageData: ${js(pagedata)},` : "";
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Verify</title></head>
<body style="padding:50px;display:flex;justify-content:center;">
    <div id="cf-container" class="cf-turnstile"></div>
    <script>
        window.__cfError = null;
        window.__cfToken = null;
        window.onloadTurnstileCallback = function () {
            try {
                turnstile.render('#cf-container', {
                    sitekey: ${js(siteKey)},
                    ${actionLine}
                    ${cdataLine}
                    ${pageLine}
                    callback: function (token) {
                        window.__cfToken = String(token || "");
                        var c = document.createElement('input');
                        c.type = 'hidden';
                        c.name = 'cf-response';
                        c.value = window.__cfToken;
                        document.body.appendChild(c);
                    },
                    'error-callback': function (code) {
                        window.__cfError = String(code || 'widget_error');
                    }
                });
            } catch (e) {
                window.__cfError = 'render_err';
            }
        };
    </script>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>
</body>
</html>`;
}

async function solve(payload) {
    const domain = String(payload.websiteURL || payload.websiteUrl || payload.domain || "");
    const siteKey = String(payload.websiteKey || payload.sitekey || "");
    if (!domain || !siteKey) throw new Error("websiteURL dan websiteKey wajib");

    const timeout = Math.min(120000, Math.max(20000, parseInt(payload.timeoutMs, 10) || 120000));
    const startTime = Date.now();
    const ua = payload.userAgent || payload.ua || "";
    const proxy = payload.proxy ? String(payload.proxy) : "";
    const headless = process.env.CF_BROWSER_HEADLESS !== "0";
    const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
    if (ua) args.push("--user-agent=" + ua);

    let targetHost = domain;
    try { targetHost = new URL(domain).hostname; } catch (_) {}

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
        page.setDefaultNavigationTimeout(timeout);
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
                console.error("[TS] proxy parse warning: " + e.message);
            }
        }

        const htmlContent = buildHtml({
            siteKey,
            action: payload.action,
            cdata: payload.cdata,
            pagedata: payload.pagedata
        });

        await page.setRequestInterception(true);
        page.removeAllListeners("request");
        page.on("request", async (request) => {
            try {
                if (request.url().includes(targetHost)
                        && request.resourceType() === "document") {
                    await request.respond({
                        status: 200,
                        contentType: "text/html; charset=utf-8",
                        body: htmlContent
                    });
                } else {
                    await request.continue();
                }
            } catch (_) {
                try { await request.continue(); } catch (_) {}
            }
        });

        console.log(`[ts] Navigasi ke: ${domain}`);
        await page.goto(domain, { waitUntil: "domcontentloaded" }).catch(() => {});

        let lastState = "";
        let hasClicked = false;
        while (Date.now() - startTime < timeout) {
            const token = await page.evaluate(() => {
                return window.__cfToken
                    || (document.querySelector('[name="cf-response"]') || {}).value
                    || (document.querySelector('input[name="cf-turnstile-response"]') || {}).value
                    || "";
            }).catch(() => null);
            if (token && String(token).length > 10) {
                const usedUa = await page.evaluate(() => navigator.userAgent).catch(() => ua);
                return { ok: true, token: String(token), user_agent: usedUa, type: "turnstile" };
            }

            const errCode = await page.evaluate(() => window.__cfError).catch(() => null);
            if (errCode) {
                const code = String(errCode);
                if (code.includes("300030")) throw new Error("Invalid Sitekey (300030)");
                if (code.includes("600010")) throw new Error("Bot detected (600010)");
                throw new Error("Widget error code: " + code);
            }

            const cfFrame = page.frames().find((f) => String(f.url() || "").includes("challenges.cloudflare.com"));
            if (cfFrame) {
                const frameData = await cfFrame.evaluate(() => {
                    const text = (document.body && document.body.innerText || "")
                        .trim().replace(/\s+/g, " ");
                    const checkbox = document.querySelector('input[type="checkbox"]');
                    if (checkbox && !checkbox.checked) {
                        checkbox.click();
                        return { text, clicked: true };
                    }
                    return { text, clicked: false };
                }).catch(() => ({ text: "", clicked: false }));

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                if (elapsed % 5 === 0 && elapsed > 0 && elapsed !== lastState) {
                    lastState = elapsed;
                    console.log(`[ts-iframe] ${elapsed}s | Text: "${frameData.text.slice(0, 50)}"`);
                }
                if (frameData.text.includes("Verify") && !hasClicked) {
                    const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com"]').catch(() => null);
                    const box = iframeElement ? await iframeElement.boundingBox().catch(() => null) : null;
                    if (box) {
                        await page.mouse.click(box.x + 30, box.y + box.height / 2).catch(() => {});
                        hasClicked = true;
                    }
                }
            }
            await sleep(1000);
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
