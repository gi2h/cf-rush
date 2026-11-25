# CF

Solver API Turnstile / CF-WAF / AdsLab.

## Managed Turnstile fallback

Jika cfsolve mendeteksi Cloudflare `managed` widget (program `cf_chl_out` / orchestrator,
bukan token `1.…`), endpoint `/solve` otomatis memakai Tertuyul dan tetap mengembalikan
`status:"ready"` dengan `solution.source = "tertuyul"`.

Environment Railway:

- `TERTUYUL_KEY` — wajib untuk fallback managed widget
- `TERTUYUL_API` — opsional, default `http://api.tertuyul.my.id`
- `TERTUYUL_TIMEOUT_MS` — opsional, default `120000`
- `TERTUYUL_POLL_MS` — opsional, default `3000`

Tanpa `TERTUYUL_KEY`, error yang dikembalikan adalah `TERTUYUL_KEY_MISSING`.
Detail investigasi ada di `REFERENCE.md` section 10.
