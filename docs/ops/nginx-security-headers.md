# nginx security headers

For the team running the production nginx. Phase 16 moves HSTS to one owner and adds the page headers that `wa.notifynow.in` is missing today.

## 1. Set the API env

```
HSTS_BY_PROXY=true
```

Without it, `/api` answers carry Strict-Transport-Security twice: once from the API and once from nginx.

## 2. Paste into the `server { listen 443 … }` block

These go at server level. nginx drops server-level `add_header` lines in any `location` that has its own `add_header`, so repeat the block in those locations.

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

Paste this in the location that serves `index.html`:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header Permissions-Policy "microphone=(self), camera=(), geolocation=()" always;
add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self' https://connect.facebook.net https://checkout.razorpay.com; frame-src https://www.facebook.com https://*.facebook.com https://api.razorpay.com https://checkout.razorpay.com; connect-src 'self' wss://YOUR_HOST https://graph.facebook.com https://*.facebook.com https://api.razorpay.com https://lumberjack.razorpay.com; img-src 'self' data: blob: https://*.facebook.com https://*.fbcdn.net https://*.razorpay.com; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
```

Replace `YOUR_HOST` with the site's host name.

## 3. Turn the CSP on

The CSP starts as report-only because the real Meta popup and Razorpay checkout can't run in our automated tests.

1. Open the browser console on the live site and test: connect a WhatsApp number, a Razorpay top-up, a live call page (WebSocket) and recording playback.
2. If the console shows no CSP report for those, rename the header to `Content-Security-Policy` and reload nginx.

**Rollback (one line):** rename it back to `Content-Security-Policy-Report-Only` and reload nginx.

In this repo's staging template the same switch is the render variable used by `deploy/staging/scripts/render-nginx.sh`.

## 4. Check

```
npm run check:headers -- https://wa.notifynow.in
```

It tests each DNS address on its own and exits 1 on a problem. The command only sends public `GET` requests. A report-only CSP appears as a note, not a failure.

**Known problem at 1 Nov 2026:** `wa.notifynow.in` has two A records, and `45.114.245.71` fails HTTPS. Remove that record; some visitors fail until it's gone.
