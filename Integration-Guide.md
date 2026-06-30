# RZR Web Event Tracking — Setup & Integration Guide (internal)

The internal/operations guide for the RZR conversion-tracking solution: a **JavaScript pixel + first-party cookie** model for click-based attribution, backed by a **Google Sheet + Google Apps Script Web App** that hosts the pixel, logs events, and forwards postbacks to the **Aarki** endpoint. It tracks landing-page views, registrations, purchases, and custom events.

> Advertiser-facing instructions live in `Advertiser-Integration-Guide.md`. Product spec lives in `PRD-RZR-Web-Event-Tracking.md`. Live URLs/versions live in `DEPLOYMENT-INFO.md`.

---

## 1. How it works

```
  DSP serves ad ──click URL──▶ Advertiser LANDING page (+ RZR pixel, data-event="landing")
   (click URL carries:          │  pixel reads URL params, drops first-party cookie _dsp_attr
    pub_id={bundle_id}           │  {click_id, campaign_id, pub_id, device_id, …}
    campaign_id={cid}            ▼
    click_id={click_id}     Advertiser CONVERSION page (+ RZR pixel, data-event="registration"/…)
    device_id={advertising_id})  │  pixel reads cookie, beacons ?action=cv  ──┐
                                                                              ▼
                                          ┌──────────────────────────────────────────┐
                                          │  RZR Apps Script Web App (?action=cv)      │
                                          │   • logs row to ConversionLog              │
                                          │   • forwards postback to Aarki (UrlFetchApp)│
                                          └───────────────────────┬────────────────────┘
                                                                  ▼
                                            http://pb.aarki.net/pb/event?...&mmp=rzrpixel
```

**Key idea:** with no server on the advertiser's domain, the attribution cookie is set **by the JavaScript pixel itself** (a genuine first-party cookie on the advertiser's domain). A cookie set by the Apps Script domain couldn't be read cross-domain, so client-side cookie drop is the correct model.

**Network ID (`netw`)** is hard-coded into each pixel by the Pixel Generator (`data-netw`) and forwarded to Aarki as `&netw=`. **`device_id`** flows from the click URL (`device_id={advertising_id}`) → cookie → postback (`advertising_id`).

---

## 2. One-time setup

### Step 1 — Create the Google Sheet & script
1. Create a Google Sheet (the database). 2. **Extensions ▸ Apps Script**, paste `Code.gs`, save. 3. Run **`setupSheet`** once and authorize. It creates the tabs: `Config`, `Campaigns`, `ClickLog`, `ConversionLog`, `DSPPostbackLog` (and `ErrorLog` on first error).

### Step 2 — Configure the `Config` tab
`setupSheet` pre-fills defaults. Keys:

| key | what to set |
|---|---|
| `dsp_postback_url` | The Aarki web postback template (section 5). Pre-filled by default; edit only to change endpoint/fields. |
| `cookie_name` | Cookie name (default `_dsp_attr`). |
| `cookie_days` | Attribution window in days (default `30`). |
| `cookie_domain` | Blank = current host; `.advertiser.com` to share across sub-domains. |
| `require_key` | `TRUE` to require a shared secret on postbacks, else `FALSE`. |
| `secret_key` | The shared secret (used only if `require_key=TRUE`). |

### Step 3 — Deploy as a Web App
1. **Deploy ▸ New deployment ▸ Web app.** 2. **Execute as:** *Me*; **Who has access:** *Anyone*. 3. Copy the **Web app URL** (ends `/exec`) — your `WEBAPP_URL`. 4. Test `WEBAPP_URL?action=health` → `{"ok":true}`.

> On code changes: **Deploy ▸ Manage deployments ▸ Edit (pencil) ▸ Version: New version ▸ Deploy** keeps the same `/exec` URL. The `?action=pixel` and `?action=generator` endpoints can take ~1–3 min to propagate after a deploy.
>
> Under a Workspace account `getUrl()` returns a domain-scoped URL (`/a/aarki.com/macros/...`); the code's `publicUrl_()` strips it so generated pixels use the public `script.google.com/macros/s/.../exec` form that external advertisers can load.

---

## 3. Generate pixels & click URLs (Pixel Generator)

The fastest path for Sales / Customer Success — no hand-editing of tags or URLs.

Open `WEBAPP_URL?action=generator` (or Sheet menu **DSP Tracker ▸ Open Pixel Generator…**). Two tools:

