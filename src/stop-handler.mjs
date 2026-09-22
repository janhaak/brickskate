// brickskate stop handler: put the Databricks App back to sleep on a schedule.
//
// Invoked by an EventBridge rule (see StopSchedule in template.yaml), never by
// a visitor. On Free Edition the platform already stops idle apps, so this is
// optional there; on other workspaces it is the only thing that stops the app.
//
// Deliberately blunt: it reads the state, and if the app is not already down it
// asks the control plane to stop it. No idle detection, because the Apps API
// does not expose a last-request timestamp. If you want "stop only when quiet",
// schedule this for a time of day when quiet is a safe assumption.

import { getApp, stopApp } from "./common.mjs";

export async function handler() {
  const before = await getApp();
  if (before.compute === "STOPPED") {
    console.log(JSON.stringify({ action: "none", reason: "already stopped", before }));
    return { stopped: false, state: before };
  }

  const r = await stopApp();
  // A non-2xx here is usually benign (a stop or a deploy is already in flight),
  // so report the response and let the next scheduled run settle it.
  const state = await getApp();
  console.log(JSON.stringify({ action: "stop", httpStatus: r.status, before, after: state }));
  return { stopped: r.ok, httpStatus: r.status, state };
}
