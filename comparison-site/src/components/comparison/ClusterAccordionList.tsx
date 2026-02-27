"use client";

import { useState, useEffect, useRef } from "react";
import type { Cluster } from "@/lib/comparisonData";
import { STATUS_META } from "@/lib/comparisonData";
import ScreenshotCarousel from "./ScreenshotCarousel";

interface Props {
  clusters: Cluster[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

export default function ClusterAccordionList({ clusters, expandedId, onToggle }: Props) {
  return (
    <section className="mb-12">
      <h2 className="text-2xl font-bold text-zinc-100 mb-6">Deep Dive</h2>

      <div className="space-y-3">
        {clusters.map((cluster) => (
          <AccordionItem
            key={cluster.id}
            cluster={cluster}
            isOpen={expandedId === cluster.id}
            onToggle={() => onToggle(cluster.id)}
          />
        ))}
      </div>
    </section>
  );
}

/* ── Single accordion item ───────────────────── */

function AccordionItem({
  cluster,
  isOpen,
  onToggle,
}: {
  cluster: Cluster;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setHeight(isOpen ? contentRef.current.scrollHeight : 0);
    }
  }, [isOpen]);

  const figmaMeta = STATUS_META[cluster.figmaStatus];
  const unoMeta = STATUS_META[cluster.unoStatus];

  return (
    <div
      id={`cluster-${cluster.id}`}
      className="rounded-2xl border border-zinc-700/50 bg-zinc-900/60 overflow-hidden"
    >
      {/* Header button */}
      <button
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-zinc-800/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-inset"
        aria-expanded={isOpen}
        aria-controls={`accordion-content-${cluster.id}`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`transition-transform duration-200 text-zinc-400 ${
              isOpen ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
          <div>
            <span className="text-sm font-medium text-zinc-200">{cluster.title}</span>
            <span className="text-xs text-zinc-500 ml-3 hidden sm:inline">{cluster.summary}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <MiniPill label="Figma" meta={figmaMeta} />
          <MiniPill label="Uno" meta={unoMeta} />
        </div>
      </button>

      {/* Collapsible content */}
      <div
        id={`accordion-content-${cluster.id}`}
        style={{ maxHeight: height }}
        className="transition-[max-height] duration-300 ease-in-out overflow-hidden"
      >
        <div ref={contentRef} className="px-5 pb-5 pt-2 space-y-5 border-t border-zinc-800/60">
          <div className="grid md:grid-cols-2 gap-5">
            {/* Figma side */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-purple-400 mb-3">
                Figma AI
              </h4>
              <ul className="space-y-2">
                {cluster.figmaBullets.map((b, i) => (
                  <li key={i} className="flex gap-2 text-sm text-zinc-400 leading-relaxed">
                    <span className="text-purple-500 shrink-0">•</span>
                    {b}
                  </li>
                ))}
              </ul>
            </div>

            {/* Uno side */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-400 mb-3">
                Uno Design Assistant
              </h4>
              <ul className="space-y-2">
                {cluster.unoBullets.map((b, i) => (
                  <li key={i} className="flex gap-2 text-sm text-zinc-300 leading-relaxed">
                    <span className="text-indigo-400 shrink-0">•</span>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Notes */}
          {cluster.notes && cluster.notes.length > 0 && (
            <div className="rounded-xl border border-zinc-700/40 bg-zinc-800/40 p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                Notes
              </h4>
              {cluster.notes.map((n, i) => (
                <p key={i} className="text-sm text-zinc-400 leading-relaxed">
                  {n}
                </p>
              ))}
            </div>
          )}

          {/* Screenshots */}
          {cluster.screenshots && cluster.screenshots.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">
                Evidence
              </h4>
              <ScreenshotCarousel screenshots={cluster.screenshots} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Mini status pill ────────────────────────── */

function MiniPill({
  label,
  meta,
}: {
  label: string;
  meta: { label: string; color: string; bg: string; border: string };
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border ${meta.bg} ${meta.border} ${meta.color}`}
    >
      {label}
    </span>
  );
}
