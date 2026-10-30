import "server-only";

const cache = new WeakMap();
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Resolve a non-credential correlation ID from the app's authenticated session. */
export function sessionIdForRequest(request) {
  const prior = cache.get(request);
  if (prior) return prior;
  const pending = (async () => {
    const path = process.env.PUBLISHER_AUTH_CHECK_PATH;
    if (!path || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(path) ||
        path.startsWith("/api/sponsor") || path === "/api/generate") return null;
    try {
      const result = await fetch(new URL(path, request.url), {
        headers: { cookie: request.headers.get("cookie") || "" },
        cache: "no-store", redirect: "manual",
      });
      const id = result.headers.get("x-publisher-session-id");
      return result.status === 204 && ID.test(id || "") ? id : null;
    } catch { return null; }
  })();
  cache.set(request, pending);
  return pending;
}

export async function authorizePublisherRequest(request) {
  return (await sessionIdForRequest(request)) !== null;
}