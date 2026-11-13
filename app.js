// app.js — Sistem Antrean (Queue) + Logika 429 Original
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
const TASK_TIMEOUT = parseInt(process.env.TASK_TIMEOUT, 10) || 120000;
const TASKS_FILE = path.join(os.tmpdir(), "tasks.json");

// Konfigurasi Pembatas
const MAX_ACTIVE = parseInt(process.env.MAX_ACTIVE, 10) || 2; // Maksimal 2 proses bersamaan
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE, 10) || 6;   // Maksimal 6 task di antrean

let activeTasks = 0;
const queue = [];

// State Task & Penyimpanan
let tasks = {};
if (fs.existsSync(TASKS_FILE)) {
    try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch (e) {}
}
function saveTasks() {
    try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); } catch (e) {}
}

// Fungsi Solver
function runCfsolve(pageUrl, { proxy, sitekey, action, cdata, blankPage, mode } = {}) {
    return new Promise((resolve, reject) => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfsolve-"));
        const args = ["--page", pageUrl, workDir, "--solve", "--fingerprint", CFSOLVE_PROFILE];
        
        if (proxy) args.push("--proxy", proxy);
        if (mode === "turnstile" && sitekey) {
            args.push("--sitekey", sitekey);
            if (blankPage) args.push("--blank-page");
            if (action) args.push("--action", action);
            if (cdata) args.push("--cdata", cdata);
        }
        
        execFile(CFSOLVE_BIN, args, { timeout: TASK_TIMEOUT }, (err, stdout, stderr) => {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
            if (err) {
                const rawErr = (stderr || err.message || "").toString();
                let shortErr = rawErr.trim().split('\n').pop();
                if (!shortErr || shortErr.includes("VM: function")) shortErr = "Gagal menyelesaikan (CF Error)";
                return reject(new Error(shortErr));
            }
            const out = (stdout || "").trim();
            if (!out) return reject(new Error("Empty output dari cfsolve"));
            if (out.startsWith("cf_clearance=")) return resolve({ cf_clearance: out.split("=")[1] });
            return resolve({ token: out });
        });
    });
}

// Fungsi Process Antrean
function processQueue() {
    while (activeTasks < MAX_ACTIVE && queue.length > 0) {
        const taskJob = queue.shift();
        activeTasks++;
        taskJob.run().finally(() => {
            activeTasks--;
            setImmediate(processQueue);
        });
    }
}

app.post("/solve", async (req, res) => {
    const body = req.body;
    
    // Cek status task (polling)
    if (body.taskId && tasks[body.taskId]) {
        return res.json(tasks[body.taskId]);
    }
    
    if (!body.task) return res.status(400).json({ error: "Missing task" });

    // LOGIKA ASLI: Jika antrean penuh, tolak dengan 429
    if (queue.length >= MAX_QUEUE) {
        return res.status(429).json({ 
            status: "error", 
            err: { usr: "QUEUE_FULL" } 
        });
    }

    const taskId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const type = (body.task.type || "").toLowerCase();
    const proxy = process.env.TERTUYUL_PROXY || body.task.proxy;

    // Daftarkan task sebagai pending
    tasks[taskId] = { status: "pending", taskId };
    saveTasks();
    
    // Kirim balasan ke bot Python
    res.json({ taskId, status: "pending" });

    // Masukkan pekerjaan ke antrean
    const taskJob = {
        run: async () => {
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
                console.log(`[SUKSES] Task ${taskId} selesai.`);
            } catch (err) {
                tasks[taskId] = { status: "error", taskId, err: { usr: "ERROR_CAPTCHA_UNSOLVABLE", api: err.message } };
                console.log(`[GAGAL] Task ${taskId} error: ${err.message}`);
            } finally {
                saveTasks();
                setTimeout(() => { delete tasks[taskId]; saveTasks(); }, 60000);
            }
        }
    };

    queue.push(taskJob);
    processQueue();
});

app.listen(port, "0.0.0.0", () => {
    console.log(`Server berjalan di port ${port}`);
    console.log(`Batas Aktif : ${MAX_ACTIVE}`);
    console.log(`Batas Antrean: ${MAX_QUEUE}`);
});
