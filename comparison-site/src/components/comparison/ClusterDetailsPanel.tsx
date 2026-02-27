"use client";

import { useEffect, useRef } from "react";
import type { Cluster } from "@/lib/comparisonData";
import { STATUS_META } from "@/lib/comparisonData";
import ScreenshotCarousel from "./ScreenshotCarousel";

interface Props {
  cluster: Cluster | null;
  onClose: () => void;
}

export default function ClusterDetailsPanel({ cluster, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Focus panel when opened
  useEffect(() => {
    if (cluster && panelRef.current) {
      panelRef.current.focus();
    }
  }, [cluster]);

  if (!cluster) return null;

  const figmaMeta = STATUS_META[cluster.figmaStatus];
  const unoMeta = STATUS_META[cluster.unoStatus];

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 lg:hidden"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel — side on desktop, modal on mobile */}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`Details for ${cluster.title}`}
        className="fixed inset-y-0 right-0 w-full sm:w-[420px] lg:w-[400px] bg-zinc-900 border-l border-zinc-700/60 z-50 overflow-y-auto shadow-2xl focus:outline-none"
      >
        {/* Header */}
        <div className="sticky top-0 bg-zinc-900/95 backdrop-blur border-b border-zinc-800 px-5 py-4 flex items-start justify-between z-10">
          <div>
            <h3 className="text-lg font-bold text-zinc-100">{cluster.title}</h3>
            <p className="text-xs text-zinc-500 mt-1">{cluster.summary}</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 text-xl p-1 -mr-1 -mt-1"
            aria-label="Close details panel"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-5 space-y-6">
          {/* Status comparison */}
          <div className="flex gap-4">
            <StatusCard label="Figma AI" status={cluster.figmaStatus} meta={figmaMeta} />
            <StatusCard label="Uno" status={cluster.unoStatus} meta={unoMeta} />
          </div>

          {/* Figma bullets */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-purple-400 mb-3">
              What Figma AI does
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

          {/* Uno bullets */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-400 mb-3">
              What Uno does
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

          {/* Notes */}
          {cluster.notes && cluster.notes.length > 0 && (
            <div className="rounded-xl border border-zinc-700/40 bg-zinc-800/40 p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                Notes &amp; Limitations
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
    </>
  );
}

/* ── Status Card ─────────────────────────────── */

function StatusCard({
  label,
  status,
  meta,
}: {
  label: string;
  status: string;
  meta: { label: string; color: string; bg: string; border: string };
}) {
  return (
    <div className={`flex-1 rounded-xl border p-3 text-center ${meta.bg} ${meta.border}`}>
      <div className="text-xs text-zinc-400 mb-1">{label}</div>
      <div className={`text-sm font-semibold ${meta.color}`}>{meta.label}</div>
    </div>
  );
}
