# CF

Solver API Turnstile / CF-WAF / AdsLab.

## Managed Turnstile widget

Jika cfsolve mendeteksi Cloudflare `managed` widget (program `cf_chl_out` / orchestrator,
bukan token `1.…`), endpoint mengembalikan error dengan:

```json
"err": { "usr": "CF_MANAGED_WIDGET", "hint": "..." }
```

Solver sengaja **tidak** melakukan fallback ke provider lain. Client (EarnLoop, Earnviv,
atau lainnya) yang melakukan rotasi/fallback sesuai kebijakan masing-masing. Tidak ada
environment variable khusus untuk ini.

Detail investigasi ada di `REFERENCE.md` section 10.
