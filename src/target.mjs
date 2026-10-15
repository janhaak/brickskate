// Where to send a visitor once the app is serving: the path and query they
// asked the front door for, so deep links and bookmarks survive a wake.
//
// Same-app relative only. Anything that could steer the browser off the app's
// own origin, or that we cannot reason about, collapses to "/":
//   - the path must start with exactly one "/" and contain no "//"
//   - no scheme, no backslash, no control characters, checked on the raw path
//     and on its percent-decoded form (so %2F%2F and %5C are caught too)
//   - path and query may only use RFC 3986 URL characters, which also keeps
//     quotes, angle brackets and spaces out of the waiting page's HTML
//   - the combined target is capped at MAX_TARGET characters
// appLocation then checks the resolved URL's origin as a last line.
// Pure, no dependencies, so it is unit-tested without the AWS SDK.

export const MAX_TARGET = 2048;

const URL_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function pathIsSafe(p) {
  return (
    typeof p === "string" &&
    p.startsWith("/") &&
    !p.includes("//") &&
    !p.includes("\\") &&
    !CONTROL.test(p) &&
    !SCHEME.test(p)
  );
}

export function safeTarget(rawPath, rawQueryString = "") {
  const q = typeof rawQueryString === "string" ? rawQueryString : "";
  if (!pathIsSafe(rawPath) || !URL_CHARS.test(rawPath) || !URL_CHARS.test(q)) return "/";
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return "/";
  }
  if (!pathIsSafe(decoded)) return "/";
  const target = q ? `${rawPath}?${q}` : rawPath;
  return target.length > MAX_TARGET ? "/" : target;
}

// Absolute app URL for a safe target, always on APP_URL's origin.
export function appLocation(appUrl, target) {
  const base = new URL(appUrl);
  try {
    const u = new URL(appUrl.replace(/\/+$/, "") + target);
    if (u.origin === base.origin) return u.href;
  } catch {
    /* fall through */
  }
  return base.origin + "/";
}
