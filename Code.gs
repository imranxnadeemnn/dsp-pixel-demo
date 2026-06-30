/**
 * ============================================================================
 *  DSP WEB EVENT TRACKING  —  Google Apps Script Web App backend
 * ============================================================================
 *  A no-backend, no-domain tracking solution for a programmatic DSP.
 *
 *  This single script (bound to a Google Sheet) does four jobs:
 *    1. Hosts/serves the advertiser JavaScript pixel        (?action=pixel)
 *    2. Receives & logs conversion postbacks from the pixel (?action=cv)
 *    3. Optionally forwards each conversion to the real DSP (UrlFetchApp)
 *    4. Logs/optionally redirects ad clicks                 (?action=click)
 *    +  Generates ready-to-use landing URLs                 (?action=genurl)
 *
 *  The Google Sheet is the database. Tabs: Config, Campaigns, ClickLog,
 *  ConversionLog. Run setupSheet() once from the editor to create them.
 *
 *  Attribution model: click_id based.
 *    DSP click URL  ->  advertiser landing page (?click_id=...&campaign_id=...)
 *    Pixel on LP    ->  drops first-party cookie _dsp_attr (client side)
 *    Pixel on conv  ->  reads cookie, beacons ?action=cv to THIS web app
 *    This web app   ->  logs row + forwards postback to the DSP endpoint
 * ============================================================================
 */

/* ----------------------------- CONSTANTS --------------------------------- */

var SHEET_CONFIG      = 'Config';
var SHEET_CAMPAIGNS   = 'Campaigns';
var SHEET_CLICKS      = 'ClickLog';
var SHEET_CONVERSIONS = 'ConversionLog';

// Canonical tracking parameters carried on the landing URL / postbacks.
var TRACK_PARAMS = ['click_id', 'campaign_id', 'pub_id', 'creative_id', 'sub1', 'sub2'];

// Conversion event types supported out of the box.
var EVENTS = ['landing', 'registration', 'purchase', 'custom'];

// 1x1 transparent GIF (base64) returned to image-beacon requests.
var PIXEL_GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';


/* =========================================================================
 *  HTTP ENTRY POINTS
 * ========================================================================= */

function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }   // sendBeacon fallback uses POST

