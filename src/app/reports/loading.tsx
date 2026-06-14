// Route-level loading skeleton for the Reports page. Real Suspense boundary —
// shown only while the server builds the report payload (no artificial delay).
// Mirrors the toolbar + 16:9 slide canvas so there is no layout shift.

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1320px]" aria-busy="true" aria-label="Loading reports">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="skeleton h-9 w-40 rounded-lg" />
        <div className="flex gap-2">
          <div className="skeleton h-9 w-32 rounded-lg" />
          <div className="skeleton h-9 w-24 rounded-lg" />
        </div>
      </div>
      <div className="skeleton mb-5 h-16 w-full rounded-xl" />
      {/* 16:9 slide canvas placeholder */}
      <div className="skeleton w-full rounded-2xl" style={{ aspectRatio: "16 / 9" }} />
    </div>
  );
}
