const express = require("express");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: "50mb" }));

// Gunakan /app/cfsolve (sesuai Dockerfile baru)
const CFSOLVE_BIN = process.env.CFSOLVE_BIN || (fs.existsSync(path.join(__dirname, "cfsolve")) ? path.join(__dirname, "cfsolve") : "/app/cfsolve");
const TASK_TIMEOUT = parseInt(process.env.TASK_TIMEOUT, 10) || 120000;
const TASKS_FILE = path.join(os.tmpdir(), "tasks.json");
const PROFILES_DIR = process.env.PROFILES_DIR || "/app/profiles";

const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const ADSLAB_RUNNER = path.join(__dirname, "adslab_runner.py");
const WAF_RUNNER = path.join(__dirname, "cf_waf_solver.py");

// Tertuyul dipakai di server hanya saat cfsolve mendeteksi managed widget:
// mode itu menghasilkan cf_chl_out/orchestrator, bukan token Turnstile.
// Key default sengaja disertakan karena repo ini terbuka; env bisa meng-override.
const TERTUYUL_API = (process.env.TERTUYUL_API || "http://api.tertuyul.my.id").replace(/\/+$/, "");
const TERTUYUL_KEY = process.env.TERTUYUL_KEY || "90d4b91a1c3c2e430fa3e17f62a4d545";
const TERTUYUL_TIMEOUT_MS = Math.max(30000, parseInt(process.env.TERTUYUL_TIMEOUT_MS, 10) || 120000);
const TERTUYUL_POLL_MS = Math.max(1000, parseInt(process.env.TERTUYUL_POLL_MS, 10) || 3000);

const MAX_ACTIVE = 2; 
const MAX_QUEUE = 8;   

let activeTasks = 0;
const queue = [];

let PROFILES = [];
function _loadProfiles(dir) {
    try {
        const dirs = fs.readdirSync(dir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory()).map(dirent => dirent.name).sort();
        for (const d of dirs) {
            const mainJsonPath = path.join(dir, d, "main.json");
            if (fs.existsSync(mainJsonPath)) PROFILES.push(mainJsonPath);
        }
    } catch (e) { /* ignore */ }
}
_loadProfiles(PROFILES_DIR);
if (PROFILES.length === 0) _loadProfiles(path.join(__dirname, "profiles"));
if (PROFILES.length === 0) {
    console.error("Gagal baca profil: tidak ada profile valid di", PROFILES_DIR, "atau ./profiles");
    PROFILES.push(path.join(__dirname, "profiles", "iphone-13", "main.json"));
}

// WAF: prioritaskan profil yang cenderung lebih kompatibel dengan challenge saat ini.
// (probe/collector dapat berubah; urutan ini bisa diperbarui setelah capture profil baru)
const WAF_PROFILES = [...PROFILES].sort((a, b) => {
    const score = (p) => {
        const n = path.basename(path.dirname(p)).toLowerCase();
        if (n.includes("safari-26")) return 0;
        if (n.includes("iphone-13") || n.includes("iphone-14")) return 1;
        if (n.includes("safari") || n.includes("chrome")) return 2;
        return 3;
    };
    return score(a) - score(b);
});

let profileIndex = 0;
let wafProfileIndex = 0;
function getNextProfile() {
    const prof = PROFILES[profileIndex];
    profileIndex = (profileIndex + 1) % PROFILES.length;
    return prof;
}
function getNextWafProfile() {
    const list = WAF_PROFILES.length ? WAF_PROFILES : PROFILES;
    const prof = list[wafProfileIndex % list.length];
    wafProfileIndex = (wafProfileIndex + 1) % list.length;
    return prof;
}

function getProfileUa(profilePath, fallbackUa) {
    try {
        const raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        const headers = raw && raw.transport && raw.transport.headers;
        const ua = headers && (headers["User-Agent"] || headers["user-agent"] || headers.USER_AGENT);
        if (ua) return String(ua);
    } catch (e) { /* ignore */ }
    return fallbackUa || null;
}

function redactSecrets(text, secrets = []) {
    let out = String(text == null ? "" : text);
    for (const value of secrets) {
        if (value) out = out.split(String(value)).join("***");
    }
    return out
        .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, "$1***@")
        .slice(0, 500);
}

