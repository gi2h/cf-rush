# CF

Solver API Turnstile / CF-WAF / AdsLab.

## Managed Turnstile widget -> browser solver -> CF solver internal

Jika cfsolve mendeteksi Cloudflare `managed` widget (program `cf_chl_out` / orchestrator,
bukan token `1.…`), task Turnstile tidak langsung gagal. cf-rush mencoba:

1. `turnstile_browser_solver.js` — browser sungguhan via `puppeteer-real-browser`,
   render widget dengan sitekey target pada halaman stub, klik bila diminta, lalu
   baca `cf-turnstile-response`. Hasil: `solution.token` + `solution.ua`,
   `solution.source = "browser_turnstile"`.
2. `cf_waf_solver.py` — soft WAF via `curl_cffi`, lalu hard browser via
   `cf_hard_solver.js`, menghasilkan `cf_clearance` bila challenge berhasil di-clear.

Proxy tetap hanya dari payload task, bukan dari environment. Jika keduanya gagal,
endpoint mengembalikan `err.usr = "CF_MANAGED_WIDGET"` supaya client melakukan
rotasi/fallback sesuai kebijakan masing-masing.

Env opsional: `CF_BROWSER_HEADLESS=0` untuk browser headful (butuh X server/Xvfb).
Tidak ada key provider captcha di repo.

Detail investigasi ada di `REFERENCE.md` section 10–11.