**Conversion Pixel** — enter **Network ID** and **Event Name** (landing_page, registration, purchase, add_to_cart…). Output, e.g.:
```html
<script src="WEBAPP_URL?action=pixel"
        data-event="registration" data-event-name="registration"
        data-netw="RZR-NW-001"></script>
```
Purchase pixels also include `data-value`, `data-currency`, `data-order-id`, `data-txn-id` placeholders.

**Click Tracking URL** — enter the advertiser's **Landing Page URL**. Output:
```
https://advertiser.com/lp?pub_id={bundle_id}&campaign_id={cid}&click_id={click_id}&device_id={advertising_id}
```
Set this as the click-through destination in the DSP; the DSP fills `{bundle_id}`, `{cid}`, `{click_id}`, `{advertising_id}` at serve time.

### Campaign registry (optional, for the URL-builder API)
Add rows to **`Campaigns`** (`campaign_id, advertiser, landing_url, status, created`). Then `WEBAPP_URL?action=genurl&campaign_id=1001` returns a landing URL with macro placeholders, and the Sheet menu **Build landing URL…** does the same.

### Optional: route clicks through the tracker
To log every click in `ClickLog` and redirect to the landing page:
```
WEBAPP_URL?action=click&campaign_id=1001&click_id={click_id}&pub_id={bundle_id}&device_id={advertising_id}
```

---

## 4. Advertiser integration (the pixel)

The advertiser pastes one `<script>` tag (from the generator) per page type, just before `</body>`. Copy/paste templates are in `advertiser-snippets.html`; client-facing steps in `Advertiser-Integration-Guide.md`. The **landing_page** pixel is required (it drops the cookie); conversion pixels (registration/purchase/custom) read it. Dynamic-value conversions can fire `rzrTrack("purchase", {value, currency, orderId, txnId})` (alias `dspTrack`).

---

## 5. Postback template (Aarki, production)

Stored in Config → `dsp_postback_url`, fired server-to-server per conversion (`{macro}` substitution):

```
http://pb.aarki.net/pb/event?event_name={event_name}&event_value={event_value}&purchase_revenue={value}&purchase_revenue_currency={currency}&event_time={event_time}&click_time_unix={first_touch}&clk={click_id}&cid={campaign_id}&netw={netw}&imp_id={imp_id}&exchange={exchange}&user_agent={user_agent}&language={language}&advertising_id={device_id}&app_id={pub_id}&can_claim=1&event_id={txn_id}&mmp=rzrpixel
```

Mapping notes: `advertising_id={device_id}` (from the click), `app_id={pub_id}` (= the `{bundle_id}` the click URL carries), `can_claim` hard-coded `1`, `from_imp` not sent, `event_time` = server timestamp, `event_id` = `txn_id` (dedup), `mmp=rzrpixel` literal. It's the web-relevant subset of Aarki's in-app template (in-app-only fields like install_time, idfa/idfv/android_id/aaid/oaid, app_store_id, device_model/os_version/carrier/wifi, is_reattribution/is_reengagement/is_primary, att_status were dropped).

---

## 6. Parameters reference

**Click / landing params** (on the click URL, stored in the cookie):

| param | meaning |
|---|---|
| `click_id` | Unique per-click id. **Required** for attribution (postback `clk`). |
| `campaign_id` | RZR campaign id (postback `cid`). |
| `pub_id` | Publisher / bundle id (`pub_id={bundle_id}`; postback `app_id`). |
| `device_id` | Device/advertising id (`device_id={advertising_id}`; postback `advertising_id`). |
| `creative_id`, `imp_id`, `exchange`, `sub1`, `sub2` | Optional passthrough for reporting/optimization. |

**Conversion params** (sent by the pixel, logged to `ConversionLog`):

| param | meaning |
|---|---|
| `event` | `landing` \| `registration` \| `purchase` \| `custom` (internal type). |
| `event_name` | Reporting name sent to Aarki (e.g. registration, add_to_cart). |
| `netw` | Network id, hard-coded per pixel (`data-netw`). |
| `value`, `currency` | Conversion value and ISO currency. |
| `order_id`, `txn_id` | Order id; `txn_id` → dedup + postback `event_id`. |
| `event_value` | Optional JSON payload. |
| `language` | `navigator.language`. |
| `ft`, `url`, `ua` | First-touch ts (postback `click_time_unix`), page URL, user agent. |

Server-derived: `event_time` (server ts), `can_claim` (always sent as 1).

---

## 7. Data model (Sheet tabs)