let tasks = {};
if (fs.existsSync(TASKS_FILE)) {
    try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch (e) {}
}
function saveTasks() { try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); } catch (e) {} }

function runCfsolve(pageUrl, { proxy, sitekey, action, cdata, blankPage, mode, profilePath, ua, timeoutMs, httpTimeoutSec } = {}) {
    return new Promise((resolve, reject) => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfsolve-"));
        const args = ["--page", pageUrl, workDir, "--solve", "--fingerprint", profilePath];

        if (proxy) args.push("--proxy", proxy);
        if (mode === "turnstile" && sitekey) {
            args.push("--sitekey", sitekey);
            if (blankPage) args.push("--blank-page");
            if (action) args.push("--action", action);
            if (cdata) args.push("--cdata", cdata);
        }

        const childEnv = { ...process.env };
        if (httpTimeoutSec) {
            childEnv.CFSOLVE_HTTP_TIMEOUT_SECS = String(httpTimeoutSec);
            // Hanya WAF yang mengirim httpTimeoutSec: jangan biarkan proxy env
            // menimpa proxy dari payload task (turnstile/adslab tidak berubah).
            for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
                delete childEnv[key];
            }
        }
        execFile(CFSOLVE_BIN, args, { timeout: timeoutMs || TASK_TIMEOUT, maxBuffer: 1024 * 1024, env: childEnv }, (err, stdout, stderr) => {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

            const rawStdout = (stdout || "").toString().trim();
            const rawStderr = (stderr || "").toString().trim();
            if (err) {
                const rawErr = (rawStderr || rawStdout || err.message || "cfsolve failed").toString();
                const lines = rawErr.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                let shortErr = lines.length ? lines[lines.length - 1] : "cfsolve failed";
                if (shortErr.includes("VM: function")) {
                    shortErr = lines.find(l => l && !l.includes("VM: function")) || "Gagal menyelesaikan (CF Error)";
                }
                const detail = lines.slice(-3).join(" | ").slice(0, 350);
                // Managed widget/challenge orchestrator cannot yield a cf-turnstile-response
                // token. Flag it so callers can switch to a fallback solver immediately.
                const managedWidget = /(_cf_chl_opt|cloudflare-challenge|cfChlOut|cfChlOutS|frMd|challenge did not complete after the interaction POST)/i.test(rawErr);
                const failure = new Error(detail || shortErr);
                failure.cfManagedWidget = managedWidget;
                return reject(failure);
            }

            const out = rawStdout;
            if (!out) return reject(new Error(rawStderr ? rawStderr.split(/\r?\n/).pop().slice(0, 350) : "Empty output dari cfsolve"));

            const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const cfLine = [...lines].reverse().find(l => l.startsWith("cf_clearance="));
            if (cfLine) return resolve({ cf_clearance: cfLine.split("=", 2)[1].trim() });
            if (out.startsWith("cf_clearance=")) return resolve({ cf_clearance: out.split("=", 2)[1].trim() });
            return resolve({ token: lines.length ? lines[lines.length - 1] : out });
        });
    });
}

async function runTertuyul({ pageUrl, sitekey } = {}) {
    const deadline = Date.now() + TERTUYUL_TIMEOUT_MS;
    const submitUrl = `${TERTUYUL_API}/in.php`;
    const pollUrl = `${TERTUYUL_API}/res.php`;
    const submit = await fetch(submitUrl, {
        method: "POST",
        body: new URLSearchParams({
            key: TERTUYUL_KEY, method: "turnstile",
            pageurl: String(pageUrl || ""), sitekey: String(sitekey || ""), json: "1"
        }),
        signal: AbortSignal.timeout(Math.min(60000, TERTUYUL_TIMEOUT_MS))
    });
    const submitted = await submit.json();
    if (Number(submitted.status) !== 1) {
        throw new Error(`tertuyul submit: ${JSON.stringify(submitted).slice(0, 200)}`);
    }
    const taskId = submitted.request;
    if (!taskId || String(taskId).startsWith("ERROR_")) {
        throw new Error(`tertuyul task: ${taskId}`);
    }
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, TERTUYUL_POLL_MS));
        const polled = await fetch(pollUrl, {
            method: "POST",
            body: new URLSearchParams({ key: TERTUYUL_KEY, action: "get", id: String(taskId), json: "1" }),
            signal: AbortSignal.timeout(45000)
        });
        const result = await polled.json();
        const request = result.request;
        if (Number(result.status) === 1 && request && request !== "CAPCHA_NOT_READY") {
            return String(request);
        }
        if (request && String(request).startsWith("ERROR_")) {
            throw new Error(`tertuyul error: ${request}`);
        }
    }
    throw new Error("tertuyul timeout");
}

