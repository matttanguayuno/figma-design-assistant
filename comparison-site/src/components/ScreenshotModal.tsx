"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { TOOLS, SUPPORT_META, CAPABILITY_GROUPS, type Capability, type Tool, type ToolScreenshot } from "@/data/matrixData";

interface ScreenshotModalProps {
  /** Single capability mode */
  capability?: Capability;
  /** Tool-overview mode: show all capabilities for this tool */
  toolId?: string;
  /** If set, only show screenshots for this tool (single-capability mode) */
  filterToolId?: string;
  /** Navigate to prev/next tool or feature */
  onNavigate?: (direction: "prev-tool" | "next-tool" | "prev-feature" | "next-feature") => void;
  onClose: () => void;
}

const arrowBtnClass =
  "flex items-center justify-center w-9 h-9 rounded-full border border-zinc-700/60 bg-zinc-800/80 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition-all backdrop-blur-sm";

export default function ScreenshotModal({
  capability,
  toolId,
  filterToolId,
  onNavigate,
  onClose,
}: ScreenshotModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const copyPrompt = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (!onNavigate) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); onNavigate("prev-tool"); }
      if (e.key === "ArrowRight") { e.preventDefault(); onNavigate("next-tool"); }
      if (e.key === "ArrowUp") { e.preventDefault(); onNavigate("prev-feature"); }
      if (e.key === "ArrowDown") { e.preventDefault(); onNavigate("next-feature"); }
    },
    [onClose, onNavigate]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [handleKeyDown]);

  // ── Tool-overview mode ──────────────────────────────────
  if (toolId) {
    const tool = TOOLS.find((t) => t.id === toolId);
    const allCaps = CAPABILITY_GROUPS.flatMap((g) => g.capabilities);
    const capsWithScreenshots = allCaps.filter((cap) =>
      cap.screenshots.some((s) => s.toolId === toolId)
    );

    return (
      <div
        ref={overlayRef}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
        onClick={(e) => {
          if (e.target === overlayRef.current) onClose();
        }}
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
        <div className="relative w-full max-w-6xl max-h-[calc(100vh-3rem)] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-zinc-800 shrink-0">
            <div>
              <h2 className="text-xl font-semibold text-zinc-100">
                {tool?.name ?? "Tool"} — All Screenshots
              </h2>
              <p className="text-sm text-zinc-400 mt-1">
                {capsWithScreenshots.length} capabilit{capsWithScreenshots.length === 1 ? "y" : "ies"} with screenshots
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-100 transition-colors text-2xl leading-none p-1 -mt-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {capsWithScreenshots.length > 0 ? (
              <div className="space-y-10">
                {capsWithScreenshots.map((cap) => {
                  const shots = cap.screenshots.filter((s) => s.toolId === toolId);
                  const level = cap.support[toolId];
                  const meta = level ? SUPPORT_META[level] : null;
                  return (
                    <div key={cap.id}>
                      <div className="flex items-center gap-3 mb-3">
                        <h3 className="text-sm font-semibold text-zinc-200">
                          {cap.name}
                        </h3>
                        {meta && (
                          <span
                            className="inline-block rounded-md text-xs px-2 py-0.5"
                            style={{
                              background: meta.chipBg,
                              border: `1px solid ${meta.chipBorder}`,
                              color: meta.chipColor,
                            }}
                          >
                            {meta.icon} {meta.label}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {shots.map((ss, idx) => (
                          <figure
                            key={idx}
                            className="bg-zinc-800/60 border border-zinc-700/40 rounded-xl overflow-hidden"
                          >
                            <div className="relative w-full flex items-center justify-center bg-zinc-950 p-2 min-h-[200px]">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={ss.src}
                                alt={ss.alt}
                                className="max-h-[500px] w-auto max-w-full object-contain rounded"
                                loading="lazy"
                              />
                            </div>
                            {ss.caption && (
                              <figcaption className="text-xs text-zinc-500 px-3 py-2 border-t border-zinc-700/30">
                                {ss.caption}
                              </figcaption>
                            )}
                          </figure>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-16 text-zinc-500">
                <p className="text-lg mb-1">No screenshots yet</p>
                <p className="text-sm">No screenshots have been added for {tool?.name}.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Single-capability mode ─────────────────────────────────
  if (!capability) return null;

  // Determine which tools to show — only those with screenshots
  const toolsToShow: Tool[] = filterToolId
    ? TOOLS.filter((t) => t.id === filterToolId)
    : TOOLS.filter((t) => capability.screenshots.some((s) => s.toolId === t.id));

  // Group screenshots by tool
  const screenshotsByTool = new Map<string, ToolScreenshot[]>();
  for (const ss of capability.screenshots) {
    if (filterToolId && ss.toolId !== filterToolId) continue;
    const existing = screenshotsByTool.get(ss.toolId) || [];
    existing.push(ss);
    screenshotsByTool.set(ss.toolId, existing);
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      {/* Blurred backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />

      {/* Up arrow (previous feature) */}
      {onNavigate && (
        <button
          className={`${arrowBtnClass} absolute top-3 left-1/2 -translate-x-1/2 z-[60]`}
          onClick={() => onNavigate("prev-feature")}
          title="Previous feature (↑)"
          style={{ transform: "translateX(-50%) rotate(90deg)" }}
        >
          ‹
        </button>
      )}

      {/* Left arrow (previous tool) */}
      {onNavigate && (
        <button
          className={`${arrowBtnClass} absolute left-3 top-1/2 -translate-y-1/2 z-[60]`}
          onClick={() => onNavigate("prev-tool")}
          title="Previous tool (←)"
        >
          ‹
        </button>
      )}

      {/* Right arrow (next tool) */}
      {onNavigate && (
        <button
          className={`${arrowBtnClass} absolute right-3 top-1/2 -translate-y-1/2 z-[60]`}
          onClick={() => onNavigate("next-tool")}
          title="Next tool (→)"
        >
          ›
        </button>
      )}

      {/* Down arrow (next feature) */}
      {onNavigate && (
        <button
          className={`${arrowBtnClass} absolute bottom-3 left-1/2 -translate-x-1/2 z-[60]`}
          onClick={() => onNavigate("next-feature")}
          title="Next feature (↓)"
          style={{ transform: "translateX(-50%) rotate(90deg)" }}
        >
          ›
        </button>
      )}

      {/* Modal */}
      <div className="relative w-full max-w-6xl max-h-[calc(100vh-3rem)] bg-zinc-900 border border-zinc-700/50 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-zinc-800 shrink-0">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">
              {capability.name}
            </h2>
            <p className="text-sm text-zinc-400 mt-1">
              {capability.description}
            </p>
            {filterToolId && (
              <span
                className={`inline-block mt-2 px-2.5 py-0.5 rounded text-xs font-medium ${
                  TOOLS.find((t) => t.id === filterToolId)?.color ?? "bg-zinc-700"
                } ${TOOLS.find((t) => t.id === filterToolId)?.textColor ?? "text-zinc-100"}`}
              >
                {TOOLS.find((t) => t.id === filterToolId)?.name}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 transition-colors text-2xl leading-none p-1 -mt-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Support status pills for visible tools */}
          <div className="flex flex-wrap gap-3 mb-6">
            {toolsToShow.map((tool) => {
              const level = capability.support[tool.id];
              const meta = SUPPORT_META[level];
              const note = capability.notes?.[tool.id];
              return (
                <div
                  key={tool.id}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm ${
                    level === "full"
                      ? "border-emerald-700/50 bg-emerald-950/40"
                      : level === "partial"
                      ? "border-yellow-700/40 bg-yellow-950/30"
                      : "border-red-700/30 bg-red-950/20"
                  }`}
                >
                  <span className="font-medium text-zinc-300">
                    {tool.name}
                  </span>
                  <span className={meta.cellClass.split(" ").pop()}>
                    {meta.icon} {meta.label}
                  </span>
                  {note && (
                    <span className="text-zinc-500 text-xs ml-1" title={note}>
                      ⓘ
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Test Prompt */}
          {capability.testPrompt && (
            <div className="mb-6">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Test Prompt
              </h3>
              <div className="relative bg-zinc-800/70 border border-zinc-700/40 rounded-lg px-4 py-3 pr-10 text-sm text-zinc-300 italic leading-relaxed">
                &ldquo;{capability.testPrompt}&rdquo;
                <button
                  onClick={() => copyPrompt(capability.testPrompt!)}
                  className={`absolute top-2.5 right-2.5 p-1.5 rounded-md transition-all ${
                    copied
                      ? "text-emerald-300"
                      : "text-zinc-500 hover:text-zinc-200"
                  }`}
                  title={copied ? "Copied!" : "Copy to clipboard"}
                >
                  {copied ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Screenshots grouped by tool */}
          {screenshotsByTool.size > 0 ? (
            <div className="space-y-8">
              {Array.from(screenshotsByTool.entries()).map(
                ([toolId, shots]) => {
                  const tool = TOOLS.find((t) => t.id === toolId);
                  return (
                    <div key={toolId}>
                      {!filterToolId && (
                        <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                          <span
                            className={`inline-block w-2.5 h-2.5 rounded-full ${tool?.color ?? "bg-zinc-600"}`}
                          />
                          {tool?.name}
                        </h3>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {shots.map((ss, idx) => (
                          <figure
                            key={idx}
                            className="bg-zinc-800/60 border border-zinc-700/40 rounded-xl overflow-hidden"
                          >
                            <div className="relative w-full flex items-center justify-center bg-zinc-950 p-2 min-h-[200px]">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={ss.src}
                                alt={ss.alt}
                                className="max-h-[500px] w-auto max-w-full object-contain rounded"
                                loading="lazy"
                              />
                            </div>
                            {ss.caption && (
                              <figcaption className="text-xs text-zinc-500 px-3 py-2 border-t border-zinc-700/30">
                                {ss.caption}
                              </figcaption>
                            )}
                          </figure>
                        ))}
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          ) : (
            <div className="text-center py-16 text-zinc-500">
              <p className="text-lg mb-1">No screenshots yet</p>
              <p className="text-sm">
                Add screenshots to{" "}
                <code className="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">
                  public/screenshots/
                </code>{" "}
                and reference them in the data file.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
