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
 * Browser-safe URL for a stored thumbnail: social-CDN images go through our
 * proxy; anything else (or invalid) is returned as-is / null.
 */
export function thumbSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  // TikTok CDN can't be proxied (Vercel server fetch is blocked) — load it
  // directly in the browser; the UI handles failure via onError.
  if (isTikTokCdnHost(url)) {
    return url.startsWith("https://") ? url : null;
  }
  if (isAllowedThumbHost(url)) {
    return `/api/thumb?src=${encodeURIComponent(url)}`;
  }
  return url.startsWith("https://") || url.startsWith("http://") ? url : null;
}