function runAdslab({ sitekey, siteurl, subId, proxy, cookies, ua } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(PYTHON_BIN, [ADSLAB_RUNNER], {
            cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "", stderr = "", settled = false;
        let timer = setTimeout(() => { if(!settled) child.kill("SIGKILL"); }, TASK_TIMEOUT);
        const finish = (handler, value) => { if (settled) return; settled = true; clearTimeout(timer); handler(value); };

        child.stdout.on("data", c => { stdout += c.toString(); console.log(`[Py] ${c.toString().trim()}`); });
        child.stderr.on("data", c => { stderr += c.toString(); console.error(`[Py-Err] ${c.toString().trim()}`); });
        child.on("error", err => finish(reject, err));
        child.on("close", () => {
            try {
                const parsed = JSON.parse(stdout.trim().split("\n").pop());
                if (parsed.ok) finish(resolve, { token: parsed.token });
                else finish(reject, new Error(parsed.error || "AdsLab failed"));
            } catch (e) { finish(reject, new Error(stderr.trim().split("\n").pop() || "Invalid JSON AdsLab")); }
        });
        child.stdin.end(JSON.stringify({ task: { websiteKey: sitekey, websiteURL: siteurl, subId: subId, proxy: proxy, cookies: cookies, ua: ua } }));
    });
}

function runCfWaf({ siteurl, proxy, cookies, ua, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
        // WAF: proxy hanya dari payload task, jangan biarkan env override.
        for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
            delete childEnv[key];
        }
        const child = spawn(PYTHON_BIN, [WAF_RUNNER], {
            cwd: __dirname, env: childEnv,
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "", stderr = "", settled = false;
        let timer = setTimeout(() => { if(!settled) child.kill("SIGKILL"); }, timeoutMs || TASK_TIMEOUT);
        const finish = (handler, value) => { if (settled) return; settled = true; clearTimeout(timer); handler(value); };

        child.stdout.on("data", c => { stdout += c.toString(); });
        child.stderr.on("data", c => { stderr += c.toString(); console.error(`[WAF-Py-Err] ${redactSecrets(c.toString().trim(), [proxy, cookies])}`); });
        child.on("error", err => finish(reject, err));
        child.on("close", () => {
            try {
                const lines = stdout.trim().split("\n");
                const lastLine = lines[lines.length - 1];
                const parsed = JSON.parse(lastLine);
                if (parsed.ok) finish(resolve, { cf_clearance: parsed.token, ua: parsed.ua, type: parsed.type });
                else finish(reject, new Error(parsed.error || "CF WAF failed"));
            } catch (e) { 
                finish(reject, new Error(`Python Error: ${stderr || stdout}`)); 
            }
        });
        child.stdin.end(JSON.stringify({ task: { websiteURL: siteurl, proxy: proxy, cookies: cookies, ua: ua } }));
    });
}

function processQueue() {
    while (activeTasks < MAX_ACTIVE && queue.length > 0) {
        const taskJob = queue.shift();
        activeTasks++;
        taskJob.run().finally(() => { activeTasks--; setImmediate(processQueue); });
    }
}