function route(e) {
  e = e || {};
  var p = (e.parameter) || {};
  var action = (p.action || 'health').toLowerCase();

  try {
    switch (action) {
      case 'pixel':   return servePixel(p);        // serves the JS pixel
      case 'cv':      return handleConversion(p);  // conversion postback
      case 'click':   return handleClick(p);       // click logger/redirect
      case 'genurl':  return handleGenUrl(p);      // build a landing URL
      case 'generator': return handleGenerator(p); // Sales/CS pixel generator tool
      case 'demo':    return handleDemo(p);        // sample advertiser test page
      case 'report':  return handleReport(p);      // latest log rows as JSON
      case 'dspsink': return handleDspSink(p);     // MOCK DSP receiver (testing)
      case 'health':  return jsonOut({ ok: true, service: 'dsp-tracker', ts: now_() });
      default:        return jsonOut({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    logError_(action, err);
    // Never break the advertiser page: beacons still return a pixel.
    if (action === 'cv') return gifOut();
    return jsonOut({ ok: false, error: String(err) });
  }
}


/* =========================================================================
 *  1. SERVE THE PIXEL  (?action=pixel)
 *  Advertiser embeds:  <script src="WEBAPP_URL?action=pixel"></script>
 * ========================================================================= */

function servePixel(p) {
  var cfg = getConfig_();
  // The web app's own /exec URL, injected so the pixel knows where to beacon.
  var endpoint = publicUrl_();

  var js = PIXEL_SOURCE
    .replace('__ENDPOINT__',     endpoint)
    .replace('__COOKIE_NAME__',  cfg.cookie_name || '_dsp_attr')
    .replace('__COOKIE_DAYS__',  String(parseInt(cfg.cookie_days || '30', 10)))
    .replace('__COOKIE_DOMAIN__', cfg.cookie_domain || '');

  return ContentService
    .createTextOutput(js)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}


/* =========================================================================
 *  2. CONVERSION POSTBACK  (?action=cv)
 *  Logs the event, then forwards to the DSP endpoint if configured.
 * ========================================================================= */

function handleConversion(p) {
  var cfg = getConfig_();

  // Optional shared-secret check to stop random spam.
  if (cfg.require_key === 'TRUE' && p.key !== cfg.secret_key) {
    return gifOut(); // silently drop, but still return pixel
  }

  var event = (p.event || 'custom').toLowerCase();
  if (EVENTS.indexOf(event) === -1) event = 'custom';

  var row = {
    ts:           now_(),
    click_id:     p.click_id    || '',
    campaign_id:  p.campaign_id || '',
    pub_id:       p.pub_id      || '',   // carries {bundle_id} from the click URL
    creative_id:  p.creative_id || '',
    device_id:    p.device_id   || '',   // carries {advertising_id} from the click URL
    event:        event,
    event_name:   p.event_name  || event,   // free label for "custom"
    value:        p.value       || '',
    currency:     p.currency    || '',
    order_id:     p.order_id     || '',
    txn_id:       p.txn_id       || '',      // for de-duplication
    netw:         p.netw         || '',      // network ID, hard-coded in the pixel
    event_value:  p.event_value  || '',      // optional JSON-encoded event payload
    language:     p.language     || '',      // navigator.language
    imp_id:       p.imp_id       || '',      // impression id (view-through)
    exchange:     p.exchange     || '',      // ad exchange / supply source
    first_touch:  p.ft           || '',      // first-touch ts from cookie
    page_url:     p.url          || '',
    sub1:         p.sub1         || '',
    sub2:         p.sub2         || '',
    user_agent:   p.ua           || '',
    dsp_status:   '',
    dsp_response: ''
  };

  // Derived fields used by the postback template (and logged for reporting).
  row.event_time = row.ts;                              // {event_time}
  row.can_claim  = row.click_id ? '1' : '0';            // attributed?  {can_claim}
  row.from_imp   = row.imp_id ? '1' : '0';              // 1=view-through 0=click  {from_imp}

  // De-duplicate on txn_id (if the advertiser supplies one).
  if (row.txn_id && isDuplicate_(SHEET_CONVERSIONS, 'txn_id', row.txn_id)) {
    return gifOut();
  }

  // Forward to the real DSP endpoint, if a template is configured.
  if (cfg.dsp_postback_url) {
    var fwd = forwardToDsp_(cfg.dsp_postback_url, row);
    row.dsp_status   = fwd.status;
    row.dsp_response = fwd.body;
  }

  appendRow_(SHEET_CONVERSIONS, CONV_HEADERS, row);
  return gifOut();
}

/** Substitute {macros} in the DSP postback template and fire it server-side. */
function forwardToDsp_(template, row) {
  var url = template.replace(/\{(\w+)\}/g, function (m, k) {
    return encodeURIComponent(row[k] != null ? row[k] : '');
  });
  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    return { status: resp.getResponseCode(), body: trunc_(resp.getContentText(), 300) };
  } catch (err) {
    return { status: 'ERR', body: trunc_(String(err), 300) };
  }
}


/* =========================================================================
 *  3. CLICK LOGGER / REDIRECT  (?action=click)
 *  Optional: route the DSP click through here to log it, then bounce the
 *  user to the real landing page with the tracking params appended.
 *  DSP click URL example:
 *    WEBAPP_URL?action=click&campaign_id=123&click_id={CLICK_ID}&pub_id={PUB}
 * ========================================================================= */

function handleClick(p) {
  var camp = lookupCampaign_(p.campaign_id);
  var landing = (camp && camp.landing_url) || p.lp || '';

  var row = {
    ts:          now_(),
    click_id:    p.click_id    || '',
    campaign_id: p.campaign_id || '',
    pub_id:      p.pub_id      || '',
    creative_id: p.creative_id || '',
    sub1:        p.sub1        || '',
    sub2:        p.sub2        || '',
    landing_url: landing,
    user_agent:  (p.ua || ''),
    referrer:    (p.ref || '')
  };
  appendRow_(SHEET_CLICKS, CLICK_HEADERS, row);

  if (!landing) {
    return jsonOut({ ok: false, error: 'no landing_url for campaign_id ' + p.campaign_id });
  }

  // Append tracking params to the landing URL, then client-side redirect.
  var dest = appendParams_(landing, {
    click_id:    row.click_id,
    campaign_id: row.campaign_id,
    pub_id:      row.pub_id,
    creative_id: row.creative_id,
    sub1:        row.sub1,
    sub2:        row.sub2
  });

  var html = '<!doctype html><meta charset="utf-8">' +
             '<meta http-equiv="refresh" content="0;url=' + escAttr_(dest) + '">' +
             '<script>location.replace(' + JSON.stringify(dest) + ');</script>' +
             'Redirecting&hellip;';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* =========================================================================
 *  4. LANDING URL GENERATOR  (?action=genurl&campaign_id=123)
 *  Returns a ready-to-paste landing URL with DSP macro placeholders, so
 *  campaign managers don't hand-build query strings.
 * ========================================================================= */

function handleGenUrl(p) {
  var camp = lookupCampaign_(p.campaign_id);
  if (!camp || !camp.landing_url) {
    return jsonOut({ ok: false, error: 'unknown campaign_id ' + p.campaign_id });
  }
  // {CLICK_ID} etc. are placeholders the DSP replaces at serve time.
  var url = appendParams_(camp.landing_url, {
    click_id:    '{CLICK_ID}',
    campaign_id: p.campaign_id,
    pub_id:      '{PUB_ID}',
    creative_id: '{CREATIVE_ID}',
    sub1:        '{SUB1}',
    sub2:        '{SUB2}'
  });
  return jsonOut({ ok: true, campaign_id: p.campaign_id, advertiser: camp.advertiser, landing_url: url });
}


/* =========================================================================
 *  PIXEL GENERATOR  (?action=generator)
 *  A simple internal tool for Sales / Customer Success to generate the
 *  advertiser pixel snippet. Inputs: Network ID (netw, hard-coded into the
 *  pixel) and Event Name (e.g. landing_page, registration, purchase,
 *  add_to_cart). Outputs a ready-to-paste <script> tag.
 *  Open:  WEBAPP_URL?action=generator
 * ========================================================================= */

function handleGenerator(p) {
  var exec   = publicUrl_();
  var netw   = (p.netw || '').trim();
  var evName = (p.event || p.event_name || '').trim();
  var lp     = (p.lp || '').trim();
  var snippet  = (netw && evName) ? buildPixelSnippet_(exec, netw, evName) : '';
  var clickUrl = lp ? buildClickUrl_(lp) : '';
  return HtmlService.createHtmlOutput(generatorPage_(exec, netw, evName, snippet, lp, clickUrl))
    .setTitle('RZR Pixel Generator')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Build the click-tracking URL the DSP traffics for a campaign. {macros} are
 * the DSP's serve-time placeholders (the DSP fills them with real values).
 *   pub_id={bundle_id}  campaign_id={cid}  click_id={click_id}  device_id={advertising_id}
 */
function buildClickUrl_(landingUrl) {
  var sep = landingUrl.indexOf('?') === -1 ? '?' : '&';
  return landingUrl + sep +
    'pub_id={bundle_id}&campaign_id={cid}&click_id={click_id}&device_id={advertising_id}';
}

/** Map a free-text event name to one of the standard pixel event types. */
function eventTypeFor_(name) {
  var n = String(name).toLowerCase();
  if (n === 'landing' || n === 'landing_page' || n === 'landingpage') return 'landing';
  if (n === 'registration' || n === 'signup' || n === 'sign_up' || n === 'register' || n === 'lead') return 'registration';
  if (n === 'purchase' || n === 'sale' || n === 'order') return 'purchase';
  return 'custom';
}

/** Build the advertiser <script> snippet (raw text). */
function buildPixelSnippet_(exec, netw, name) {
  var type = eventTypeFor_(name);
  var L = [];
  L.push('<!-- RZR Conversion Pixel  |  event: ' + name + '  |  network: ' + netw + ' -->');
  L.push('<script src="' + exec + '?action=pixel"');
  L.push('        data-event="' + type + '"');
  L.push('        data-event-name="' + name + '"');
  if (type === 'purchase') {
    L.push('        data-netw="' + netw + '"');
    L.push('        data-value="REPLACE_WITH_ORDER_VALUE"');
    L.push('        data-currency="USD"');
    L.push('        data-order-id="REPLACE_WITH_ORDER_ID"');
    L.push('        data-txn-id="REPLACE_WITH_ORDER_ID"></' + 'script>');
  } else {
    L.push('        data-netw="' + netw + '"></' + 'script>');
  }
  return L.join('\n');
}

function generatorPage_(exec, netw, evName, snippet, lp, clickUrl) {
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  var o = '';
  o += '<!doctype html><html lang="en"><head><meta charset="utf-8">';
  o += '<meta name="viewport" content="width=device-width,initial-scale=1"><style>';
  o += 'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#16161d}';
  o += 'h1{font-size:21px} label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}';
  o += 'input{width:100%;padding:9px 11px;font-size:14px;border:1px solid #cfcfe0;border-radius:8px;box-sizing:border-box}';
  o += 'button{background:#3b3bff;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer;margin-top:14px}';
  o += 'textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;border:1px solid #cfcfe0;border-radius:8px;padding:12px;background:#0f1020;color:#9effd6}';
  o += '.muted{color:#777;font-size:13px} .card{border:1px solid #e4e4ef;border-radius:12px;padding:18px;margin:16px 0}';
  o += '</style></head><body>';
  o += '<h1>🧩 RZR Pixel Generator</h1>';
  o += '<p class="muted">For Sales / Customer Success. Enter the network ID and the event to track, then send the generated tag to the advertiser to paste before <code>&lt;/body&gt;</code> on the matching page.</p>';
  o += '<div class="card"><form method="get" target="_top" action="' + esc(exec) + '">';
  o += '<input type="hidden" name="action" value="generator">';
  o += '<label>Network ID <span class="muted">(hard-coded into the pixel as &amp;netw=)</span></label>';
  o += '<input name="netw" value="' + esc(netw) + '" placeholder="e.g. RZR-NW-001" required>';
  o += '<label>Event Name <span class="muted">(e.g. landing_page, registration, purchase, add_to_cart)</span></label>';
  o += '<input name="event" value="' + esc(evName) + '" placeholder="e.g. registration" required>';
  o += '<button type="submit">Generate pixel</button>';
  o += '</form></div>';
  if (snippet) {
    o += '<div class="card"><b>Pixel for “' + esc(evName) + '”</b> — paste before <code>&lt;/body&gt;</code> on the advertiser\'s ' + esc(evName) + ' page:';
    o += '<textarea id="snip" readonly rows="' + (eventTypeFor_(evName) === 'purchase' ? 9 : 6) + '">' + esc(snippet) + '</textarea>';
    o += '<button onclick="copyEl(\'snip\',\'msg\')">Copy to clipboard</button> <span id="msg" class="muted"></span>';
    if (eventTypeFor_(evName) === 'purchase') {
      o += '<p class="muted">This is a purchase pixel: ask the advertiser to replace <code>REPLACE_WITH_ORDER_VALUE</code> and <code>REPLACE_WITH_ORDER_ID</code> with the real order value and ID (or fire it dynamically with <code>rzrTrack("purchase", {value, currency, orderId, txnId})</code>).</p>';
    }
    o += '<p class="muted">Make sure the advertiser also has the <b>landing_page</b> pixel on the page your campaign links to — that is what drops the attribution cookie.</p></div>';
  }

  // ----- Click Tracking URL generator -----
  o += '<h1 style="font-size:18px;margin-top:28px">🔗 Click Tracking URL</h1>';
  o += '<p class="muted">Build the click URL the DSP traffics for a campaign. Enter the advertiser\'s landing page; the DSP macros <code>{bundle_id}</code>, <code>{cid}</code>, <code>{click_id}</code>, <code>{advertising_id}</code> are filled by the DSP at serve time.</p>';
  o += '<div class="card"><form method="get" target="_top" action="' + esc(exec) + '">';
  o += '<input type="hidden" name="action" value="generator">';
  o += '<label>Landing Page URL</label>';
  o += '<input name="lp" value="' + esc(lp) + '" placeholder="https://advertiser.com/lp" required>';
  o += '<button type="submit">Generate click URL</button>';
  o += '</form></div>';
  if (clickUrl) {
    o += '<div class="card"><b>Click URL</b> — set this as the click-through destination in the DSP:';
    o += '<textarea id="clk" readonly rows="4">' + esc(clickUrl) + '</textarea>';
    o += '<button onclick="copyEl(\'clk\',\'cmsg\')">Copy to clipboard</button> <span id="cmsg" class="muted"></span>';
    o += '<p class="muted">Macros: <code>pub_id={bundle_id}</code>, <code>campaign_id={cid}</code>, <code>click_id={click_id}</code>, <code>device_id={advertising_id}</code>. The landing page must carry the <b>landing_page</b> pixel so these are captured into the cookie.</p></div>';
  }

  o += '<script>function copyEl(id,m){var t=document.getElementById(id);t.focus();t.select();try{document.execCommand("copy");document.getElementById(m).textContent="Copied!";}catch(e){document.getElementById(m).textContent="Press Cmd/Ctrl+C to copy.";}}</' + 'script>';
  o += '</body></html>';
  return o;
}


/* =========================================================================
 *  DEMO / TEST  —  sample advertiser page served by the Web App
 *  Open:  WEBAPP_URL?action=demo&click_id=TEST123&campaign_id=1001
 *  Simulates a single advertiser-domain session: drops the attribution
 *  cookie (landing), then lets you fire registration / purchase / custom
 *  conversions that read the cookie and beacon back to ?action=cv.
 * ========================================================================= */

function handleDemo(p) {
  var endpoint = publicUrl_();
  var cfg = getConfig_();
  var cookieName = cfg.cookie_name || '_dsp_attr';

  // Test attribution values (overridable via URL params).
  var attr = {
    click_id:    p.click_id    || ('TEST-' + new Date().getTime()),
    campaign_id: p.campaign_id || '1001',
    pub_id:      p.pub_id      || 'PUB-DEMO',
    creative_id: p.creative_id || 'CR-DEMO'
  };

  var t = HtmlService.createTemplate(DEMO_HTML);
  t.endpoint   = endpoint;
  t.cookieName = cookieName;
  t.attr       = attr;
  return t.evaluate()
    .setTitle('Sample Advertiser — DSP Pixel Test')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Templated demo page. <?= ?> values are injected by handleDemo.
var DEMO_HTML =
'<!doctype html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<style>' +
'body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1a1a2e}' +
'h1{font-size:20px}.card{border:1px solid #e2e2ef;border-radius:10px;padding:16px;margin:14px 0}' +
'button{background:#3b3bff;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer;margin:4px 6px 4px 0}' +
'button.alt{background:#0a8f5b}button.gray{background:#555}code{background:#f3f3fb;padding:2px 5px;border-radius:4px;font-size:12px}' +
'#log{background:#0f1020;color:#7fffd4;font-family:monospace;font-size:12px;padding:12px;border-radius:8px;min-height:80px;white-space:pre-wrap}' +
'.muted{color:#777;font-size:13px}</style></head><body>' +
'<h1>🧪 Sample Advertiser — DSP Pixel Test Page</h1>' +
'<p class="muted">Served by your Apps Script Web App. This single page simulates one advertiser-domain session.</p>' +
'<div class="card"><b>Attribution (from landing):</b><br>' +
'click_id=<code><?= attr.click_id ?></code> &nbsp; campaign_id=<code><?= attr.campaign_id ?></code><br>' +
'pub_id=<code><?= attr.pub_id ?></code> &nbsp; creative_id=<code><?= attr.creative_id ?></code></div>' +
'<div class="card"><b>Fire conversions</b> (each reads the cookie and beacons to the Web App):<br>' +
'<button class="alt" onclick="reg()">Registration</button>' +
'<button onclick="buy()">Purchase $49.99</button>' +
'<button class="gray" onclick="cust()">Custom: add_to_cart</button></div>' +
'<div class="card"><b>Event log</b><div id="log">(landing view fires automatically on load)</div></div>' +
'<script>' +
'var ENDPOINT=<?!= JSON.stringify(endpoint) ?>;' +
'var COOKIE=<?!= JSON.stringify(cookieName) ?>;' +
'var ATTR=<?!= JSON.stringify(attr) ?>;' +
'function logln(m){var l=document.getElementById("log");l.textContent+="\\n"+m;}' +
'function setCookie(){var v={ft:Date.now(),click_id:ATTR.click_id,campaign_id:ATTR.campaign_id,pub_id:ATTR.pub_id,creative_id:ATTR.creative_id};' +
'document.cookie=COOKIE+"="+encodeURIComponent(JSON.stringify(v))+";path=/;SameSite=Lax;Secure";return v;}' +
'function beacon(params){var qs=Object.keys(params).map(function(k){return k+"="+encodeURIComponent(params[k]==null?"":params[k]);}).join("&");' +
'var url=ENDPOINT+"?"+qs;if(navigator.sendBeacon){try{if(navigator.sendBeacon(url)){logln("sent ["+params.event+"] via sendBeacon");return;}}catch(e){}}' +
'var img=new Image();img.src=url;logln("sent ["+params.event+"] via image");}' +
'function readAttr(){try{var m=new RegExp("(?:^|; )"+COOKIE+"=([^;]*)").exec(document.cookie);return m?JSON.parse(decodeURIComponent(m[1])):{};}catch(e){return {};}}' +
'function fire(event,extra){var a=readAttr();var base={action:"cv",event:event,click_id:a.click_id||"",campaign_id:a.campaign_id||"",pub_id:a.pub_id||"",creative_id:a.creative_id||"",ft:a.ft||"",url:location.href,ua:navigator.userAgent};' +
'for(var k in (extra||{}))base[k]=extra[k];beacon(base);}' +
'function reg(){fire("registration",{});}' +
'function buy(){fire("purchase",{value:"49.99",currency:"USD",order_id:"ORDER-"+Date.now(),txn_id:"ORDER-"+Date.now()});}' +
'function cust(){fire("custom",{event_name:"add_to_cart",value:"19.00",currency:"USD"});}' +
'// landing on load: drop cookie + fire landing view' +
'(function(){var v=setCookie();logln("cookie "+COOKIE+" set: click_id="+v.click_id);' +
'beacon({action:"cv",event:"landing",click_id:v.click_id,campaign_id:v.campaign_id,pub_id:v.pub_id,creative_id:v.creative_id,ft:v.ft,url:location.href,ua:navigator.userAgent});})();' +
'</script></body></html>';


/* =========================================================================
 *  MOCK DSP RECEIVER  (?action=dspsink&...)  — TESTING ONLY
 *  Stands in for a real DSP postback endpoint. Logs whatever it receives to
 *  the DSPPostbackLog tab and returns HTTP 200, so the forward round-trip can
 *  be verified without a live DSP. Point Config.dsp_postback_url here, e.g.:
 *    WEBAPP_URL?action=dspsink&cid={click_id}&event={event}&value={value}&cur={currency}&txn={txn_id}
 *  Replace with your real DSP URL in production.
 * ========================================================================= */

var DSPSINK_HEADERS = ['ts','cid','event','value','cur','txn','all_params'];

function handleDspSink(p) {
  var row = {
    ts:    now_(),
    cid:   p.cid   || p.click_id || '',
    event: p.event || '',
    value: p.value || '',
    cur:   p.cur   || p.currency || '',
    txn:   p.txn   || p.txn_id   || '',
    all_params: JSON.stringify(p)
  };
  appendRow_('DSPPostbackLog', DSPSINK_HEADERS, row);
  return jsonOut({ ok: true, received: row.cid, event: row.event, note: 'mock DSP sink' });
}


/* =========================================================================
 *  REPORT  (?action=report&n=10)  — latest log rows as JSON, for verification
 * ========================================================================= */

function handleReport(p) {
  var n = Math.min(parseInt(p.n || '10', 10) || 10, 100);
  return jsonOut({
    ok: true,
    ts: now_(),
    conversions:   tailRows_(SHEET_CONVERSIONS, n),
    clicks:        tailRows_(SHEET_CLICKS, n),
    dsp_postbacks: tailRows_('DSPPostbackLog', n)
  });
}

function tailRows_(name, n) {
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  var out = [];
  for (var i = vals.length - 1; i >= 1 && out.length < n; i--) {
    var o = {};
    for (var c = 0; c < head.length; c++) o[head[c]] = vals[i][c];
    out.push(o);
  }
  return out;
}


/* =========================================================================
 *  SHEET HELPERS
 * ========================================================================= */

var CLICK_HEADERS = ['ts','click_id','campaign_id','pub_id','creative_id','sub1','sub2','landing_url','user_agent','referrer'];
var CONV_HEADERS  = ['ts','click_id','campaign_id','pub_id','creative_id','device_id','event','event_name','value','currency','order_id','txn_id','netw','event_value','language','imp_id','exchange','first_touch','page_url','sub1','sub2','user_agent','can_claim','from_imp','dsp_status','dsp_response'];

function ss_()        { return SpreadsheetApp.getActiveSpreadsheet(); }
function now_()       { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"); }

// Public /exec URL. Under a Workspace account getUrl() returns the domain-scoped
// form (/a/<domain>/macros/...), which external visitors can't reach — strip it
// so generated pixels and beacons use the anonymous-accessible public URL.
function publicUrl_() { return ScriptApp.getService().getUrl().replace(/\/a\/[^\/]+\/macros\//, '/macros/'); }
function trunc_(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }

function getSheet_(name, headers) {
  var sh = ss_().getSheetByName(name);
  if (!sh) sh = ss_().insertSheet(name);
  if (headers && headers.length) {
    // Sync the header row so adding columns auto-migrates an existing sheet.
    var cur = sh.getLastColumn() >= 1 ? sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).getValues()[0] : [];
    var diff = false;
    for (var i = 0; i < headers.length; i++) { if (String(cur[i] || '') !== headers[i]) { diff = true; break; } }
    if (diff) { sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); sh.setFrozenRows(1); }
  }
  return sh;
}

function appendRow_(name, headers, obj) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(name, headers);
    var row = headers.map(function (h) { return obj[h] != null ? obj[h] : ''; });
    sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

/** Read the Config tab into a flat key/value object. */
function getConfig_() {
  var sh = ss_().getSheetByName(SHEET_CONFIG);
  var cfg = {};
  if (!sh) return cfg;
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    var k = String(vals[i][0] || '').trim();
    if (k) cfg[k] = String(vals[i][1] != null ? vals[i][1] : '').trim();
  }
  return cfg;
}

function lookupCampaign_(campaignId) {
  if (!campaignId) return null;
  var sh = ss_().getSheetByName(SHEET_CAMPAIGNS);
  if (!sh) return null;
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  var idIx = head.indexOf('campaign_id');
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][idIx]) === String(campaignId)) {
      var o = {};
      for (var c = 0; c < head.length; c++) o[head[c]] = vals[i][c];
      return o;
    }
  }
  return null;
}

function isDuplicate_(name, col, value) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return false;
  var vals = sh.getDataRange().getValues();
  var ix = vals[0].indexOf(col);
  if (ix === -1) return false;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ix]) === String(value)) return true;
  }
  return false;
}

