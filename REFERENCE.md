# SatoshiFaucet Automation — Reference (11–12 Nov 2026)

Account: `gi2h370@gmail.com` • Koin: `ltc` • Faucet: https://satoshifaucet.io/faucet/currency/ltc
Repo: `/data/data/com.termux/files/home/python-scripts`
Target: klaim otomatis nonstop, login via AdsLab, captcha gambar `sf_cosmos`

---

## 1. Ringkasan Kronologis

### Fase 1 — Login berhasil & klaim pertama (@ 19:00)
- Login via French residential proxy (`gate-eu.vaultproxies.com`, sticky SID `life-7200`) berhasil.
- Direct Indonesian IP waktu itu **tidak** di-flag oleh site (VPN detection tidak trigger) — dashboard 200.
- `/faucet` sempat 200 → klaim berhasil via direct Chromium + cloudscraper.
- Klaim sukses (38→39→40→41→42→43/2000), harvest template setelah PASS.

### Fase 2 — CF escalation (@ 20:30+)
- Site mulai memblokir `/faucet` untuk semua proxy/IP. Judul selalu "Just a moment...".
- `cf-mitigated: challenge` di response header (server Cloudflare).
- Token 2captcha-style (AdsLab/Tertuyul) **tidak** membantu — challenge-nya **managed interactive**.
- Setiap 10x claim muncul CF "normal"; ketika IP terakumulasi fatigue → interactive challenge (klik Turnstile diperlukan).

### Fase 3 — Analisis jaringan
| Uji | Hasil |
|---|---|
| Tertuyul AdsLab via direct | ✅ OK (16 dtk) |
| Tertuyul AdsLab via proxy Prancis | ✅ OK (11 dtk) |
| Tertuyul turnstile pandafaucet | ✅ OK (6 dtk) |
| CF challenge via Tertuyul | ❌ `ERROR_CAPTCHA_UNSOLVABLE` |
| Login (AdsLab+proxy) | ✅ selalu OK |
| `/dashboard` (proxy) | ✅ 200 |
| `/faucet` (proxy, semua currency) | ❌ 403 CF challenge (`cf-mitigated: challenge`) |
| `/faucet` (direct) | ❌ 403 CF challenge |
| Browser fallback (PAC) | ✅ CF homepage ter-clear, disuntik cookie sesi, tapi `/faucet` redirect → `/dashboard` |
| Browser direct (flagged) | ❌ test_faucet hang "Just a moment..." sampai 120 dtk |

### Fase 4 — Root cause
1. CF WAF menerima lalu-lintas, tapi challenge `/faucet` tipe **managed interactive**; IFRAME Turnstile tidak pernah ter-render di browser kami karena `challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/...` request di-abort (`ERR_ABORTED` / `ERR_CONNECTION_RESET` / `ERR_TUNNEL_CONNECTION_FAILED`).
2. VPN/proxy detection (site-side) memaksa login lewat proxy Prancis; direct IP flagged ("VPN & Proxy Detected!") sehingga login direct ditolak.
3. Setelah ~6 klaim beruntun, CF escalation membuat challenge interaktif — klik human diperlukan, bukan token.
4. `cf_chl_rc_ni=2` (challenge retry counter) — naik setiap kegagalan.

---

## 2. Fix Yang Diterapkan

### `satoshifaucet-noproxy.py`
- Import `solve_cf_challenge`; `_proxy_dict(p)` helper (string → dict requests.proxies)
- `Bot.try_cf_tertuyul()` — kirim CF challenge ke Tertuyul via proxy; dipanggil di `faucet()` (awal blok 403) dan `claim_via_browser()` (top)
- Login AdsLab via **proxy** (`proxies=_proxy_dict(self.proxy)`)
- Rotasi SID **hanya saat CF bandel** (attempt > 0), bukan setiap klaim (mencegah trigger WAF)
- `session_valid()` — validasi faucet server-side: `/dashboard` 200 + `/faucet` 200 dengan `csrf_token_name`; di--smoketest
- `claim_via_browser()` — browser claim daemon (proot Ubuntu + Xvfb via `xvfb-run`); rotasi SID bila challenge/flow gagal; polling daily counter 10× (sw-minna)
- Singleton lock `sf-noproxy-state.json.lock` — mencegah 2 instansi berbarengan
- `harvest_from_pass` — template bank dipanen setelah PASS
- Template solver body `claim_cycle` — sub-theories via PAC (challenge DIRECT, sisanya proxy)

### `tertuyul_solver.py`
- `import re, time`
- Semua API menerima `proxies=` dict; `_poll()` dan `get_balance()` idem
- **`solve_cf_challenge(pageurl, html, timeout, proxies)`** — ekstrak sitekey dari `api.js` (`turnstile/v0/g/<sitekey>/api.js`), panggil `solve_turnstile(...)` Tertuyul; full-flow via proxy

