// app.js — FINAL: 4 Active, 8 Queue, Auto-Rotate Profiles
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
const TASK_TIMEOUT = parseInt(process.env.TASK_TIMEOUT, 10) || 120000;
const TASKS_FILE = path.join(os.tmpdir(), "tasks.json");
const PROFILES_DIR = "/app/profiles";

// ==========================================
// KONFIGURASI PEMBATAS (4 ACTIVE, 8 QUEUE)
// ==========================================
const MAX_ACTIVE = 4; 
const MAX_QUEUE = 8;   

let activeTasks = 0;
const queue = [];

// ==========================================
// AUTO-DETECT PROFILES (SUB-FOLDER)
// ==========================================
let PROFILES = [];
try {
    const dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    for (const dir of dirs) {
        const mainJsonPath = path.join(PROFILES_DIR, dir, "main.json");
        if (fs.existsSync(mainJsonPath)) {
            PROFILES.push(mainJsonPath);
        }
    }
} catch (e) {
    console.error("Gagal membaca folder profil:", e.message);
}

// Fallback jika tidak ada profil terdeteksi
if (PROFILES.length === 0) {
    console.warn("[WARN] Tidak ada profil terdeteksi, fallback ke default (jika ada).");
    PROFILES.push("/app/profiles/iphone-13/main.json"); 
}

let profileIndex = 0;
function getNextProfile() {
    const prof = PROFILES[profileIndex];
    profileIndex = (profileIndex + 1) % PROFILES.length;
    return prof;
}

// ==========================================
// STATE TASK & PENYIMPANAN
// ==========================================
let tasks = {};
if (fs.existsSync(TASKS_FILE)) {
    try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch (e) {}
}
function saveTasks() {
    try { fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); } catch (e) {}
}

// ==========================================
// FUNGSI CF SOLVE
// ==========================================
function runCfsolve(pageUrl, { proxy, sitekey, action, cdata, blankPage, mode, profilePath } = {}) {
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
        
        execFile(CFSOLVE_BIN, args, { timeout: TASK_TIMEOUT }, (err, stdout, stderr) => {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
            
            if (err) {
                const rawErr = (stderr || err.message || "").toString();
                let shortErr = rawErr.trim().split('\n').pop();
                if (!shortErr || shortErr.includes("VM: function")) {
                    shortErr = "Gagal menyelesaikan (CF Error)";
                }
                return reject(new Error(shortErr));
            }
            
            const out = (stdout || "").trim();
            if (!out) return reject(new Error("Empty output dari cfsolve"));
            
            if (out.startsWith("cf_clearance=")) return resolve({ cf_clearance: out.split("=")[1] });
            return resolve({ token: out });
        });
    });
}

// ==========================================
// PROSES ANTREAN
// ==========================================
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

// ==========================================
// ROUTE: /solve
// ==========================================
app.post("/solve", async (req, res) => {
    const body = req.body;
    
    // 1. Cek Status (Polling)
    if (body.taskId && tasks[body.taskId]) {
        return res.json(tasks[body.taskId]);
    }
    
    if (!body.task) return res.status(400).json({ error: "Missing task" });

    // 2. Antrean Penuh (Logika Asli 429)
    if (queue.length >= MAX_QUEUE) {
        return res.status(429).json({ 
            status: "error", 
            err: { usr: "QUEUE_FULL" } 
        });
    }

    const taskId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const type = (body.task.type || "").toLowerCase();
    const proxy = process.env.TERTUYUL_PROXY || body.task.proxy;
    
    // Pilih profil rotasi
    const selectedProfile = getNextProfile();
    const profileName = path.basename(path.dirname(selectedProfile));

    tasks[taskId] = { status: "pending", taskId };
    saveTasks();
    
    // 3. Kirim respons ke bot (Pending)
    res.json({ taskId, status: "pending" });
    console.log(`[TASK] ${taskId} masuk antrean. Profil: ${profileName}`);

    // 4. Job untuk Queue
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
                    profilePath: selectedProfile 
                });

                const solution = type === "turnstile"
                    ? { token: result.token }
                    : { cf_clearance: result.cf_clearance };
                    
                tasks[taskId] = { status: "ready", taskId, solution };
                console.log(`[SUKSES] Task ${taskId} selesai (${profileName})`);
            } catch (err) {
                tasks[taskId] = { status: "error", taskId, err: { usr: "ERROR_CAPTCHA_UNSOLVABLE", api: err.message } };
                console.log(`[GAGAL] Task ${taskId} (${profileName}): ${err.message}`);
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
    console.log(`====================================`);
    console.log(`Server berjalan di port ${port}`);
    console.log(`Batas Aktif : ${MAX_ACTIVE}`);
    console.log(`Batas Antrean: ${MAX_QUEUE}`);
    console.log(`Profil aktif: ${PROFILES.length} folder terdeteksi.`);
    PROFILES.forEach(p => console.log(` - ${path.basename(path.dirname(p))}`));
    console.log(`====================================`);
});
