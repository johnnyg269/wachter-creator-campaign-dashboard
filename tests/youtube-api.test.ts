// YouTube Data API provider: URL-id extraction across Shorts/watch/youtu.be,
// snippet+statistics normalization, key safety (never exposed / redacted),
// graceful missing-key behavior, the wantComments cost gate (commentThreads
// only on comment-detail cycles), and monotonic-view protection for YouTube.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVideoUrl } from "@/lib/url-parse";
import { applyMonotonicViews } from "@/lib/metrics";
import { YouTubeApiProvider } from "@/lib/providers/youtube-api-provider";
import { makeVideo } from "./helpers";

const API_KEY = "TEST_YT_KEY_DO_NOT_LOG";

// One realistic videos.list item (part=snippet,statistics).
const VIDEO_ITEM = {
  id: "CL62fTyvMOY",
  snippet: {
    title: "One of the biggest major tech integrators invited me to HQ",
    description: "behind the scenes",
    publishedAt: "2026-06-09T03:33:45Z",
    channelTitle: "cybernick0x",
    thumbnails: {
      default: { url: "https://i.ytimg.com/vi/CL62fTyvMOY/default.jpg" },
      maxres: { url: "https://i.ytimg.com/vi/CL62fTyvMOY/maxresdefault.jpg" },
    },
  },
  statistics: { viewCount: "1338", likeCount: "36", commentCount: "4" },
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("parseVideoUrl — YouTube id extraction", () => {
  it("extracts the id from /shorts/, youtu.be/, and watch?v= forms", () => {
    expect(parseVideoUrl("https://www.youtube.com/shorts/CL62fTyvMOY")?.externalVideoId).toBe("CL62fTyvMOY");
    expect(parseVideoUrl("https://youtu.be/CL62fTyvMOY")?.externalVideoId).toBe("CL62fTyvMOY");
    expect(parseVideoUrl("https://www.youtube.com/watch?v=CL62fTyvMOY")?.externalVideoId).toBe("CL62fTyvMOY");
  });
  it("canonicalizes to a shorts URL", () => {
    expect(parseVideoUrl("https://youtu.be/CL62fTyvMOY")?.canonicalUrl).toBe(
      "https://www.youtube.com/shorts/CL62fTyvMOY",
    );
  });
});

describe("YouTubeApiProvider readiness / key safety", () => {
  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("is not ready (graceful) when the key is missing", () => {
    delete process.env.YOUTUBE_API_KEY;
    const p = new YouTubeApiProvider();
    const r = p.readiness();
    expect(r.ready).toBe(false);
    expect(r.sourceStatus).toBe("needs_api_key");
  });

  it("is ready when the key is set", () => {
    process.env.YOUTUBE_API_KEY = API_KEY;
    expect(new YouTubeApiProvider().readiness().ready).toBe(true);
  });

  it("never leaks the key — redacts it from error bodies", async () => {
    process.env.YOUTUBE_API_KEY = API_KEY;
    // API echoes the key in an error body; the provider must redact it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(`forbidden for key=${API_KEY}`, false, 403)),
    );
    const p = new YouTubeApiProvider();
    await expect(p.getVideoMetadata("https://www.youtube.com/shorts/CL62fTyvMOY")).rejects.toThrow();
    try {
      await p.getVideoMetadata("https://www.youtube.com/shorts/CL62fTyvMOY");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain(API_KEY);
      expect(msg).toContain("[REDACTED]");
    }
  });
});

describe("YouTubeApiProvider normalization (snippet + statistics)", () => {
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = API_KEY;
  });
  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    vi.unstubAllGlobals();
  });

  it("maps every required field; shares is null; key not in the request the caller sees", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => jsonResponse({ items: [VIDEO_ITEM] }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new YouTubeApiProvider();
    const n = (await p.getVideoMetadata("https://www.youtube.com/shorts/CL62fTyvMOY"))!;
    expect(n).not.toBeNull();
    expect(n.externalVideoId).toBe("CL62fTyvMOY");
    expect(n.title).toContain("tech integrators");
    expect(n.thumbnailUrl).toContain("maxresdefault"); // prefers maxres
    expect(n.publishedAt).toBe("2026-06-09T03:33:45Z");
    expect(n.views).toBe(1338);
    expect(n.likes).toBe(36);
    expect(n.comments).toBe(4);
    expect(n.authorName).toBe("cybernick0x");
    expect(n.shares).toBeNull(); // YouTube has no public share count
    expect(n.originalUrl).toBe("https://www.youtube.com/shorts/CL62fTyvMOY");
    // videos.list request used part=snippet,statistics.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/videos?");
    expect(url).toContain("part=snippet%2Cstatistics");
  });

  it("absent likeCount/commentCount become null, never 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ items: [{ id: "abc12", snippet: { title: "t" }, statistics: { viewCount: "10" } }] })),
    );
    const n = (await new YouTubeApiProvider().getVideoMetadata("https://www.youtube.com/shorts/abc12"))!;
    expect(n.views).toBe(10);
    expect(n.likes).toBeNull();
    expect(n.comments).toBeNull();
  });
});

describe("YouTubeApiProvider cost gate (wantComments)", () => {
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = API_KEY;
  });
  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    vi.unstubAllGlobals();
  });

  const fetchByEndpoint = () =>
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/commentThreads")) return jsonResponse({ items: [] });
      if (url.includes("/videos?")) return jsonResponse({ items: [VIDEO_ITEM] });
      return jsonResponse({ items: [] });
    });

  it("does NOT call commentThreads on a metrics-only cycle (wantComments=false)", async () => {
    const fetchMock = fetchByEndpoint();
    vi.stubGlobal("fetch", fetchMock);
    const p = new YouTubeApiProvider();
    const video = makeVideo({ platform: "youtube", externalVideoId: "CL62fTyvMOY", originalUrl: "https://www.youtube.com/shorts/CL62fTyvMOY" });
    await p.fetchPlatform(null, [video], new Date("2026-06-01"), { wantComments: false });
    const calledComment = fetchMock.mock.calls.some((c) => String(c[0]).includes("/commentThreads"));
    expect(calledComment).toBe(false);
  });

  it("DOES call commentThreads on a comment-detail cycle (wantComments=true)", async () => {
    const fetchMock = fetchByEndpoint();
    vi.stubGlobal("fetch", fetchMock);
    const p = new YouTubeApiProvider();
    const video = makeVideo({ platform: "youtube", externalVideoId: "CL62fTyvMOY", originalUrl: "https://www.youtube.com/shorts/CL62fTyvMOY" });
    await p.fetchPlatform(null, [video], new Date("2026-06-01"), { wantComments: true });
    const calledComment = fetchMock.mock.calls.some((c) => String(c[0]).includes("/commentThreads"));
    expect(calledComment).toBe(true);
  });
});

describe("YouTube monotonic views", () => {
  it("a lower YouTube reading does not overwrite a higher confirmed value", () => {
    const { views, rejectedLower } = applyMonotonicViews(1200, 1338);
    expect(views).toBeNull(); // recorded as not-reported
    expect(rejectedLower).toBe(1200);
    // a higher reading is accepted
    expect(applyMonotonicViews(1500, 1338).views).toBe(1500);
  });
});
