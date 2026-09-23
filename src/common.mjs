// Shared Databricks control-plane helpers for the wake and stop handlers.
//
// Zero npm dependencies: @aws-sdk/client-ssm ships with the Lambda Node.js
// runtime, and everything else is fetch + btoa from the platform.
//
// Auth is OAuth machine-to-machine (client credentials) against a service
// principal, because Databricks Free Edition has no personal access tokens.
// The client secret lives in SSM Parameter Store as a SecureString.

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { timingSafeEqual } from "node:crypto";

// Module scope = per execution environment. The waiting page's 3s polls keep
// one container warm through the whole wake sequence, so the token and the
// secret are usually already in hand.
let tokenCache = { token: null, exp: 0 };
let secretCache = null;
let stopTokenCache = null;

async function readParameter(name) {
  const r = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return r.Parameter.Value;
}

async function getClientSecret() {
  if (secretCache) return secretCache;
  return (secretCache = await readParameter(process.env.SECRET_PARAM));
}

// The bearer token that POST /stop must carry. Only read when the stack was
// deployed with StopTokenParameterName, otherwise the route does not exist.
export async function getStopToken() {
  if (!process.env.STOP_TOKEN_PARAM) return null;
  if (stopTokenCache) return stopTokenCache;
  return (stopTokenCache = await readParameter(process.env.STOP_TOKEN_PARAM));
}

function tokenRequest(secret) {
  return fetch(`${process.env.DATABRICKS_HOST}/oidc/v1/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${process.env.DATABRICKS_CLIENT_ID}:${secret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=all-apis",
  });
}

export async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  let r = await tokenRequest(await getClientSecret());
  if (r.status === 401) {
    // the secret may have been rotated in SSM since this container started
    secretCache = null;
    r = await tokenRequest(await getClientSecret());
  }
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

export async function getApp() {
  const token = await getToken();
  const r = await fetch(`${process.env.DATABRICKS_HOST}/api/2.0/apps/${process.env.APP_NAME}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`apps get failed: HTTP ${r.status}`);
  const j = await r.json();
  return {
    compute: j.compute_status?.state ?? "UNKNOWN",
    app: j.app_status?.state ?? "UNKNOWN",
    message: j.app_status?.message || j.compute_status?.message || "",
  };
}

// Non-2xx from start is usually benign (already starting or running, deploy
// pending), so callers re-check status instead of trusting this response.
export async function startApp() {
  const token = await getToken();
  return fetch(`${process.env.DATABRICKS_HOST}/api/2.0/apps/${process.env.APP_NAME}/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Same tolerance in the other direction: stopping an already stopped app is
// an error response, not a problem.
export async function stopApp() {
  const token = await getToken();
  return fetch(`${process.env.DATABRICKS_HOST}/api/2.0/apps/${process.env.APP_NAME}/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// The control plane reports RUNNING slightly before ingress serves, so this
// probe stops us redirecting anyone onto the 503 page. redirect:"manual" is
// essential: following the redirect walks into the Databricks OAuth flow and
// misreads that as readiness.
export async function probeReady() {
  try {
    const r = await fetch(process.env.APP_URL, { redirect: "manual" });
    return r.status !== 503;
  } catch {
    return false;
  }
}

export const isServing = (s) => s.compute === "ACTIVE" && s.app === "RUNNING";

// Constant-time comparison of the presented bearer token against the real one.
export function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Publish the StopRequested event that StopRequestRule routes to the stop
// Lambda. The wake Lambda never stops the app itself: keeping every stop on the
// EventBridge path means one place to look (the stop Lambda's log) whether the
// stop came from a schedule or from the app asking.
export async function requestStop(detail = {}) {
  const r = await new EventBridgeClient({}).send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "brickskate",
          DetailType: "StopRequested",
          Detail: JSON.stringify({ app: process.env.APP_NAME, ...detail }),
        },
      ],
    })
  );
  if (r.FailedEntryCount) throw new Error(`event publish failed: ${JSON.stringify(r.Entries)}`);
  return r.Entries[0].EventId;
}
