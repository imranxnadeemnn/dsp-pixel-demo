# PRD — RZR Web Event Tracking & Attribution (Pixel)

**Product:** RZR Pixel — a JavaScript pixel + cookie web-event tracking and attribution solution for the RZR programmatic performance DSP.
**Author:** Imran Nadeem
**Status:** v1 (MVP) live · production roadmap proposed
**Last updated:** 2026-06-24

---

## 1. Overview

RZR Pixel lets RZR offer its advertisers a turnkey way to measure web conversions — landing-page views, registrations, purchases, and custom events — and attribute them back to the clicks RZR's DSP delivered. Advertisers add a single JavaScript snippet to their pages; the pixel drops a first-party cookie carrying the click identifier on landing, reads it on conversion pages, and sends a postback to RZR. RZR logs the event and forwards an attributed postback to its measurement/optimization layer.

The v1 (MVP) implementation runs entirely on Google Sheets + a Google Apps Script Web App, requiring no domain or backend of RZR's own. This proves the model end-to-end and supports pilots; the production roadmap (Section 11) replaces the Apps Script layer with a scalable backend while keeping the advertiser-facing pixel and parameter contract unchanged.

## 2. Problem statement

RZR runs lead-generation and web performance campaigns but lacks a first-party way to confirm that a click it delivered produced a downstream conversion on the advertiser's site. Without conversion signal, RZR cannot measure CPA/ROAS, optimize bidding toward converting users, or bill on performance outcomes. Advertisers, in turn, want a lightweight tag they can drop onto existing pages without engineering a server-to-server integration.

## 3. Goals and non-goals

**Goals.** Provide click-based web conversion attribution with a single advertiser-side tag; support landing, registration, purchase, and arbitrary custom events; capture conversion value and order/transaction IDs for revenue and de-duplication; forward attributed postbacks to RZR's DSP endpoint; and stand all of this up with zero RZR-owned infrastructure for the pilot.

