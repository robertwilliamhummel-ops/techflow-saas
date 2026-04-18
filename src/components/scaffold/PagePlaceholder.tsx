// Bundle D — minimal placeholder so route tree resolves.
// Real UI lands in the phase noted on each page.
export function PagePlaceholder({
  title,
  phase,
  meta,
}: {
  title: string;
  phase: string;
  meta?: Record<string, string>;
}) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Stub — implemented in {phase}.
      </p>
      {meta && Object.keys(meta).length > 0 ? (
        <dl className="mt-4 text-xs text-muted-foreground">
          {Object.entries(meta).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="font-mono">{k}:</dt>
              <dd className="font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
