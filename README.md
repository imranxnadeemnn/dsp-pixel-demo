# RZR Web Event Tracking (Pixel)

A no-backend, no-domain **web conversion tracking & attribution** solution for the RZR programmatic DSP. It uses a **JavaScript pixel + first-party cookie** (click_id based attribution) backed by a **Google Sheet + Google Apps Script Web App** that hosts the pixel, logs events, and forwards postbacks to Aarki (`pb.aarki.net`, `mmp=rzrpixel`).

Tracks landing-page views, registrations, purchases, and custom events. Includes a **Pixel + Click-URL generator** for Sales/CS, and a hard-coded per-pixel network id (`netw`).

## How it works

```
DSP click URL (pub_id={bundle_id}&campaign_id={cid}&click_id={click_id}&device_id={advertising_id})
   └─▶ Advertiser landing page (+ pixel, data-event="landing")  → drops first-party cookie _dsp_attr
        └─▶ Conversion page (+ pixel)  → reads cookie, beacons ?action=cv
             └─▶ Apps Script Web App  → logs to Google Sheet + forwards postback to pb.aarki.net
```

## Repository contents

| File | Purpose |
|---|---|
| `Code.gs` | Apps Script Web App backend (serves pixel, logs conversions, forwards to Aarki, Pixel + Click-URL generator, `setupSheet`). |
| `dsp-pixel.js` | Human-readable source of the served pixel. |
| `advertiser-snippets.html` | Copy/paste `<script>` tags per page type. |
| `index.html` / `sample-advertiser-page.html` | Standalone demo advertiser page (GitHub Pages). |
| `Integration-Guide.md` | Internal setup & operations guide. |
| `Advertiser-Integration-Guide.md` | Client-facing integration guide. |
| `PRD-RZR-Web-Event-Tracking.md` | Product requirements (MVP + production roadmap). |
| `DEPLOYMENT-INFO.md` | Live URLs, deployment version, test results. |

## Quick start

1. Create a Google Sheet → **Extensions ▸ Apps Script** → paste `Code.gs` → run `setupSheet`.
2. **Deploy ▸ New deployment ▸ Web app** (Execute as: Me, Access: Anyone). Copy the `/exec` URL.
3. Set the Aarki postback in the `Config` tab (pre-filled by default).
4. Generate pixels/click URLs at `WEBAPP_URL?action=generator` and send to advertisers.

See `Integration-Guide.md` for full setup and `DEPLOYMENT-INFO.md` for the live deployment.

> Note: the Apps Script + Sheets backend is a pilot-grade MVP (~20k conversions/day, single-domain cookie attribution). The PRD documents a production roadmap (e.g. Cloudflare Workers + D1) that keeps the pixel and parameter contract unchanged.