**Non-goals (v1).** Cross-device identity resolution and server-side (independent-domain) matching; app/SDK (in-app) attribution; view-through attribution from impressions; a full self-serve advertiser UI; and fraud/IVT detection. These are addressed or scoped in the roadmap. *(Cross-domain within an advertiser's own properties is supported via link decoration — see FR-13.)*

## 4. Users and personas

The **RZR campaign manager** registers campaigns, generates tracking URLs for the DSP, and monitors conversions. The **advertiser developer/marketer** installs the pixel snippet on their pages. The **RZR DSP / optimization system** is the machine consumer of attributed postbacks. The **RZR analyst** reviews logged conversions for reporting and reconciliation.

## 5. Attribution model

Attribution is **click_id based, last-click, within a configurable lookback window** (default 30 days).

The DSP appends a unique `click_id` (plus campaign/publisher/creative identifiers) to the advertiser's landing-page URL at serve time. On the landing page, the pixel reads these parameters from the URL and writes them into a first-party cookie (`_dsp_attr`) scoped to the advertiser's own domain, recording a first-touch timestamp. On any later conversion page within the same domain and within the lookback window, the pixel reads the cookie and sends the stored `click_id` (and conversion details) to RZR, which credits the conversion to that click.

Because the cookie is written by JavaScript on the advertiser's domain, it is genuinely first-party and requires no RZR server on the advertiser's site — which is what makes the no-backend MVP possible.

**Cross-domain (link decoration).** The pixel reads the `click_id` (and other tracking params) from the page URL on *any* page, not only the landing page, and re-establishes the cookie on whatever domain it runs on. So a multi-domain funnel is supported provided the advertiser carries the params on cross-domain links (e.g. `…/checkout?click_id=…&campaign_id=…&device_id=…`) — the GA cross-domain-linker pattern. Sub-domains are covered by setting `cookie_domain`. Independent domains with no shared link, and cross-device journeys, still require server-side identity matching (roadmap).

## 6. Parameter contract

This contract is the stable interface between RZR, the pixel, and the postback layer. It must not change without versioning, because advertisers and the DSP both depend on it.

**Click / landing parameters** (on the landing URL, stored in the cookie):

| Parameter | Required | Meaning |
|---|---|---|
| `click_id` | Yes | Unique per-click identifier issued by the DSP. The attribution key. |
| `campaign_id` | Yes | RZR campaign identifier. |
| `pub_id` | No | Publisher / supply-source identifier. |
| `creative_id` | No | Creative identifier. |
| `sub1`, `sub2` | No | Free passthrough fields for advertiser/agency use. |

**Conversion parameters** (sent by the pixel, logged, and available as postback macros):

| Parameter | Required | Meaning |
|---|---|---|
| `event` | Yes | Internal type: `landing`, `registration`, `purchase`, `custom`. |
| `event_name` | Yes | Reporting name sent to the DSP (e.g. `registration`, `add_to_cart`). |
| `netw` | Yes | Network ID, **hard-coded per pixel** by the Pixel Generator; sent as `&netw=`. |
| `device_id` | No | Device/advertising id carried on the click URL (`device_id={advertising_id}`); forwarded as `advertising_id`. |
| `value`, `currency` | No | Conversion value and ISO-4217 currency. |
| `order_id` | No | Advertiser's order/lead identifier. |
| `txn_id` | No | Unique transaction id used for de-duplication (maps to postback `event_id`). |
| `event_value` | No | Optional JSON-encoded event payload. |
| `language` | Auto | `navigator.language`. |
| `imp_id` | No | Impression id (view-through), if carried on the landing URL. |
| `exchange` | No | Ad exchange / supply source, if carried on the landing URL. |
| `ft` | Auto | First-touch timestamp from the cookie (postback `click_time_unix`). |
| `url`, `ua` | Auto | Conversion page URL and user agent. |

Server-derived on forward: `event_time` (server timestamp), `can_claim` (1 if an attributed
`click_id` is present), `from_imp` (1 if an impression id is present, else 0 for click-through).

### DSP postback (production)

RZR forwards each conversion server-to-server to the Aarki postback endpoint
`http://pb.aarki.net/pb/event`, tagged `mmp=rzrpixel`. The template is the **web-relevant subset**
of Aarki's in-app postback — keeping attribution/reporting/optimization fields (`clk`, `cid`,
`event_name`, `event_value`, `purchase_revenue`, `purchase_revenue_currency`, `event_time`,
`click_time_unix`, `netw`, `imp_id`, `exchange`, `user_agent`, `language`, `advertising_id`,
`app_id`, `event_id`) and dropping in-app-only fields (install_time, idfa/idfv/android_id/aaid/oaid,
app_store_id, device_model/os_version/carrier/wifi, is_reattribution/is_reengagement/is_primary,
att_status, etc.). Mapping notes: `advertising_id={device_id}` (captured from the click URL),
`app_id={pub_id}` (the same `{bundle_id}` value the click URL carries), `can_claim` is hard-coded
to `1`, and `from_imp` is not sent. The full template is stored in the Config tab's
`dsp_postback_url` and uses `{macro}` substitution; changing it requires no code change.

## 7. Functional requirements

**FR-1 — Pixel delivery.** RZR shall host the pixel and serve it from a single URL so advertisers embed one `<script src>` tag and updates propagate centrally without advertiser redeployment.

**FR-2 — Landing capture.** On a page configured as `landing`, the pixel shall read the click/landing parameters from the page URL, persist them in a first-party cookie with the configured lookback TTL, and record a conversion event of type `landing`.

**FR-3 — Conversion capture.** On a page configured as a conversion event, the pixel shall read the attribution cookie and send a postback containing the stored `click_id`, campaign/publisher/creative IDs, the event type, and any value/currency/order/txn supplied. If no attribution cookie is present, no conversion postback is sent.

**FR-4 — Runtime override.** Values supplied at runtime via the manual API (`dspTrack(event, opts)`) shall take precedence over static `data-*` attributes on the script tag, so dynamically priced conversions report the correct event type and value. *(This was a defect found and fixed in v1.)*

**FR-5 — Event logging.** RZR shall persist every received conversion with full parameters and a server timestamp in an append-only store.

**FR-6 — DSP forwarding.** For each logged conversion, RZR shall fire a server-to-server postback to a configurable DSP endpoint template, substituting `{macro}` placeholders from the conversion record, and shall record the HTTP status and response.

