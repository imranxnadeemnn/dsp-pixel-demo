/**
 * ============================================================================
 *  DSP Tracking Pixel  (advertiser-side JavaScript)
 * ============================================================================
 *  This is the human-readable source of the pixel. In production the pixel is
 *  served by the Apps Script Web App at  WEBAPP_URL?action=pixel  (the served
 *  copy is generated from PIXEL_SOURCE in Code.gs, which mirrors this file).
 *
 *  What it does
 *  ------------
 *   - On the LANDING page  : reads click_id + campaign params from the URL and
 *                            drops a first-party cookie (_dsp_attr) on the
 *                            advertiser's own domain, then fires a "landing"
 *                            postback.
 *   - On CONVERSION pages  : reads the cookie and fires a postback for the
 *                            event (registration / purchase / custom) to the
 *                            Web App, which logs it and forwards it to the DSP.
 *
 *  Attribution is click_id based and lives entirely in a same-domain cookie,
 *  so no backend on the advertiser's site is required.
 *
 *  USAGE — see advertiser-snippets.html. Two ways to set the event:
 *    1. data-event on the <script> tag.
 *    2. window._dsp = { event:"purchase", value:"9.99", ... } before the tag.
 *    3. Manual:  dspTrack("purchase", { value:"9.99", orderId:"A123" });
 * ============================================================================
 */
(function () {
  "use strict";

  /* ---- CONFIG (auto-filled when served by the Web App) ------------------ */
  // When served via ?action=pixel these are replaced with live values.
  // For self-hosting, hard-code your deployed Web App /exec URL below.
  var ENDPOINT = "__ENDPOINT__";        // e.g. https://script.google.com/macros/s/XXX/exec
  var COOKIE   = "__COOKIE_NAME__";     // default: _dsp_attr
  var DAYS     = parseInt("__COOKIE_DAYS__", 10) || 30;
  var DOMAIN   = "__COOKIE_DOMAIN__";   // blank = current host only

  var TRACK = ["click_id", "campaign_id", "pub_id", "creative_id", "sub1", "sub2", "imp_id", "exchange", "device_id"];

  /* ---- helpers ---------------------------------------------------------- */
  function qp(name) {
    var m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
  }
  function setCookie(name, val, days) {
    var d = new Date(); d.setTime(d.getTime() + days * 864e5);
    var c = name + "=" + encodeURIComponent(val) + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";
    if (DOMAIN) c += ";domain=" + DOMAIN;
    if (location.protocol === "https:") c += ";Secure";
    document.cookie = c;
  }
  function getCookie(name) {
    var m = new RegExp("(?:^|; )" + name + "=([^;]*)").exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function readAttr() { try { return JSON.parse(getCookie(COOKIE) || "{}"); } catch (e) { return {}; } }

  function cfg() {
    var s = document.currentScript;
    if (!s) {
      var a = document.getElementsByTagName("script");
      for (var i = 0; i < a.length; i++) { if (/action=pixel/.test(a[i].src)) { s = a[i]; break; } }
    }
    var d = (s && s.dataset) || {};
    var w = window._dsp || {};
    // Runtime config (window._dsp, set by dspTrack) wins over the static
    // data-* attributes on the <script> tag.
    return {
      event:      (w.event || d.event || "landing").toLowerCase(),
      eventName:  w.eventName || d.eventName || "",
      value:      w.value != null ? w.value : (d.value != null ? d.value : ""),
      currency:   w.currency || d.currency || "",
      orderId:    w.orderId || d.orderId || "",
      txnId:      w.txnId || d.txnId || "",
      netw:       w.netw || d.netw || "",                 // network id (hard-coded by the generator)
      eventValue: w.eventValue != null ? w.eventValue : (d.eventValue != null ? d.eventValue : "")
    };
  }

  function beacon(params) {
    var qs = Object.keys(params).map(function (k) {
      return k + "=" + encodeURIComponent(params[k] == null ? "" : params[k]);
    }).join("&");
    var url = ENDPOINT + "?" + qs;
    if (navigator.sendBeacon) { try { if (navigator.sendBeacon(url)) return; } catch (e) {} }
    var img = new Image(); img.src = url;   // fallback GET beacon (cross-origin safe)
  }

  /* ---- main ------------------------------------------------------------- */
  function fire() {
    var c = cfg();
    var attr;

    if (c.event === "manual") return;   // wait for an explicit dspTrack() call

    if (c.event === "landing") {
      attr = { ft: Date.now() };
      for (var i = 0; i < TRACK.length; i++) { var v = qp(TRACK[i]); if (v) attr[TRACK[i]] = v; }
      if (attr.click_id) { setCookie(COOKIE, JSON.stringify(attr), DAYS); }
      else { attr = readAttr(); }           // no click_id on URL -> keep existing
    } else {
      attr = readAttr();                     // conversion -> read attribution cookie
    }

    if (!attr.click_id && c.event !== "landing") return;  // nothing to attribute

    beacon({
      action: "cv",
      event: c.event,
      event_name: c.eventName,
      click_id: attr.click_id || "",
      campaign_id: attr.campaign_id || "",
      pub_id: attr.pub_id || "",
      creative_id: attr.creative_id || "",
      sub1: attr.sub1 || "", sub2: attr.sub2 || "",
      imp_id: attr.imp_id || "", exchange: attr.exchange || "",
      device_id: attr.device_id || "",
      netw: c.netw, event_value: c.eventValue,
      language: (navigator.language || navigator.userLanguage || ""),
      value: c.value, currency: c.currency, order_id: c.orderId, txn_id: c.txnId,
      ft: attr.ft || "", url: location.href, ua: navigator.userAgent
    });
  }

  // Manual API: dspTrack("purchase", { value:"9.99", currency:"USD", orderId:"A1", txnId:"T1" })
  window.dspTrack = function (evt, opts) {
    opts = opts || {}; window._dsp = window._dsp || {}; window._dsp.event = evt;
    // Reset per-call fields so a previous call's value/order don't leak.
    ["eventName", "value", "currency", "orderId", "txnId"].forEach(function (k) {
      window._dsp[k] = opts[k] != null ? opts[k] : undefined;
    });
    fire();
  };
  // RZR-branded alias for the advertiser-facing API (both names work).
  window.rzrTrack = window.dspTrack;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fire);
  else fire();
})();
