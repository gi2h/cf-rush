# CF

Solver API Turnstile / CF-WAF / AdsLab.

## Managed Turnstile widget -> CF solver internal

Jika cfsolve mendeteksi Cloudflare `managed` widget (program `cf_chl_out` / orchestrator,
bukan token `1.…`), task Turnstile dilempar ke **CF solver internal** cf-rush:

1. `cf_waf_solver.py` (soft WAF via `curl_cffi`, lalu hard browser via
   `cf_hard_solver.js` dengan `puppeteer-real-browser`),
2. tanpa proxy dari environment,
3. hasil berupa `cf_clearance` bila challenge berhasil di-clear.

Jika CF solver tidak menemukan challenge / tidak menghasilkan clearance, endpoint
mengembalikan `err.usr = "CF_MANAGED_WIDGET"` supaya client melakukan rotasi/fallback
sesuai kebijakan masing-masing.

Tidak ada key atau environment variable khusus untuk alur ini.

Detail investigasi ada di `REFERENCE.md` section 10.