**FR-7 — De-duplication.** When an advertiser supplies `txn_id`, RZR shall ignore duplicate conversions with the same `txn_id` (e.g. thank-you-page refreshes).

**FR-8 — Campaign registry & URL generation.** RZR shall maintain a registry of campaigns (id, advertiser, landing URL, status) and generate ready-to-use landing URLs with DSP macro placeholders.

**FR-9 — Click logging (optional).** RZR shall optionally route the DSP click through a logging endpoint that records the click and redirects to the landing page with parameters appended.

**FR-10 — Abuse control.** RZR shall support an optional shared-secret key on postbacks to deter spam, and shall not break the advertiser's page under any error condition (the pixel must fail silently).

**FR-11 — Pixel Generator (self-serve for Sales/CS).** RZR shall provide a web tool (`?action=generator`) where a non-technical user enters a Network ID and an Event Name and receives a ready-to-paste `<script>` snippet with `data-event`, `data-event-name`, and `data-netw` baked in (purchase pixels include value/order placeholders). The tool must render the snippet server-side so it works regardless of the Apps Script HtmlService sandbox's client-JS limitations, and must emit the public (non-domain-scoped) Web App URL so external advertisers can load it.

**FR-12 — Click URL Generator (self-serve for Sales/CS).** The same tool shall include a Click Tracking URL builder: given the advertiser's landing-page URL, it outputs the click-through URL the DSP traffics, appending `pub_id={bundle_id}&campaign_id={cid}&click_id={click_id}&device_id={advertising_id}` where `{...}` are DSP serve-time macros. These map into the pixel/cookie and ultimately the postback (`pub_id`→`app_id`, `device_id`→`advertising_id`).

**FR-13 — Cross-domain attribution (link decoration).** The pixel shall capture the tracking params from the page URL on any event (not only `landing`); when a `click_id` is present it (re)writes the first-party cookie on the current domain before firing. This lets attribution follow a user across domains when the advertiser carries the params on cross-domain links, without any RZR server on the advertiser's site. Same-domain and cross-subdomain (`cookie_domain`) behavior is unchanged.

## 8. Non-functional requirements

The pixel must be small, dependency-free, and asynchronous so it never blocks or visibly delays the advertiser's page, and must degrade silently on any error. Beacons must work cross-origin without CORS configuration (achieved via `navigator.sendBeacon` with an `Image` GET fallback). Conversion logging should be idempotent on `txn_id`. The parameter contract must be versioned and backward compatible. For privacy, the cookie stores only campaign/click identifiers and a timestamp — no PII — and the solution must be deployable in a way that respects consent (see roadmap).

## 9. v1 (MVP) architecture — Google Sheets + Apps Script

```
 DSP click ──► Advertiser LANDING page ──► pixel reads URL params,
 (click_id…)        (+ RZR pixel)            drops _dsp_attr cookie
                                                    │
 Advertiser CONVERSION page (+ pixel) ──► pixel reads cookie ──► beacon
                                                                   │
                                          ┌────────────────────────▼─────────────┐
                                          │  RZR Apps Script Web App (?action=cv) │
                                          │   • logs to ConversionLog (Sheet)     │
                                          │   • forwards postback to DSP endpoint │
                                          └───────────────────────┬───────────────┘
                                                                  ▼
                                                          DSP postback endpoint
```

The Google Sheet is the database, with tabs for `Config` (settings), `Campaigns` (registry), `ClickLog`, `ConversionLog`, and `DSPPostbackLog`. The Apps Script Web App exposes endpoints by `action`: serve the pixel (`pixel`), receive conversions (`cv`), log/redirect clicks (`click`), build landing URLs (`genurl`), report recent rows as JSON (`report`), a health check (`health`), and a built-in mock DSP receiver (`dspsink`) used for testing forwards without a live DSP.

**v1 live deployment (pilot).** Web App `/exec` deployed (execute-as-owner, public access); Sheet database initialized; advertiser sample page hosted on GitHub Pages; full flow verified end-to-end from a real web origin — landing/registration/purchase logged with correct event types and attribution, each forwarded to the mock DSP with HTTP 200.

## 10. v1 limitations

