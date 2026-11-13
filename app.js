// app.js — cfsolve CLI wrapper (no Puppeteer)
const express = require("express");
const { execFile } = require("child_process");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");

const app  = express();
const port = process.env.PORT || 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MAX_ACTIVE    = parseInt(process.env.MAX_ACTIVE, 10)    || 1;
const MAX_QUEUE     = parseInt(process.env.MAX_QUEUE, 10)     || 5;
const TASK_TIMEOUT  = parseInt(process.env.TASK_TIMEOUT, 10)  || 120000;
const CFSOLVE_BIN     = process.env.CFSOLVE_BIN     || "/usr/local/bin/challenge";
const CFSOLVE_PROFILE = process.env.CFSOLVE_PROFILE || "/app/profiles/safari-26-ios.json";
const DEFAULT_PROXY   = process.env.TERTUYUL_PROXY || process.env.PROXY_URI || null;

let activeTasks = 0;
const tasks = Object.create(null);
const queue = [];

function runCfsolve(pageUrl, { proxy, sitekey, action, cdata } = {}) {
    return new Promise((resolve, reject) => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfsolve-"));
        const args = ["--page", pageUrl, workDir, "--solve",
                      "--fingerprint", CFSOLVE_PROFILE];
        if (proxy)   args.push("--proxy", proxy);
        if (sitekey) {
            args.push("--sitekey", sitekey);
            if (action) args.push("--action", action);
            if (cdata)  args.push("--cdata", cdata);
        }

        execFile(CFSOLVE_BIN, args,
            { timeout: TASK_TIMEOUT, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
                try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
                if (err) return reject(new Error(
                    `cfsolve gagal: ${(stderr || "").slice(-300) || err.message}`));
                const out = (stdout || "").trim();
                if (!out) return reject(new Error("output kosong"));
                if (out.startsWith("cf_clearance="))
                    return resolve({ cf_clearance: out.split("=", 1)[1] });
                return resolve({ token: out });
            });
    });
}

async function executeTask(taskId, data) {
    try {
        const proxy = data.proxy || DEFAULT_PROXY;
        let result;
        if (data.method === "turnstile") {
            result = await runCfsolve(data.domain, {
                proxy, sitekey: data.siteKey, action: data.action, cdata: data.cdata,
            });
        } else if (data.method === "interstitial") {
            result = await runCfsolve(data.domain, { proxy });
            if (!result.cf_clearance)
                throw new Error("diharapkan cf_clearance, dapat token");
        } else {
            throw new Error(`metode tidak dikenal: ${data.method}`);
        }

        const solution = {};
        if (data.method === "turnstile") solution.token = result.token || "";
        else {
            solution.cf_clearance = result.cf_clearance || "";
            solution.user_agent   = "Safari/26.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
        }

        tasks[taskId] = { status: "ready", taskId, solution };
        setTimeout(() => delete tasks[taskId], 30000).unref?.();
    } catch (err) {
        console.error(`[Task ${taskId}] ${err.message}`);
        tasks[taskId] = { status: "error", taskId,
            err: { usr: "ERROR_CAPTCHA_UNSOLVABLE", api: err.message } };
        setTimeout(() => delete tasks[taskId], 10000).unref?.();
    }
}

function processQueue() {
    while (activeTasks < MAX_ACTIVE && queue.length > 0) {
        const taskId = queue.shift();
        const task   = tasks[taskId];
        if (!task || task.status !== "pending") continue;
        activeTasks++;
        task.status = "processing";
        executeTask(taskId, task.data).finally(() => {
            activeTasks--;
            setImmediate(processQueue);
        });
    }
}

app.get("/", (req, res) => res.status(200).json({
    status: "ok",
    engine: "cfsolve-rust",
    active: activeTasks,
    queue:  queue.length,
    ramMB:  Math.round(process.memoryUsage().rss / 1024 / 1024),
}));

app.post("/solve", async (req, res) => {
    const body = req.body;

    if (body.taskId) {
        const existing = tasks[body.taskId];
        if (!existing)
            return res.status(200).json({ status: "error", err: { usr: "TASK_NOT_FOUND" } });
        if (existing.status !== "pending" && existing.status !== "processing")
            delete tasks[body.taskId];
        return res.status(200).json(existing);
    }

    if (body.method !== "CloudflareTask" || typeof body.task !== "object")
        return res.status(400).json({ status: "error", err: { usr: "BAD_PARAMETERS" } });

    if (queue.length >= MAX_QUEUE)
        return res.status(429).json({ status: "error", err: { usr: "QUEUE_FULL" } });

    const newTaskId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    tasks[newTaskId] = {
        status: "pending",
        taskId: newTaskId,
        data: {
            method:  (body.task.type || "").toLowerCase(),
            domain:  body.task.websiteUrl,
            siteKey: body.task.websiteKey,
            action:  body.task.action,
            cdata:   body.task.cdata,
            proxy:   body.task.proxy || null,
        },
    };
    queue.push(newTaskId);
    processQueue();
    res.status(202).json({ taskId: newTaskId, status: "pending" });
});

app.listen(port, "0.0.0.0", () => {
    console.log(`Server cfsolve berjalan di port ${port}`);
    console.log(`Binary : ${CFSOLVE_BIN}`);
    console.log(`Profile: ${CFSOLVE_PROFILE}`);
});
