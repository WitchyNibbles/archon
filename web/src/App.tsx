/**
 * App — placeholder route for Forge Phase-0.
 *
 * The real dashboard (metrics, task view, operator controls) ships in S3.
 * This file exists solely to prove the Vite + React 19 + Tailwind 4
 * toolchain builds and that the web/ package boundary holds.
 *
 * Do NOT build dashboard UI here — wait for the S3 task packet.
 */
export default function App() {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6">
        <header className="space-y-2">
          <div
            className="inline-block rounded px-2 py-0.5 text-xs font-medium uppercase tracking-widest"
            style={{
              background: "color-mix(in srgb, #6366f1 12%, transparent)",
              color: "#6366f1",
              border: "1px solid color-mix(in srgb, #6366f1 30%, transparent)",
            }}
          >
            Phase 0
          </div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: "#f4f4f5" }}>
            Archon Forge
          </h1>
          <p style={{ color: "#6b7280" }} className="text-sm leading-relaxed">
            Toolchain scaffold confirmed. Dashboard arrives in S3.
          </p>
        </header>

        <div
          className="rounded-lg p-4 text-sm space-y-2"
          style={{
            background: "#111113",
            border: "1px solid #1e1e21",
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full flex-shrink-0"
              style={{ background: "#6366f1" }}
              aria-hidden="true"
            />
            <span style={{ color: "#f4f4f5" }}>React 19</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full flex-shrink-0"
              style={{ background: "#6366f1" }}
              aria-hidden="true"
            />
            <span style={{ color: "#f4f4f5" }}>Vite 6</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full flex-shrink-0"
              style={{ background: "#6366f1" }}
              aria-hidden="true"
            />
            <span style={{ color: "#f4f4f5" }}>Tailwind CSS 4</span>
          </div>
        </div>
      </div>
    </div>
  );
}
