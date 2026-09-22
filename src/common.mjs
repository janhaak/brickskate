// Shared Databricks control-plane helpers for the wake and stop handlers.
//
// Zero npm dependencies: @aws-sdk/client-ssm ships with the Lambda Node.js
// runtime, and everything else is fetch + btoa from the platform.
//
// Auth is OAuth machine-to-machine (client credentials) against a service
// principal, because Databricks Free Edition has no personal access tokens.
// The client secret lives in SSM Parameter Store as a SecureString.

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// Module scope = per execution environment. The waiting page's 3s polls keep
// one container warm through the whole wake sequence, so the token and the
// secret are usually already in hand.
let tokenCache = { token: null, exp: 0 };
let secretCache = null;

async function getClientSecret() {
  if (secretCache) return secretCache;
  const r = await new SSMClient({}).send(
    new GetParameterCommand({ Name: process.env.SECRET_PARAM, WithDecryption: true })
  );
  return (secretCache = r.Parameter.Value);
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