### `satoshifaucet-final.py`
- Single-file runner: cek tools (python, proot-distro, xvfb-run), mulai Xvfb :99 fallback, bersihkan lock Chromium, loop nonstop (auto-restart jika crash, jeda 15s), live log ke `sf-run.log`/`sf-noproxy.log`

### `browser_claim.js`
- PAC mode (`CF_PAC=1` + `gw.pac`) — homepage CF clear → inject session cookies → goto `/faucet`
- Client protocol: `init | challenge | check | verify | page | anchor | quit` (stdin JSON-lines)
- `fetch('/cosmos/challenge/faucet_ltc')` via `page.evaluate` → base64 gambar
- `postForm` via fetch (CF/check/verify)
- Turnstile click otomatis (max 12, center iframe)
- Profil persisten `/tmp/chrome-claim-profile` (browser nyata, trust dots)

### `gw.pac`
```javascript
function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, "challenges.cloudflare.com")) return "DIRECT";
  if (dnsDomainIs(host, "satoshifaucet.io") && shExpMatch(url, "*cdn-cgi/*")) return "DIRECT";
  return "PROXY gate-eu.vaultproxies.com:80";   // atau gate-as
}
```

### PAC + login + claim full flow
1. `detect_geo` (proxy-aware) → fingerprint konsisten (FR: Europe/Paris / fr-FR)
2. Proxy Prancis login via AdsLab Tertuyul (SID baru = IP fresh) — lolos VPN detection (site reads IP not flagged for VPN quirks)
3. Browser claim: PAC challenge DIRECT, main traffic proxy → CF clear → cookies inject → `/faucet`
4. `/cosmos/challenge` via fetch (XHR) → solver template; if confident → `/cosmos/check` → PASS → `/faucet/verify` → polling daily counter

---

## 3. Masih Terblokir (state saat ini)

- **Semua currency /faucet → 403 CF challenge** (`cf-mitigated: challenge` header) untuk semua proxy/IP (diuji: ltc, ton, doge, usdt, btc, sol, eth)
- Tertuyul **tidak** bisa solve challenge ini (`ERROR_CAPTCHA_UNSOLVABLE`, managed interactive ≠ public Turnstile widget)
- Browser claim kini mencapai `/dashboard` (HTTP 200) tetapi **tidak** `/faucet` (307 → /dashboard, atau 403 challenge)
- Dashboard normal tanpa pesan blokir — hanya redirect paksa (site-side). Bukan akun di-suspend ("banned"/"suspended" tidak ada).

### Conclusion
CF escalation phase — **semua IP di list user (direct + French/French/UAE residential) now flagged**. Solusi: (a) tunggu CF cooldown (jam–hari), (b) IP ISP residential rumah yang belum fatigue), (c) klaim manual 1× di browser normal untuk reset flag akun, (d) jika direct IP rumah ISP clean, direct path akan berjalan lagi seperti 19:47‑20:30.

---

## 4. File Referensi

| File | Fungsi |
|---|---|
| `satoshifaucet-noproxy.py` | bot utama (~1400 baris) |
| `satoshifaucet-final.py` | single-file runner (Xvfb, cek, loop, log) |
| `run-satoshifaucet.sh` | bash runner alternatif |
| `tertuyul_solver.py` | client Tertuyul (2captcha-style) |
| `browser_claim.js` | daemon klaim via Chromium proot+Xvfb (PAC) |
| `gw.pac` | PAC: CF challenge DIRECT, rest proxy |
| `cf_solve.js` | Xvfb CF solve fallback |
| `sf-noproxy-state.json` | cookie sesi + proxy (login persistence) |
| `sf-status.json` | daily counter, claims_ok, last_claim_ts |
| `sf-noproxy.log` / `sf-noproxy.stdout` | log runtime |
| `archive/` / `archive_raw/` / `archive_index.jsonl` | data klaim per gambar |
| `cosmos-templates.json` | template bank (harvest PASS) |

---

## 5. Cara Menjalankan

```bash
# satu-satunya langkah (men-start Xvfb, cek tools, loop nonstop):
cd ~/python-scripts
python satoshifaucet-final.py

# atau single cycle untuk tes:
python satoshifaucet-noproxy.py --once

# analisa gambar + koordinat:
python satoshifaucet-noproxy.py --look c-cosmos.png   # PAKAI path terakhir

# rebuild template bank dari PASS-claims tervalidasi:
python build_template_bank.py
```

Stop aman:
```bash
pgrep -f satoshifaucet-final.py   # cari PID Python (bukan node/proot)
kill <pid>
```

---

## 6. Halaman: Dashboard sebagai "redirect"

