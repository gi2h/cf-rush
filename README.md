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

Endpoint `/solve` juga menerima payload dinamis minimal:

```json
{"domain":"example.com","sitekey":"1x00000000000000000000AA"}
```

`domain` boleh tanpa `https://`; server menambahkannya. Field lama
`{"task":{"type":"turnstile","websiteURL":"...","websiteKey":"..."}}`
tetap didukung. Untuk payload minimal, browser-first aktif default.

Turnstile browser solver sekarang memakai blank page + injection callback
`onloadTurnstileCallback`, hidden input `cf-response`, dan klik checkbox pada
iframe Cloudflare bila diminta. Task bisa mengirim `browserFirst: true` untuk
mencoba browser solver lebih dulu. `proxy` boleh kosong (direct) atau berisi
URL proxy HTTP/SOCKS5 ( dengan kredensial opsional ).

`GET /health` mengembalikan versi app, commit Railway, jumlah task aktif,
panjang antrean, jumlah profil, serta ketersediaan `cfsolve` dan browser runner.
Untuk menghindari `spawn EAGAIN` pada Railway, hanya satu task yang berjalan
aktif per instance (`MAX_ACTIVE=1`); task lain menunggu di antrean.

Detail investigasi ada di `REFERENCE.md` section 10–11.
