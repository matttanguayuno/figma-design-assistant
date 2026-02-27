"use client";

import { COMPARISON_DATA } from "@/lib/comparisonData";

export default function StrategicRisk() {
  const { ifFigmaAdds, moat } = COMPARISON_DATA.risks;

  return (
    <section className="mb-12">
      <h2 className="text-2xl font-bold text-zinc-100 mb-6">Strategic Risk Assessment</h2>

      <div className="grid md:grid-cols-2 gap-6">
        {/* If Figma adds… */}
        <div className="rounded-2xl border border-amber-700/30 bg-amber-950/10 p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-400 mb-4">
            If Figma adds…
          </h3>
          <ul className="space-y-3">
            {ifFigmaAdds.map((item, i) => (
              <li key={i} className="flex gap-3 text-sm text-zinc-300 leading-relaxed">
                <span className="text-amber-500 shrink-0 mt-0.5">⚠</span>
                <span><strong className="text-amber-300">{item.title}</strong> — {item.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Defensibility / Moat */}
        <div className="rounded-2xl border border-emerald-700/30 bg-emerald-950/10 p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-emerald-400 mb-4">
            Defensibility / Moat
          </h3>
          <ul className="space-y-3">
            {moat.map((item, i) => (
              <li key={i} className="flex gap-3 text-sm text-zinc-300 leading-relaxed">
                <span className="text-emerald-500 shrink-0 mt-0.5">✦</span>
                <span><strong className="text-emerald-300">{item.title}</strong> — {item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