function logError_(action, err) {
  try {
    var sh = getSheet_('ErrorLog', ['ts','action','error']);
    sh.appendRow([now_(), action, trunc_(String(err && err.stack || err), 500)]);
  } catch (e) {}
}


/* ----------------------------- URL UTILS --------------------------------- */

function appendParams_(base, params) {
  var pairs = [];
  for (var k in params) {
    if (params[k] !== '' && params[k] != null) {
      // Leave {MACRO} placeholders un-encoded so the DSP can substitute them.
      var v = /^\{.*\}$/.test(String(params[k])) ? params[k] : encodeURIComponent(params[k]);
      pairs.push(k + '=' + v);
    }
  }
  if (!pairs.length) return base;
  return base + (base.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
}

function escAttr_(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }


/* ----------------------------- OUTPUTS ----------------------------------- */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function gifOut() {
  // Apps Script can't stream true binary; return tiny text so the beacon
  // request completes. The pixel uses navigator.sendBeacon / Image and
  // never reads the body, so this is sufficient for logging.
  return ContentService.createTextOutput('GIF89a').setMimeType(ContentService.MimeType.TEXT);
}


/* =========================================================================
 *  ONE-TIME SETUP  —  run setupSheet() from the Apps Script editor
 * ========================================================================= */

function setupSheet() {
  // Config tab with sensible defaults.
  var cfg = getSheet_(SHEET_CONFIG, ['key', 'value']);
  if (cfg.getLastRow() < 2) {
    cfg.getRange(2, 1, 8, 2).setValues([
      ['dsp_postback_url', 'http://pb.aarki.net/pb/event?event_name={event_name}&event_value={event_value}&purchase_revenue={value}&purchase_revenue_currency={currency}&event_time={event_time}&click_time_unix={first_touch}&clk={click_id}&cid={campaign_id}&netw={netw}&imp_id={imp_id}&exchange={exchange}&user_agent={user_agent}&language={language}&advertising_id={device_id}&app_id={pub_id}&can_claim=1&event_id={txn_id}&mmp=rzrpixel'],
      ['cookie_name',      '_dsp_attr'],
      ['cookie_days',      '30'],
      ['cookie_domain',    ''],                 // leave blank = current host
      ['require_key',      'FALSE'],            // set TRUE to enforce secret_key
      ['secret_key',       Utilities.getUuid().split('-')[0]],
      ['notes',            'Web postback macros: event_name, event_value, value, currency, event_time, first_touch, click_id, campaign_id, netw, imp_id, exchange, user_agent, language, device_id, pub_id, txn_id. advertising_id={device_id}, app_id={pub_id} (=bundle_id from click), can_claim hard-coded to 1. netw hard-coded per pixel via the Pixel Generator (?action=generator).'],
      ['', '']
    ]);
  }

  // Campaigns registry with one sample row.
  var camp = getSheet_(SHEET_CAMPAIGNS, ['campaign_id', 'advertiser', 'landing_url', 'status', 'created']);
  if (camp.getLastRow() < 2) {
    camp.appendRow(['1001', 'Sample Advertiser', 'https://advertiser.example.com/lp', 'active', now_()]);
  }

  // Log tabs.
  getSheet_(SHEET_CLICKS, CLICK_HEADERS);
  getSheet_(SHEET_CONVERSIONS, CONV_HEADERS);

  SpreadsheetApp.getUi && SpreadsheetApp.getActive().toast('Setup complete. Now Deploy > New deployment > Web app.');
}

/** Adds a convenience menu to the Sheet for generating URLs. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DSP Tracker')
    .addItem('Setup / repair tabs', 'setupSheet')
    .addItem('Build landing URL…', 'promptGenUrl')
    .addItem('Open Pixel Generator…', 'showGeneratorUrl')
    .addToUi();
}

function showGeneratorUrl() {
  var url = publicUrl_() + '?action=generator';
  SpreadsheetApp.getUi().alert('Pixel Generator URL (open in a browser):\n\n' + url);
}

function promptGenUrl() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Build landing URL', 'Enter campaign_id:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var out = handleGenUrl({ campaign_id: resp.getResponseText().trim() });
  ui.alert(out.getContent());
}


/* =========================================================================
 *  THE PIXEL SOURCE  (served by servePixel; mirror of dsp-pixel.js)
 *  Placeholders __ENDPOINT__, __COOKIE_NAME__, __COOKIE_DAYS__,
 *  __COOKIE_DOMAIN__ are substituted at serve time.
 * ========================================================================= */

var PIXEL_SOURCE = [
'(function(){',
'  "use strict";',
'  var ENDPOINT = "__ENDPOINT__";',
'  var COOKIE   = "__COOKIE_NAME__";',
'  var DAYS     = parseInt("__COOKIE_DAYS__",10) || 30;',
'  var DOMAIN   = "__COOKIE_DOMAIN__";',
'  var TRACK    = ["click_id","campaign_id","pub_id","creative_id","sub1","sub2","imp_id","exchange","device_id"];',
'',
'  function qp(name){',
'    var m = new RegExp("[?&]"+name+"=([^&#]*)").exec(location.search);',
'    return m ? decodeURIComponent(m[1].replace(/\\+/g," ")) : "";',
'  }',
'  function setCookie(name,val,days){',
'    var d=new Date(); d.setTime(d.getTime()+days*864e5);',
'    var c=name+"="+encodeURIComponent(val)+";expires="+d.toUTCString()+";path=/;SameSite=Lax";',
'    if(DOMAIN) c+=";domain="+DOMAIN;',
'    if(location.protocol==="https:") c+=";Secure";',
'    document.cookie=c;',
'  }',
'  function getCookie(name){',
'    var m=new RegExp("(?:^|; )"+name+"=([^;]*)").exec(document.cookie);',
'    return m?decodeURIComponent(m[1]):"";',
'  }',
'  function readAttr(){ try{ return JSON.parse(getCookie(COOKIE)||"{}"); }catch(e){ return {}; } }',
'',
'  // Read per-page config from the <script> tag data-* attributes or window._dsp.',
'  function cfg(){',
'    var s=document.currentScript;',
'    if(!s){ var a=document.getElementsByTagName("script"); for(var i=0;i<a.length;i++){ if(/action=pixel/.test(a[i].src)){s=a[i];break;} } }',
'    var d=(s&&s.dataset)||{};',
'    var w=window._dsp||{};',
'    return {',
'      event:    (w.event||d.event||"landing").toLowerCase(),',
'      eventName:w.eventName||d.eventName||"",',
'      value:    w.value!=null?w.value:(d.value!=null?d.value:""),',
'      currency: w.currency||d.currency||"",',
'      orderId:  w.orderId||d.orderId||"",',
'      txnId:    w.txnId||d.txnId||"",',
'      netw:     w.netw||d.netw||"",',
'      eventValue: w.eventValue!=null?w.eventValue:(d.eventValue!=null?d.eventValue:"")',
'    };',
'  }',
'',
'  function beacon(params){',
'    var qs=Object.keys(params).map(function(k){return k+"="+encodeURIComponent(params[k]==null?"":params[k]);}).join("&");',
'    var url=ENDPOINT+"?"+qs;',
'    if(navigator.sendBeacon){ try{ if(navigator.sendBeacon(url)) return; }catch(e){} }',
'    var img=new Image(); img.src=url;  // fallback GET beacon',
'  }',
'',
'  function fire(){',
'    var c=cfg();',
'    var attr;',
'    if(c.event==="manual") return;',
'    if(c.event==="landing"){',
'      // First touch: capture params from the URL and drop the cookie.',
'      attr={ ft: Date.now() };',
'      for(var i=0;i<TRACK.length;i++){ var v=qp(TRACK[i]); if(v) attr[TRACK[i]]=v; }',
'      if(attr.click_id){ setCookie(COOKIE, JSON.stringify(attr), DAYS); }',
'      else { attr = readAttr(); }   // no click_id on URL: reuse existing',
'    } else {',
'      attr=readAttr();              // conversion: read attribution cookie',
'    }',
'    // Nothing to attribute to and not a landing view -> skip.',
'    if(!attr.click_id && c.event!=="landing") return;',
'',
'    beacon({',
'      action:"cv",',
'      event:c.event,',
'      event_name:c.eventName,',
'      click_id:attr.click_id||"",',
'      campaign_id:attr.campaign_id||"",',
'      pub_id:attr.pub_id||"",',
'      creative_id:attr.creative_id||"",',
'      sub1:attr.sub1||"", sub2:attr.sub2||"",',
'      imp_id:attr.imp_id||"", exchange:attr.exchange||"",',
'      device_id:attr.device_id||"",',
'      netw:c.netw, event_value:c.eventValue,',
'      language:(navigator.language||navigator.userLanguage||""),',
'      value:c.value, currency:c.currency, order_id:c.orderId, txn_id:c.txnId,',
'      ft:attr.ft||"", url:location.href, ua:navigator.userAgent',
'    });',
'  }',
'',
'  // Expose a manual API: window.dspTrack("purchase",{value:9.99,...})',
'  window.dspTrack=function(evt,opts){',
'    opts=opts||{}; window._dsp=window._dsp||{}; window._dsp.event=evt;',
'    ["eventName","value","currency","orderId","txnId"].forEach(function(k){ window._dsp[k]=opts[k]!=null?opts[k]:undefined; });',
'    fire();',
'  };',
'  window.rzrTrack=window.dspTrack;',
'',
'  if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",fire); } else { fire(); }',
'})();'
].join('\n');
