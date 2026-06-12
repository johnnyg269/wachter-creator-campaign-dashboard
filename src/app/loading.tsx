// Route-level loading state: dark skeleton mirroring the homepage layout so
// there's no flash of emptiness and no layout shift while data loads.

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading campaign data">
      <div className="skeleton mb-5 h-[180px] rounded-[20px]" />
      <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-[96px] rounded-none" />
        ))}
      </div>
      <div className="skeleton mb-5 h-[460px] rounded-[20px]" />
      <div className="skeleton mb-5 h-[80px] rounded-2xl" />
      <div className="skeleton h-[320px] rounded-xl" />
    </div>
  );
}