const solveHandler = async (req, res) => {
    const body = req.body || {};
    if (body.taskId && tasks[body.taskId]) return res.json(tasks[body.taskId]);
    if (!body.task) return res.status(400).json({ error: "Missing task" });

    const task = body.task;
    const type = String(task.type || "").toLowerCase();
    const isAdslab = type.includes("ads") || type.includes("alcaptcha") || type.includes("adslab");
    const isWaf = type === "cfwaf" || type === "cfwaftask" || type === "waf" || type.includes("interstitial") || type.includes("cfwaf");
    // Proxy HANYA dari payload task — env tidak lagi menimpa (membersihkan alur python)
    const proxy = String(task.proxy || "").trim();
    const cookies = task.cookies || "";
    const ua = task.ua || task.userAgent || "";  // NEW: accept UA from task or session
    const websiteUrl = task.websiteURL || task.websiteUrl || task.siteurl || task.pageUrl || task.url || "";
    const timeoutMs = Math.max(30000, parseInt(task.timeout || process.env.TASK_TIMEOUT || TASK_TIMEOUT, 10) || TASK_TIMEOUT);

    if (queue.length >= MAX_QUEUE) return res.status(429).json({ status: "error", err: { usr: "QUEUE_FULL" } });
    if (!websiteUrl) return res.status(400).json({ status: "error", error: "Missing websiteUrl", err: { usr: "ERROR_BAD_PARAMETERS" } });

    const taskId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const selectedProfile = (isAdslab || isWaf) ? null : getNextProfile();
    const profileName = selectedProfile ? path.basename(path.dirname(selectedProfile)) : type;

    tasks[taskId] = { status: "pending", taskId };
    saveTasks();

    res.json({ taskId, status: "pending" });
    console.log(`[TASK] ${taskId} masuk antrean. Tipe: ${profileName} type=${type || "cf"} url=${websiteUrl}`);

    const taskJob = {
        run: async () => {
            try {
                let solution;
                if (isAdslab) {
                    solution = await runAdslab({
                        sitekey: task.websiteKey || task.sitekey,
                        siteurl: websiteUrl,
                        subId: task.subId || task.subid || "widget_user",
                        proxy: proxy, cookies: cookies, ua: ua
                    });
                } else if (isWaf) {
                    let wafPrimaryErr = null;
                    // Client SF menunggu ~170s; pakai budget khusus WAF agar attempt
                    // pertama punya waktu lebih panjang dari timeout HTTP default cfsolve.
                    const wafBudgetMs = Math.min(160000, Math.max(timeoutMs, task.timeout ? timeoutMs : 150000));
                    const wafDeadline = Date.now() + wafBudgetMs;
                    // Sisiskan waktu untuk Python WAF solver bila binary gagal total (default SF ~170s).
                    const pythonReserveMs = Math.min(30000, Math.max(5000, Math.floor(wafBudgetMs * 0.2)));
                    const binaryDeadline = Date.now() + Math.max(10000, wafBudgetMs - pythonReserveMs);
                    // CF/CF-WAF: binary diprioritaskan. Rotasi profil bila attempt pertama
                    // timeout, lalu kembalikan UA profil yang dipakai cfsolve karena
                    // cf_clearance terikat pada UA + IP yang sama.
                    if (fs.existsSync(CFSOLVE_BIN) && task.wafSolver !== "python") {
                        const maxAttempts = Math.max(1, Math.min(2, PROFILES.length));
                        const attemptBudgets = [90000, 30000];
                        for (let attempt = 0; attempt < maxAttempts && Date.now() < binaryDeadline - 10000; attempt++) {
                            const remaining = binaryDeadline - Date.now() - 3000;
                            if (remaining < 20000) break;
                            const attemptTimeout = Math.min(attemptBudgets[attempt] || 30000, Math.max(20000, remaining));
                            const httpTimeoutSec = Math.max(20, Math.min(180, Math.floor(attemptTimeout / 1000) - 3));
                            const prof = getNextWafProfile();
                            const wafProfileName = path.basename(path.dirname(prof));
                            try {
                                const result = await runCfsolve(websiteUrl, {
                                    proxy, sitekey: task.websiteKey || task.sitekey, action: task.action,
                                    cdata: task.cdata, blankPage: task.blankPage, mode: "challenge",
                                    profilePath: prof, ua, timeoutMs: attemptTimeout, httpTimeoutSec
                                });
                                if (result && result.cf_clearance) {
                                    solution = {
                                        cf_clearance: result.cf_clearance,
                                        ua: getProfileUa(prof, ua),
                                        type: "cfsolve",
                                        profile: wafProfileName,
                                        attempts: attempt + 1
                                    };
                                    break;
                                }
                                throw new Error(result && result.token ? `unexpected cfsolve output: ${String(result.token).slice(0, 220)}` : "cfsolve returned no cf_clearance");
                            } catch (e) {
                                wafPrimaryErr = e;
                                const emsg = redactSecrets(e.message, [proxy]);
                                console.log(`[WAF] cfsolve attempt ${attempt + 1}/${maxAttempts} (${wafProfileName}) gagal: ${emsg}`);
                                const raw = String(e.message || e || "");
                                const proxyConnectErr = /tunnel error|failed to create underlying connection|tcp connect error|failed to connect to proxy|proxy connect|connection refused|network is unreachable|no route to host|host unreachable|os error 11[013]|os error 101/i.test(raw);
                                if (proxyConnectErr) {
                                    console.log(`[WAF] proxy/connectivity error terdeteksi; hentikan rotasi profil`);
                                    break;
                                }
                            }
                        }
                    }
                    if (!solution) {
                        // Python WAF solver tetap sebagai cadangan bila binary tidak tersedia/gagal total.
                        solution = await runCfWaf({
                            siteurl: websiteUrl,
                            proxy: proxy, cookies: cookies, ua: ua,
                            timeoutMs: Math.max(10000, wafDeadline - Date.now())
                        });
                        if (wafPrimaryErr && solution && typeof solution === "object") {
                            solution.cfsolve_fallback_error = redactSecrets(wafPrimaryErr.message || wafPrimaryErr, [proxy, cookies]);
                        }
                    }
                } else {
                    let result = null;
                    try {
                        result = await runCfsolve(websiteUrl, {
                            proxy, sitekey: task.websiteKey || task.sitekey, action: task.action,
                            cdata: task.cdata, blankPage: task.blankPage, mode: type, profilePath: selectedProfile, ua: ua, timeoutMs
                        });
                    } catch (e) {
                        if (type !== "turnstile" || !e.cfManagedWidget) throw e;
                        let token;
                        try {
                            token = await runTertuyul({
                                pageUrl: websiteUrl,
                                sitekey: task.websiteKey || task.sitekey
                            });
                        } catch (te) {
                            const fallbackErr = new Error(`tertuyul fallback gagal: ${te.message}`);
                            fallbackErr.cfManagedWidget = true;
                            fallbackErr.tertuyulFailed = true;
                            throw fallbackErr;
                        }
                        solution = { token, source: "tertuyul", fallback: "CF_MANAGED_WIDGET" };
                        console.log(`[FALLBACK] Task ${taskId}: managed widget -> Tertuyul OK`);
                    }
                    if (!solution) {
                        if (type === "turnstile") {
                            if (!result || !result.token) throw new Error("cfsolve returned no turnstile token");
                            solution = { token: result.token, source: "cfsolve" };
                        } else {
                            if (!result || !result.cf_clearance) {
                                throw new Error(result && result.token ? `unexpected cfsolve output: ${String(result.token).slice(0, 220)}` : "cfsolve returned no cf_clearance");
                            }
                            solution = { cf_clearance: result.cf_clearance, profile: profileName };
                        }
                    }
                }
                tasks[taskId] = { status: "ready", taskId, solution };
                console.log(`[SUKSES] Task ${taskId} selesai (${type || profileName})`);
            } catch (err) {
                const safeErr = redactSecrets(err.message, [proxy, cookies, TERTUYUL_KEY]);
                const usr = err.tertuyulFailed ? "TERTUYUL_FALLBACK_FAILED"
                    : err.cfManagedWidget ? "CF_MANAGED_WIDGET"
                    : "ERROR_CAPTCHA_UNSOLVABLE";
                const hint = err.cfManagedWidget
                    ? "Cloudflare served a managed challenge widget; use a token fallback solver"
                    : undefined;
                tasks[taskId] = { status: "error", taskId, err: { usr, api: safeErr, ...(hint ? { hint } : {}) } };
                console.log(`[GAGAL] Task ${taskId} (${type || profileName}): ${safeErr}`);
            } finally {
                saveTasks();
                setTimeout(() => { delete tasks[taskId]; saveTasks(); }, 60000);
            }
        }
    };

    queue.push(taskJob);
    processQueue();
};

app.post("/solve", solveHandler);
app.post("/solve/adslab", solveHandler);

app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 Server berjalan di port ${port}`);
    console.log(`Profil terdeteksi: ${PROFILES.length}`);
});
