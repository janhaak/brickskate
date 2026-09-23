// brickskate wake handler: a wake-on-demand front door for a Databricks App.
//
// A stopped app serves 503 at its own URL and cannot wake
// itself, so the first visitor gets an error instead of the app. This Lambda
// sits in front on an API Gateway HTTP API ($default catch-all), talks to the
// control-plane Apps API with a service principal, and holds the visitor on a
// waiting page until the app is genuinely serving.
//
//   GET /        start the app if needed, then the self-redirecting waiting page
//   GET /status  JSON {compute, app, message, ready} for the waiting page poller
//   POST /stop   with "Authorization: Bearer <token>", publish a StopRequested
//                event to EventBridge; the stop Lambda does the rest. Only
//                present when the stack has StopTokenParameterName set.
//
// Everything site-specific arrives as an environment variable: DATABRICKS_HOST,
// APP_NAME, APP_URL, DATABRICKS_CLIENT_ID, SECRET_PARAM, and optionally
// STOP_TOKEN_PARAM.

import {
  getApp,
  startApp,
  probeReady,
  isServing,
  getStopToken,
  tokenMatches,
  requestStop,
} from "./common.mjs";

const html = (body, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  body,
});

const json = (obj, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

const redirect = () => ({
  statusCode: 302,
  headers: { Location: process.env.APP_URL, "Cache-Control": "no-store" },
  body: "",
});

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    background: #f4f2ec; color: #2c2a26; padding: 24px;
  }
  .card { text-align: center; max-width: 26rem; }
  h1 { font-size: 1.5rem; font-weight: 650; margin: 20px 0 8px; }
  p { color: #6b675e; line-height: 1.5; }
  .spinner {
    width: 56px; height: 56px; margin: 0 auto;
    border: 4px solid rgba(125, 115, 95, .2); border-top-color: #7a6f5a;
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .elapsed { margin-top: 16px; font-variant-numeric: tabular-nums; font-size: .85rem; color: #a09a8d; }
  .err { color: #a4472e; }
  a { color: #7a6f5a; }
  @media (prefers-color-scheme: dark) {
    body { background: #191817; color: #e8e5df; }
    p { color: #a39e93; }
    .spinner { border-color: rgba(200, 190, 170, .15); border-top-color: #c8bda3; }
    .err { color: #e08563; }
    a { color: #c8bda3; }
  }
`;

const waitingPage = (appUrl, appName) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Waking ${esc(appName)}&hellip;</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="spinner" id="spinner"></div>
    <h1 id="headline"></h1>
    <p id="msg">Checking status&hellip;</p>
    <p class="elapsed" id="elapsed"></p>
  </div>
<script>
  const APP_URL = ${JSON.stringify(appUrl)};
  const APP_NAME = ${JSON.stringify(appName)};
  const t0 = Date.now();
  const msg = document.getElementById("msg");
  const headline = document.getElementById("headline");
  const spinner = document.getElementById("spinner");
  headline.textContent = "Waking " + APP_NAME;
  let failures = 0;
  let done = false;

  setInterval(() => {
    if (done) return;
    document.getElementById("elapsed").textContent = Math.round((Date.now() - t0) / 1000) + "s elapsed";
  }, 1000);

  function finish(headlineText, msgHtml, isError) {
    done = true;
    spinner.style.display = "none";
    headline.textContent = headlineText;
    msg.innerHTML = msgHtml;
    if (isError) msg.classList.add("err");
  }

  function stageMessage(s) {
    if (s.compute === "STOPPED" || s.compute === "STARTING") return "Starting compute\\u2026";
    if (s.compute === "ACTIVE" && s.app !== "RUNNING") return "Installing dependencies & starting the app\\u2026";
    if (s.compute === "ACTIVE" && s.app === "RUNNING") return "Almost there\\u2026";
    return "Waking up\\u2026 (" + s.compute + "/" + s.app + ")";
  }

  async function tick() {
    if (done) return;
    if (Date.now() - t0 > 300000) {
      finish("Taking longer than expected",
        'Something may be stuck. <a href="/">Try again</a>, or check the app in your Databricks workspace.', true);
      return;
    }
    try {
      const s = await (await fetch("/status", { cache: "no-store" })).json();
      failures = 0;
      if (s.ready) {
        finish("Ready", "Taking you in\\u2026");
        location.replace(APP_URL);
        return;
      }
      if (s.app === "CRASHED" || s.compute === "ERROR") {
        finish(APP_NAME + " hit a snag",
          (s.message || "The app failed to start.") + ' <a href="/">Try again</a>', true);
        return;
      }
      msg.textContent = stageMessage(s);
    } catch (e) {
      failures++;
      if (failures > 5) msg.textContent = "Connection hiccup, still trying\\u2026";
    }
    setTimeout(tick, 3000);
  }
  tick();
</script>
</body>
</html>`;

const page = () => html(waitingPage(process.env.APP_URL, process.env.APP_NAME));

const notFound = () => ({ statusCode: 404, headers: { "Cache-Control": "no-store" }, body: "Not found" });

// The app asking to be put to sleep. Authentication is a shared bearer token,
// compared in constant time; the body is optional and only echoed into the
// event as context (a reason such as "timer" or "button").
async function stop(event) {
  const expected = await getStopToken();
  if (!expected) return notFound();
  const auth = event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!tokenMatches(presented, expected)) return json({ error: "unauthorized" }, 401);
  let detail = {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body;
    if (raw) detail = JSON.parse(raw);
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const reason = typeof detail.reason === "string" ? detail.reason.slice(0, 200) : "unspecified";
  const eventId = await requestStop({ reason, requestedAt: new Date().toISOString() });
  return json({ accepted: true, eventId }, 202);
}

export async function handler(event) {
  const pathname = event.rawPath;
  const method = event.requestContext?.http?.method ?? "GET";
  try {
    if (pathname === "/stop") return method === "POST" ? stop(event) : json({ error: "POST only" }, 405);
    switch (pathname) {
      case "/": {
        const s = await getApp();
        if (isServing(s) && (await probeReady())) return redirect();
        if (s.compute === "STOPPED" || s.compute === "ERROR") {
          const r = await startApp();
          if (!r.ok) {
            const after = await getApp();
            if (after.compute === "STOPPED" || after.compute === "ERROR") {
              return page(); // the page will surface the ERROR state to the visitor
            }
          }
        }
        return page();
      }
      case "/status": {
        const s = await getApp();
        // A stop can land while someone is on the waiting page (the app's own
        // timer, a schedule). The visitor wants it up, so start it again
        // rather than leaving them polling a stopped app.
        if (s.compute === "STOPPED" || s.compute === "ERROR") await startApp();
        const ready = isServing(s) && (await probeReady());
        return json({ ...s, ready });
      }
      default:
        return notFound();
    }
  } catch (err) {
    return json({ error: String(err?.message || err) }, 502);
  }
}