Attribution is **cookie-based per domain** — same-domain and cross-subdomain (`cookie_domain`) work out of the box, and **cross-domain works via link decoration** (the advertiser carries `click_id` on cross-domain links; FR-13). What is *not* covered without a server-side identity store: independent domains with no shared link, and cross-device journeys. **Apps Script quotas** cap throughput (notably ~20k `UrlFetchApp` calls/day and URL-fetch/execution limits), making v1 suitable for pilots and low volume, not production scale. **Browser cookie limits** (e.g. Safari ITP capping script-set cookie lifetime to ~7 days) mean the lookback window is best-effort. There is **no fraud/IVT filtering, no view-through, and no cross-device** resolution. Finally, the Apps Script HtmlService sandbox cannot itself host an interactive demo that sets cookies/beacons, and re-deploying the JS-serving endpoint can briefly 404 while it propagates — both are MVP-environment quirks, not properties of the pixel on a normal site.

## 11. Production roadmap (v2+)

The advertiser-facing pixel and the parameter contract stay identical; the server side is replaced and extended.

**Scalable backend.** Replace the Apps Script Web App with a CDN-fronted edge/serverless endpoint (e.g. Cloudflare Workers / a small autoscaling service) on an RZR-owned domain, writing to a real event store/warehouse instead of a Sheet. This removes the quota ceiling and adds low-latency global delivery of the pixel and beacon collection.

**Reliability & integrity.** Add idempotent ingestion, retry/dead-letter on DSP forwarding, structured de-duplication beyond `txn_id`, signed/HMAC postbacks, and basic bot/IVT filtering. Define SLAs for pixel availability and postback latency.

**Identity & attribution depth.** Add cross-domain support (server-set first-party cookies under an RZR subdomain, or click_id propagation), optional cross-device stitching, and configurable attribution windows/models (last-click now; consider position-based later). Evaluate view-through attribution from impressions.

**Privacy & compliance.** Integrate consent signals (TCF/GPP, regional opt-outs), document data retention and DPA terms, and ensure no PII is collected by default. Provide an advertiser-controllable consent gate before the pixel fires.

**Reporting & self-serve.** Build a reporting layer (conversions by campaign/publisher/creative/event, value, CPA/ROAS) and a self-serve advertiser console for tag generation, event configuration, and QA. Expose a conversions API for advertiser data teams.

**DSP integration.** Replace the mock sink with the production DSP postback contract, including conversion feedback into bidding/optimization and performance billing reconciliation.

## 12. Success metrics

Pilot success is measured by integration success rate (advertisers who install the pixel without RZR engineering help), conversion match rate (conversions successfully attributed to a `click_id`), postback delivery success (share of forwards returning 2xx), and end-to-end latency from conversion to DSP receipt. Business impact is measured by improved CPA/ROAS on campaigns using the pixel versus those without, and by the share of campaigns billable on verified performance outcomes.

## 13. Risks and mitigations

The main technical risk is **MVP scale** — mitigated by treating v1 as pilot-only and prioritizing the v2 backend before high volume. **Cookie/ITP erosion** of attribution windows is mitigated by short, honest lookbacks and the v2 move toward server-set first-party cookies. **Single-domain attribution** gaps are mitigated by documenting the constraint and adding cross-domain support in v2. **Privacy/regulatory** risk is mitigated by collecting no PII, integrating consent, and formalizing retention/DPA terms. **Advertiser mis-integration** (wrong event type, missing `txn_id`) is mitigated by the runtime-override fix, clear documentation, and a QA/test mode.

## 14. Open questions

What attribution window(s) and model does the DSP/optimization layer require? What is the expected conversion volume per advertiser (sizing the v2 backend)? Which regions/consent frameworks must launch support? Will RZR bill on these conversions (raising the bar for fraud filtering and reconciliation)? And what is the production DSP postback contract (fields, auth, expected response)?

## 15. Appendix — current deliverables

`Code.gs` (Apps Script backend), `dsp-pixel.js` (pixel source), `advertiser-snippets.html` (copy/paste tags), `sample-advertiser-page.html` (hosted demo), `Integration-Guide.md` (internal setup), `Advertiser-Integration-Guide.md` (client-facing), and `DEPLOYMENT-INFO.md` (live URLs and test results).
