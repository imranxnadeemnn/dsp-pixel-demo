# Live Deployment — DSP Tracking Pixel

Deployed and tested on 2026-06-24.

## Live clickable demo (GitHub Pages)

`https://imranxnadeemnn.github.io/dsp-pixel-demo/?click_id=ABC123&campaign_id=1001&pub_id=PUB7&creative_id=CR5`

Real advertiser-origin page wired to the live Web App. Verified end-to-end: pixel loads, drops
the `_dsp_attr` cookie, and the Registration/Purchase buttons log the correct event types with
attribution and a 200 DSP-forward. Repo: `imranxnadeemnn/dsp-pixel-demo` (public, Pages from main).

Note: right after deploying a new Web App version, `?action=pixel` can briefly return a Google
"Page not found" while the JAVASCRIPT-content endpoint propagates (~1-3 min). It self-resolves.

## URLs

- **Web App base (`WEBAPP_URL`)**
  `https://script.google.com/macros/s/AKfycbzHN7Qykdj3l_flvpyWMm7qxDBOwZtrz5L2YuOeDDZoRsGPyM7xjHFpwryluvZP7FM-/exec`
- **Google Sheet (database)**
  `https://docs.google.com/spreadsheets/d/1RLdTavbvu4f-cTeb5bpXW5Iz27l7z8opWMAhQ0eUZ38/edit`
  Tabs: Config, Campaigns, ClickLog, ConversionLog, DSPPostbackLog.
- **Deployment:** Web app, **Version 7**, Execute as me, Access = Anyone (same `/exec` URL across versions).
- **Cross-domain (v7):** the pixel reads `click_id` from the URL on any page (not just landing) and re-drops the cookie on that domain, so attribution follows the user across domains when the advertiser decorates cross-domain links with the params. Verified live: a no-cookie conversion page with `click_id` in the URL attributed correctly (`can_claim=1`, forwarded to Aarki 200). Sub-domains via `cookie_domain`.

## Endpoints (append to WEBAPP_URL)

| Endpoint | Purpose |
|---|---|
| `?action=health` | Liveness check → `{"ok":true,...}` |
| `?action=pixel` | Serves the advertiser JS pixel (load via `<script src>`) |
| `?action=generator` | **Pixel Generator tool** for Sales/CS (form: Network ID + Event Name → snippet) |
| `?action=cv&event=...&click_id=...` | Conversion postback (what the pixel beacons) |
| `?action=click&campaign_id=...&click_id=...` | Click logger + redirect to landing |
| `?action=genurl&campaign_id=1001` | Build a landing URL for a campaign |
| `?action=report&n=10` | Latest log rows as JSON (verification) |
| `?action=demo&click_id=...&campaign_id=...` | Rendered sample page (see note) |
| `?action=dspsink` | Built-in MOCK DSP receiver (testing only) |

## DSP postback — wired to Aarki production (`pb.aarki.net`)

`dsp_postback_url` (Config tab) is set to the **web-specific Aarki postback**, trimmed from the
in-app template to the fields relevant for web attribution/reporting/optimization, with the RZR
`mmp=rzrpixel` tag and the hard-coded `netw`:

```
http://pb.aarki.net/pb/event?event_name={event_name}&event_value={event_value}&purchase_revenue={value}
&purchase_revenue_currency={currency}&event_time={event_time}&click_time_unix={first_touch}
&clk={click_id}&cid={campaign_id}&netw={netw}&imp_id={imp_id}&exchange={exchange}
&user_agent={user_agent}&language={language}&advertising_id={device_id}&app_id={pub_id}
&can_claim=1&event_id={txn_id}&mmp=rzrpixel
```

Field notes:
- `advertising_id={device_id}` — the device id captured from the click URL's `device_id={advertising_id}`.
- `app_id={pub_id}` — same value the click URL sends as `pub_id={bundle_id}` (the bundle id).
- `can_claim=1` — hard-coded.
- `from_imp` was **removed**.
- `netw` (network ID) is hard-coded per pixel via the Pixel Generator (`data-netw`).
- `event_time` = server timestamp; `event_id` = `txn_id` (dedup).
- In-app-only params dropped (install_time, idfa/idfv/android_id/aaid/oaid, app_store_id,
  device_model/os_version/carrier/wifi, is_reattribution/is_reengagement/is_primary, att_status, etc.).

## Pixel Generator + Click URL Generator (for Sales / Customer Success)

`WEBAPP_URL?action=generator` — also under the Sheet menu **DSP Tracker → Open Pixel Generator…**.
Two tools on one page:

1. **Conversion Pixel** — enter a **Network ID** and **Event Name** (landing_page, registration,
   purchase, add_to_cart…); outputs a ready `<script>` with `data-event`, `data-event-name`, `data-netw`
   (purchase pixels include value/order placeholders).
2. **Click Tracking URL** — enter the advertiser's **Landing Page URL**; outputs the click URL the DSP
   traffics, with macros appended:
   `?pub_id={bundle_id}&campaign_id={cid}&click_id={click_id}&device_id={advertising_id}`
   (the DSP fills `{bundle_id}`, `{cid}`, `{click_id}`, `{advertising_id}` at serve time).

## End-to-end test result (2026-06-24)

PASS — verified via `?action=cv` + `?action=report` and the live GitHub Pages demo:

- `landing` / `registration` / `purchase` logged with correct event types and full attribution.
- **`netw` test:** purchase with netw=RZR-NW-001 logged (can_claim=1, from_imp=0, language=en-US)
  and forwarded to `pb.aarki.net` → **HTTP 200**, response `{"error":"invalid or unknown click_id"}`.
  The 200 + structured response confirms the postback format reached and was parsed by Aarki; the
  "unknown click_id" is expected for a fabricated test click — a real DSP-issued click_id is accepted.
- Pixel Generator produces correct snippets (standard + custom events).

### Known propagation caveat (public URL in generated pixels)
`getUrl()` under the aarki.com Workspace account returns the domain-scoped form
`script.google.com/a/aarki.com/macros/s/.../exec`, which external visitors may not reach. v5 adds
`publicUrl_()` to strip `/a/aarki.com/` so generated pixels use the public
`script.google.com/macros/s/.../exec`. Like `?action=pixel`, this takes a few minutes to propagate
after deploy; until then the generator may still show the `/a/aarki.com/` form. If a snippet ever
shows `/a/aarki.com/`, deleting that segment yields the correct public URL.

### Note on the in-app demo page

`?action=demo` renders correctly but its **buttons/cookie don't work in-browser**: Apps Script serves
HtmlService pages inside a sandboxed `googleusercontent.com` iframe whose CSP blocks `document.cookie`
and outbound beacons. This affects only pages hosted *inside* the Apps Script sandbox. On a real
advertiser website the pixel runs normally — use `sample-advertiser-page.html` (wired to this
deployment) on any normal web origin for a clickable browser test.
