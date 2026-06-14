// Route-level loading skeleton for the Videos page. Real Suspense boundary —
// shown only while the server fetches data (no artificial delay). The `.skeleton`
// pulse + its prefers-reduced-motion handling live in globals.css.

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading videos">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="skeleton h-9 w-48 rounded-lg" />
        <div className="skeleton h-8 w-44 rounded-lg" />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-[78px] rounded-none" />
        ))}
      </div>
      <div className="skeleton mb-5 h-[220px] rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-[150px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}