- **Config** — `key`, `value` settings (section 2).
- **Campaigns** — `campaign_id, advertiser, landing_url, status, created`.
- **ClickLog** — `ts, click_id, campaign_id, pub_id, creative_id, sub1, sub2, landing_url, user_agent, referrer`.
- **ConversionLog** — `ts, click_id, campaign_id, pub_id, creative_id, device_id, event, event_name, value, currency, order_id, txn_id, netw, event_value, language, imp_id, exchange, first_touch, page_url, sub1, sub2, user_agent, can_claim, from_imp, dsp_status, dsp_response`.
- **DSPPostbackLog** — populated only when testing against the built-in mock sink (`?action=dspsink`); not used while pointed at Aarki.
- **ErrorLog** — `ts, action, error`.

`dsp_status` / `dsp_response` capture the HTTP result of each Aarki forward.

> Note: adding columns auto-migrates the `ConversionLog` header row (`getSheet_`); rows written *before* a migration keep their original column positions and can look shifted — cosmetic, affects only old test rows.

---

## 8. Endpoints (append to WEBAPP_URL)

| Endpoint | Purpose |
|---|---|
| `?action=health` | Liveness check |
| `?action=pixel` | Serves the JS pixel (`<script src>`) |
| `?action=generator` | Pixel + Click URL generator (Sales/CS UI) |
| `?action=cv&...` | Conversion postback (the pixel beacons here) |
| `?action=click&...` | Click logger + redirect to landing |
| `?action=genurl&campaign_id=` | Build a landing URL for a campaign |
| `?action=report&n=10` | Latest log rows as JSON (verification) |
| `?action=demo&...` | Rendered sample advertiser page (sandbox-limited) |
| `?action=dspsink` | Built-in MOCK DSP receiver (testing only) |

---

## 9. Testing the full flow

1. **Health:** `WEBAPP_URL?action=health` → `{"ok":true}`.
2. **Generator:** open `?action=generator`, generate a pixel + a click URL; confirm the snippet `src` is the public `script.google.com/macros/s/.../exec` form.
3. **Simulate a landing visit** using a click URL (params already filled), e.g. `https://acme.com/lp?pub_id=com.acme.app&campaign_id=1001&click_id=TEST123&device_id=ADV-1`. In DevTools ▸ Application ▸ Cookies, confirm `_dsp_attr` exists.
4. **Simulate a conversion** on the same domain; check `ConversionLog` for the row (device_id, netw populated) and `dsp_status`.
5. **Manual postback test:** open `WEBAPP_URL?action=cv&event=purchase&click_id=TEST123&campaign_id=1001&pub_id=com.acme.app&device_id=ADV-1&netw=RZR-NW-001&value=9.99&currency=USD&txn_id=T1` → a row should appear with `dsp_status` from Aarki.

> Against Aarki's real endpoint, a fabricated `click_id` returns HTTP 200 with `{"error":"invalid or unknown click_id"}` — expected; a real DSP-issued click_id is accepted.

---

## 10. Limitations & notes

- **Same-domain attribution** — landing and conversion pages must share a domain (or sub-domains via `cookie_domain`).
- **Apps Script quotas** — ~20,000 `UrlFetchApp` calls/day; fine for pilots/low volume. For scale, move the collect/forward layer to a real endpoint — the pixel and parameter scheme stay identical (see PRD roadmap).
- **Cookie limits** — Safari ITP caps script-set cookie lifetime (~7 days); treat `cookie_days` as best-effort.
- **Beacons** — `navigator.sendBeacon` with `Image` GET fallback; cross-origin works without CORS config.
- **Deploy propagation** — `?action=pixel` / `?action=generator` may briefly 404 or show the `/a/aarki.com/` URL for a few minutes after a new version; self-resolves.
- **Security** — set `require_key=TRUE` + `&key=SECRET` to deter spam; keep the `Campaigns` tab clean since `landing_url` drives the redirect.

---

## 11. Files in this package

| file | purpose |
|---|---|
| `Code.gs` | Apps Script backend (pixel, cv logging, Aarki forward, generators, `setupSheet`). |
| `dsp-pixel.js` | Human-readable source of the served pixel. |
| `advertiser-snippets.html` | Copy/paste `<script>` tags per page type. |
| `sample-advertiser-page.html` | Standalone demo page wired to the live deployment. |
| `Advertiser-Integration-Guide.md` | Client-facing integration guide. |
| `PRD-RZR-Web-Event-Tracking.md` | Product requirements (MVP + roadmap). |
| `DEPLOYMENT-INFO.md` | Live URLs, deployment version, test results. |
| `Integration-Guide.md` | This document. |