Saat ini `/faucet/currency/ltc` yang diretasi:
- `allow_redirects=False`: **403**, header `cf-mitigated: challenge`, body `Just a moment...`
- `allow_redirects=True`: **403**, `cf-ray`, `server: cloudflare`
- Nama kunci: `__cf_chl_rc_ni` (challenge retry counter, >1 berarti CF escalation aktif)
- Browser PAC: cookies `cf_clearance` terset → `/faucet/...` clears → **redirect ke `/dashboard`** (title `SatoshiFaucet | Dashboard`, htmlLen 8254–146825) — normal user tidak melihat faucet.
- Dashboard menunjukkan `Faucet LTC` link dan bukti pembayaran — tapi tombol klaim faucet tidak ada untuk sesi ini.

---

## 7. Pelajaran & Perubahan ke Depan

1. Jangan rotasi SID setiap klaim (menyebabkan WAF); rotasi hanya jika CF gagal (confirmed earlier fix)
2. Pastikan `claim_via_browser` polling counter cukup lama (206s) sebelum deklarasi gagal
3. CF escalation terjadi setelah ~5 klaim cepat via IP+CAPTCHA fatigue; pacing CLAIM_GAP=75s menghindari fatigue terus menerus (tapi tidak menghilangkan challenge sepenuhnya)
4. Solusi terbaik jangka panjang: **Wa5ifi rumah — IP residential ISP** — klaim via direct path terbukti paling cepat & paling sedikit trigger WAF
5. Tertuyul berguna untuk **AdsLab login** (terbukti ✅), bukan untuk **CF interactive challenge**
6. Template solver Image captcha cukup andal (conf ≥0.90, hmin≥0.90, cmin≥0.70, 5-fold CV 100%)

---

## 8. Daftar IP yang Di-flag (records)

### Direct (Indonesia) — flagged "VPN & Proxy Detected" / CF challenge
- `103.156.14.227` — CI Local
- `203.78.125.245` — XL-Axiata
- `112.215.148.146` — XL-Axiata (East Jakarta)
- `112.215.148.170` — XL-Axiata

### Proxy (French residential) — login OK, /faucet challenge 403
- `gate-eu.vaultproxies.com` (geo-fr sess-*) — semua SID dicoba (SID berubah-ubah, geosasi SID acak baru)
- `gate-as.vaultproxies.com` — semua SID dicoba
- `gate-us.vaultproxies.com` — WAF-block ("Sorry, you have been blocked")

### Dashboard (kapan pun)
`/dashboard` selalu 200 — bisa ditampilkan sebagai "ora-ora" (deceptive pre-check) saat CF block active.

---

## 9. Note Integritas

- Akun tidak di-suspend ("Login OK" setiap kali)
- Log menunjukkan `[LOGIN] OK ✅` untuk setiap sesi
- Tidak ada "banned"/"suspended"/"insufficient" di dashboard
- Semua header `Cf-Mitigated: challenge` — murni Cloudflare
- Daily klaim 43→46/2000 (pada saat direct route masih bekerja)
- CEK status: `sf-status.json`

---

## 10. EarnLoop Turnstile — managed widget mode (25 Nov 2026)

Gejala dari EarnLoop ke `gi8/gi9.up.railway.app`:

```
POST returned HTTP 200 OK; saved ~8 KB
Third response: not complete; program strings
["window", "_cf_chl_opt", "widgetId", "source", "postMessage", "parent",
 "frMd", "fail", "event", "code", ..., "cloudflare-challenge", "cfChlOut"]
```

Investigasi artefak cfsolve (`options.json`, `iframe.html`) menunjukkan Cloudflare mengirim
`mode: managed` dan `chl_api_m`, bukan widget `normal`. Program ketiga adalah orchestrator
challenge page yang mengirim `cf_chl_out`, bukan program `event:"complete"` dengan token
`1.…`. Jadi cfsolve tidak bisa menghasilkan `cf-turnstile-response` dari mode ini, berapapun
profil/attempt-nya. `--blank-page` juga tetap mendapat mode `managed`.

Ini bukan bugs scraping EarnLoop dan bukan bisa diperbaiki dengan proxy: Railway wajib
tanpa proxy, dan justru IP Railway yang membuat Cloudflare memilih mode managed.

Penanganan yang dipakai:

- `app.js` hanya menandai error ini sebagai `err.usr = "CF_MANAGED_WIDGET"` + `hint`.
  Solver **tidak** melakukan fallback ke provider lain; rotasi/fallback diserahkan
  sepenuhnya ke client (EarnLoop, Earnviv, atau lainnya).
- Tidak ada key/env khusus di repo untuk kasus ini.
- `fp/earnloop-final.py` mendeteksi penanda managed, mencoba gi8/gi9 sekali, lalu
  melakukan fallback sesuai kebijakan EarnLoop (Tertuyul), tanpa menunggu 3x fail penuh.
- Tertuyul berhasil menghasilkan token EarnLoop untuk sitekey
  `0x4AAAAAAGCiUxIHxufSgUzL` (token length ~645) dalam ~18 detik.
