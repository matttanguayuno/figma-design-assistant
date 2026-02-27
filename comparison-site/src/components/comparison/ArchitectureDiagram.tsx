"use client";

export default function ArchitectureDiagram() {
  return (
    <section className="mb-12">
      <h2 className="text-2xl font-bold text-zinc-100 mb-6">Architecture Comparison</h2>

      <div className="space-y-6">
        {/* Figma AI — simple pipeline */}
        <div className="rounded-2xl border border-zinc-700/50 bg-zinc-900/60 p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-purple-400 mb-5">
            Figma AI Pipeline
          </h3>
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <PipelineNode label="Prompt" color="purple" />
            <Arrow />
            <PipelineNode label="LLM" sub="(Figma's model)" color="purple" />
            <Arrow />
            <PipelineNode label="UI Output" color="purple" />
          </div>
          <p className="text-xs text-zinc-500 mt-4">
            Single-pass: prompt goes directly to Figma's internal model, output rendered to canvas.
            No design-system injection, no post-processing.
          </p>
        </div>

        {/* Uno — full pipeline */}
        <div className="rounded-2xl border border-indigo-600/30 bg-indigo-950/20 p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-indigo-400 mb-5">
            Uno Design Assistant Pipeline
          </h3>

          {/* Wrapping horizontal flow */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <PipelineNode label="Prompt" color="indigo" />
            <Arrow />
            <PipelineNode label="DS Extraction" sub="styles, tokens, components" color="emerald" />
            <Arrow />
            <PipelineNode label="Pre-Processing" sub="responsive, nav, hero" color="amber" />
            <Arrow />
            <PipelineNode label="LLM" sub="9 models / 3 providers" color="indigo" />
            <Arrow />
            <PipelineNode label="Post-Processing" sub="style binding, contrast" color="emerald" />
            <Arrow />
            <PipelineNode label="Governance" sub="WCAG, state audit" color="rose" />
            <Arrow />
            <PipelineNode label="UI Output" color="indigo" />
          </div>
          <p className="text-xs text-zinc-500 mt-4">
            Multi-stage: design system context is extracted and injected, layouts are programmatically
            pre-processed, LLM output is post-processed with style binding and contrast fixes,
            then governance checks validate quality.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── Pipeline building blocks ────────────────── */

const COLOR_MAP: Record<string, string> = {
  purple: "border-purple-600/60 bg-purple-950/40 text-purple-200",
  indigo: "border-indigo-600/60 bg-indigo-950/40 text-indigo-200",
  emerald: "border-emerald-600/60 bg-emerald-950/40 text-emerald-200",
  amber: "border-amber-600/60 bg-amber-950/40 text-amber-200",
  rose: "border-rose-600/60 bg-rose-950/40 text-rose-200",
};

function PipelineNode({
  label,
  sub,
  color,
}: {
  label: string;
  sub?: string;
  color: string;
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 text-center min-w-[100px] shrink-0 ${COLOR_MAP[color] ?? COLOR_MAP.indigo}`}
    >
      <div className="text-sm font-semibold">{label}</div>
      {sub && <div className="text-[11px] opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

function Arrow() {
  return (
    <div className="text-zinc-600 text-lg shrink-0 rotate-0 sm:rotate-0">
      →
    </div>
  );
}
