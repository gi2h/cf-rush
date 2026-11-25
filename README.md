# CF

Solver API Turnstile / CF-WAF / AdsLab.

## Managed Turnstile fallback

Jika cfsolve mendeteksi Cloudflare `managed` widget (program `cf_chl_out` / orchestrator,
bukan token `1.…`), endpoint `/solve` otomatis memanggil Tertuyul dan tetap mengembalikan
`status:"ready"` dengan `solution.source = "tertuyul"`.

Key Tertuyul sudah disertakan sebagai default di `app.js` karena repo ini terbuka,
jadi tidak perlu environment variable agar deploy langsung bekerja. Bisa di-override lewat:

- `TERTUYUL_KEY` — opsional, override key default
- `TERTUYUL_API` — opsional, default `http://api.tertuyul.my.id`
- `TERTUYUL_TIMEOUT_MS` — opsional, default `120000`
- `TERTUYUL_POLL_MS` — opsional, default `3000`

Detail investigasi ada di `REFERENCE.md` section 10.
