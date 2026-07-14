// Helpers for the thumbnail proxy. Social CDNs (Instagram/Facebook/TikTok)
// block browser hotlinking but allow plain server-side fetches, so we proxy
// thumbnails through /api/thumb. The allowlist keeps the route from becoming
// an open proxy.

const ALLOWED_HOST_SUFFIXES = [
  ".cdninstagram.com",
  ".fbcdn.net",
  ".tiktokcdn.com",
  ".tiktokcdn-us.com",
  ".tiktokcdn-eu.com",
  ".ttwstatic.com",
  ".ytimg.com",
  ".ggpht.com",
  ".googleusercontent.com",
];

export function isAllowedThumbHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOST_SUFFIXES.some(
      (suffix) => u.hostname.endsWith(suffix) || u.hostname === suffix.slice(1),
    );
  } catch {
    return false;
  }
}

/**
 * TikTok's signed image CDN blocks server-side fetches from Vercel datacenter
 * IPs, so the /api/thumb proxy can't retrieve it (returns "Fetch failed"). These
 * URLs are NOT proxied — the browser loads them directly (best-effort), and the
 * UI falls back to the branded placeholder via onError if the load fails. We
 * therefore can't server-verify them → they're stored as "valid_unverified".
 */
export function isTikTokCdnHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return /\.tiktokcdn(-us|-eu)?\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Browser-safe URL for a stored thumbnail. ALL allow-listed social CDNs —
 * including TikTok, whose signed covers are HEIC — go through /api/thumb: the
 * server can fetch them (browsers can't hotlink), and the proxy transcodes HEIC
 * to JPEG so it renders (a browser <img> cannot decode HEIC). Anything else (or
 * invalid) is returned as-is / null.
 */
/**
 * Probe a stored CDN thumbnail URL with the EXACT same anonymous server fetch the
 * /api/thumb proxy performs (ok + image content-type). `live:false` means the
 * proxy would 404 and the UI would show the branded placeholder — i.e. the URL is
 * expired/blocked/dead even though it is syntactically valid. Never throws.
 */
export async function probeImageUrl(url: string, timeoutMs = 7000): Promise<{ live: boolean; detail: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store", headers: { Accept: "image/*" } });
    const type = r.headers.get("content-type") ?? "";
    if (r.ok && type.startsWith("image/")) return { live: true, detail: `ok ${type}` };
    return { live: false, detail: `HTTP ${r.status}${type ? ` ${type}` : ""}` };
  } catch {
    return { live: false, detail: "fetch failed/timeout" };
  }
}

export function thumbSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  // Every allow-listed social CDN — TikTok included — goes through /api/thumb:
  // the server can fetch them and the proxy transcodes TikTok's HEIC covers to
  // JPEG so the browser can actually render them.
  if (isAllowedThumbHost(url)) {
    return `/api/thumb?src=${encodeURIComponent(url)}`;
  }
  return url.startsWith("https://") || url.startsWith("http://") ? url : null;
}
