// Route-level loading skeleton for the Episodes page. Real Suspense boundary —
// shown only while the server fetches concept data (no artificial delay).

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading content concepts">
      <div className="skeleton mb-5 h-9 w-56 rounded-lg" />
      <div className="skeleton mb-5 h-[320px] rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-[120px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}
