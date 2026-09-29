/** Accept only normalized local workspace and claim paths as post-login destinations. */
export function safeReturnTo(value: string | undefined): string {
  const fallback = "/dashboard";
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;

  const rawPath = value.split(/[?#]/, 1)[0];
  if (
    !rawPath ||
    rawPath.includes("%") ||
    rawPath.includes("\\") ||
    [...rawPath].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return fallback;

  const origin = typeof window === "undefined" ? "https://pingapp.invalid" : window.location.origin;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== rawPath || url.hash) return fallback;
    const allowed =
      url.pathname === "/dashboard" ||
      url.pathname.startsWith("/dashboard/") ||
      (url.pathname.startsWith("/claim/") && url.pathname.length > "/claim/".length);
    return allowed ? url.pathname + url.search : fallback;
  } catch {
    return fallback;
  }
}
