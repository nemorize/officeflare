export function LoadingSkeleton({ kind = "section", label = "Loading…", rows = 3 }: {
  kind?: "section" | "list" | "reader" | "form" | "page";
  label?: string;
  rows?: number;
}) {
  return <div className={"loading-skeleton loading-skeleton-" + kind} role="status" aria-label={label}>
    <span className="visually-hidden">{label}</span>
    <div aria-hidden="true">
      {kind === "reader" && <><span className="skeleton-line skeleton-title" /><span className="skeleton-line skeleton-short" /></>}
      {Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index}>
        {kind === "list" && <span className="skeleton-avatar" />}
        <div><span className="skeleton-line" /><span className="skeleton-line skeleton-short" /></div>
      </div>)}
      {(kind === "form" || kind === "reader") && <div className="skeleton-editor" />}
    </div>
  </div>;
}
