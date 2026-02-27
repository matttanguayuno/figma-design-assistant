"use client";

import { useState, useEffect, useRef } from "react";
import type { Cluster, CapabilityStatus } from "@/lib/comparisonData";
import { STATUS_META } from "@/lib/comparisonData";
import ScreenshotCarousel from "./ScreenshotCarousel";

interface Props {
  clusters: Cluster[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}

export default function HeatmapMatrix({ clusters, expandedId, onToggle }: Props) {
  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-zinc-100">Capability Matrix</h2>
        {/* Legend */}
        <div className="hidden sm:flex items-center gap-3 text-xs text-zinc-400">
          {(["strong", "limited", "none", "unknown"] as CapabilityStatus[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <StatusDot status={s} />
              {STATUS_META[s].label}
            </span>
          ))}
        </div>
      </div>

      {/* Mobile legend */}
      <div className="flex sm:hidden items-center gap-3 text-xs text-zinc-400 mb-4 flex-wrap">
        {(["strong", "limited", "none", "unknown"] as CapabilityStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <StatusDot status={s} />
            {STATUS_META[s].label}
          </span>
        ))}
      </div>

      <div className="rounded-2xl border border-zinc-700/50 bg-zinc-900/60 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_120px_120px] sm:grid-cols-[1fr_140px_140px] bg-zinc-800/80 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          <div>Capability</div>
          <div className="text-center">Figma AI</div>
          <div className="text-center">Uno</div>
        </div>

        {/* Rows */}
        {clusters.map((cluster) => (
          <ExpandableRow
            key={cluster.id}
            cluster={cluster}
            isExpanded={expandedId === cluster.id}
            onToggle={() => onToggle(cluster.id)}
          />
        ))}
      </div>
    </section>
  );
}

/* ── Expandable Row ──────────────────────────── */

function ExpandableRow({
  cluster,
  isExpanded,
  onToggle,
}: {
  cluster: Cluster;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setHeight(isExpanded ? contentRef.current.scrollHeight : 0);
    }
  }, [isExpanded]);

  const figmaMeta = STATUS_META[cluster.figmaStatus];
  const unoMeta = STATUS_META[cluster.unoStatus];

  return (
    <div id={`cluster-${cluster.id}`} className="border-t border-zinc-800/60">
      {/* Row header */}
      <button
        onClick={onToggle}
        className={`grid grid-cols-[1fr_120px_120px] sm:grid-cols-[1fr_140px_140px] px-4 py-3.5 w-full text-left transition-colors cursor-pointer hover:bg-zinc-800/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-inset ${
          isExpanded ? "bg-zinc-800/40" : ""
        }`}
        aria-expanded={isExpanded}
        aria-label={`${cluster.title} — click to ${isExpanded ? "collapse" : "expand"} details`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`transition-transform duration-200 text-zinc-500 text-xs ${
              isExpanded ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
          <div>
            <div className="text-sm font-medium text-zinc-200">{cluster.title}</div>
            <div className="text-xs text-zinc-500 mt-0.5 hidden sm:block">{cluster.summary}</div>
          </div>
        </div>
        <div className="flex justify-center items-center">
          <StatusPill status={cluster.figmaStatus} />
        </div>
        <div className="flex justify-center items-center">
          <StatusPill status={cluster.unoStatus} />
        </div>
      </button>

      {/* Expanded deep-dive content */}
      <div
        style={{ maxHeight: height }}
        className="transition-[max-height] duration-300 ease-in-out overflow-hidden"
      >
        <div ref={contentRef} className="px-5 pb-5 pt-3 space-y-5 border-t border-zinc-800/40 bg-zinc-900/80">
          {/* Status comparison cards */}
          <div className="flex gap-4">
            <StatusCard label="Figma AI" meta={figmaMeta} />
            <StatusCard label="Uno" meta={unoMeta} />
          </div>

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
                <p key={i} className="text-sm text-zinc-400 leading-relaxed">{n}</p>
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

/* ── Status helpers ──────────────────────────── */

function StatusPill({ status }: { status: CapabilityStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border ${meta.color} ${meta.bg} ${meta.border}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.color.replace("text-", "bg-")}`} />
      {meta.label}
    </span>
  );
}

function StatusDot({ status }: { status: CapabilityStatus }) {
  const meta = STATUS_META[status];
  return <span className={`inline-block w-3 h-3 rounded-full border ${meta.bg} ${meta.border}`} />;
}

function StatusCard({
  label,
  meta,
}: {
  label: string;
  meta: { label: string; color: string; bg: string; border: string };
}) {
  return (
    <div className={`flex-1 rounded-xl border p-3 text-center ${meta.bg} ${meta.border}`}>
      <div className="text-xs text-zinc-400 mb-1">{label}</div>
      <div className={`text-sm font-semibold ${meta.color}`}>{meta.label}</div>
    </div>
  );
}
