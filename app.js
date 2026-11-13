// app.js — dengan penanganan error yang lebih baik
const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const CFSOLVE_BIN = process.env.CFSOLVE_BIN || "/usr/local/bin/challenge";
const CFSOLVE_PROFILE = process.env.CFSOLVE_PROFILE || "/app/profiles/safari-26-ios.json";
const TASK_TIMEOUT = 120000;

const tasks = {};

function runCfsolve(pageUrl, { proxy, sitekey, action, cdata, blankPage, mode } = {}) {
    return new Promise((resolve, reject) => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfsolve-"));
        const args = ["--page", pageUrl, workDir, "--solve", "--fingerprint", CFSOLVE_PROFILE];

        if (proxy) args.push("--proxy", proxy);

        // Jika ini mode Turnstile dan kita punya sitekey, gunakan --blank-page
        if (mode === "turnstile" && sitekey) {
            args.push("--sitekey", sitekey);
            if (blankPage) args.push("--blank-page");
            if (action) args.push("--action", action);
            if (cdata) args.push("--cdata", cdata);
        }
        // Jika mode interstitial (challenge page), JANGAN pakai --sitekey
        // agar cfsolve tahu harus menyelesaikan challenge page

        execFile(CFSOLVE_BIN, args, { timeout: TASK_TIMEOUT }, (err, stdout, stderr) => {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
            if (err) return reject(new Error(stderr.slice(-300) || err.message));
            const out = stdout.trim();
            if (!out) return reject(new Error("Empty output"));
            if (out.startsWith("cf_clearance=")) return resolve({ cf_clearance: out.split("=")[1] });
            return resolve({ token: out });
        });
    });
}

app.post("/solve", async (req, res) => {
    const body = req.body;
    if (body.taskId && tasks[body.taskId]) {
        return res.json(tasks[body.taskId]);
    }
    if (!body.task) return res.status(400).json({ error: "Missing task" });

    const taskId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const type = (body.task.type || "").toLowerCase();
    const proxy = process.env.TERTUYUL_PROXY || body.task.proxy;

    tasks[taskId] = { status: "pending", taskId };
    res.json({ taskId, status: "pending" });

    try {
        const result = await runCfsolve(body.task.websiteUrl, {
            proxy,
            sitekey: body.task.websiteKey,
            action: body.task.action,
            cdata: body.task.cdata,
            blankPage: body.task.blankPage,
            mode: type,
        });

        const solution = type === "turnstile"
            ? { token: result.token }
            : { cf_clearance: result.cf_clearance };

        tasks[taskId] = { status: "ready", taskId, solution };
    } catch (err) {
        // Jika error "page has no .cf-turnstile container", beri pesan yang lebih jelas
        let apiErr = err.message;
        if (apiErr.includes("page has no .cf-turnstile container")) {
            apiErr = "Situs target menggunakan Challenge Page, bukan Widget Turnstile. Ubah type menjadi 'interstitial' atau kosongkan websiteKey.";
        }
        tasks[taskId] = { status: "error", taskId, err: { usr: "ERROR_CAPTCHA_UNSOLVABLE", api: apiErr } };
    }

    setTimeout(() => delete tasks[taskId], 30000);
});

app.listen(port, "0.0.0.0", () => console.log(`Running on ${port}`));
