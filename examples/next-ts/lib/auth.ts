export async function authorizePublisherRequest(request: Request): Promise<boolean> {
  const path = process.env.PUBLISHER_AUTH_CHECK_PATH;
  if (!path || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(path) || path.startsWith("/api/sponsor") || path === "/api/generate") return false;
  try {
    const result = await fetch(new URL(path, request.url), {
      headers: { cookie: request.headers.get("cookie") || "" },
      cache: "no-store",
      redirect: "manual"
    });
    return result.status === 204;
  } catch { return false; }
}
