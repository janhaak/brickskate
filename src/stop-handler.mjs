// brickskate stop handler: put the Databricks App back to sleep.
//
// Invoked by EventBridge, never by a visitor: either on a schedule (StopSchedule
// in template.yaml) or because the app asked via POST /stop, which the wake
// Lambda turns into a StopRequested event (StopTokenParameterName). On Free
// Edition the platform already stops idle apps, so the schedule is optional
// there; on other workspaces it is the only thing that stops the app.
//
// Deliberately blunt: it reads the state, and if the app is not already down it
// asks the control plane to stop it. No idle detection, because the Apps API
// does not expose a last-request timestamp. If you want "stop only when quiet",
// schedule this for a time of day when quiet is a safe assumption.

import { getApp, stopApp } from "./common.mjs";

export async function handler(event = {}) {
  // "schedule" for the scheduled rule, otherwise whatever the app said in POST /stop
  const trigger = event["detail-type"] === "StopRequested" ? event.detail : { reason: "schedule" };
  const before = await getApp();
  if (before.compute === "STOPPED") {
    console.log(JSON.stringify({ action: "none", reason: "already stopped", trigger, before }));
    return { stopped: false, state: before };
  }
  // A start after the stop was requested wins. Every start redeploys the app,
  // so a deployment newer than the request means someone woke it in between
  // and this stop is stale.
  if (trigger.requestedAt && before.deployedAt && Date.parse(before.deployedAt) > Date.parse(trigger.requestedAt)) {
    console.log(JSON.stringify({ action: "none", reason: "app started after stop was requested", trigger, before }));
    return { stopped: false, stale: true, state: before };
  }

  const r = await stopApp();
  // A non-2xx here is usually benign (a stop or a deploy is already in flight),
  // so report the response and let the next scheduled run settle it.
  const state = await getApp();
  console.log(JSON.stringify({ action: "stop", trigger, httpStatus: r.status, before, after: state }));
  return { stopped: r.ok, httpStatus: r.status, state };
}
