"use client";

import { SideSnapshot, STATUS_META } from "@/lib/comparisonData";

interface Props {
  figma: SideSnapshot;
  uno: SideSnapshot;
  differentiators: string[];
}

export default function ExecutiveSnapshot({ figma, uno, differentiators }: Props) {
  return (
    <section className="mb-12">
      <h2 className="text-2xl font-bold text-zinc-100 mb-6">Executive Snapshot</h2>

      {/* Two-column cards */}
      <div className="grid md:grid-cols-2 gap-6 mb-8">
        {/* Figma AI */}
        <div className="rounded-2xl border border-zinc-700/60 bg-zinc-900/70 p-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="inline-block w-3 h-3 rounded-full bg-purple-500" />
            <h3 className="text-lg font-semibold text-zinc-100">{figma.name}</h3>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">{figma.summary}</p>
        </div>

        {/* Uno */}
        <div className="rounded-2xl border border-indigo-600/40 bg-indigo-950/30 p-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="inline-block w-3 h-3 rounded-full bg-indigo-400" />
            <h3 className="text-lg font-semibold text-zinc-100">{uno.name}</h3>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">{uno.summary}</p>
        </div>
      </div>

      {/* Key differentiators */}
      <div className="rounded-2xl border border-zinc-700/40 bg-zinc-900/50 p-6">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-indigo-400 mb-4">
          Key Differentiators — Uno Design Assistant
        </h4>
        <div className="grid md:grid-cols-3 gap-4">
          {differentiators.map((d, i) => (
            <div
              key={i}
              className="flex gap-3 text-sm text-zinc-300 leading-relaxed"
            >
              <span className={`mt-0.5 shrink-0 text-lg font-bold ${STATUS_META.strong.color}`}>
                {i + 1}.
              </span>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
