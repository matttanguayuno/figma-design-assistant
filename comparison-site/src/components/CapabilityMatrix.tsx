"use client";

import { useState, Fragment } from "react";
import {
  TOOLS,
  SUPPORT_META,
  CAPABILITY_GROUPS,
  type Capability,
  type SupportLevel,
} from "@/data/matrixData";
import ScreenshotModal from "./ScreenshotModal";

interface ModalState {
  capability?: Capability;
  filterToolId?: string;
  toolId?: string;
}

export default function CapabilityMatrix() {
  const [modal, setModal] = useState<ModalState | null>(null);

  const openCapabilityModal = (cap: Capability) => {
    setModal({ capability: cap });
  };

  const openCellModal = (cap: Capability, toolId: string) => {
    setModal({ capability: cap, filterToolId: toolId });
  };

  const openToolModal = (toolId: string) => {
    setModal({ toolId });
  };

  const allCapabilities = CAPABILITY_GROUPS.flatMap((g) => g.capabilities);

  const handleNavigate = (direction: "prev-tool" | "next-tool" | "prev-feature" | "next-feature") => {
    setModal((prev) => {
      if (!prev) return prev;

      // Navigation only applies in single-capability + filterToolId mode
      if (!prev.capability || !prev.filterToolId) return prev;

      const toolIds = TOOLS.map((t) => t.id);
      const toolIdx = toolIds.indexOf(prev.filterToolId);
      const capIdx = allCapabilities.findIndex((c) => c.id === prev.capability!.id);

      if (direction === "prev-tool" || direction === "next-tool") {
        const delta = direction === "prev-tool" ? -1 : 1;
        const newToolIdx = (toolIdx + delta + toolIds.length) % toolIds.length;
        return { ...prev, filterToolId: toolIds[newToolIdx] };
      }

      if (direction === "prev-feature" || direction === "next-feature") {
        const delta = direction === "prev-feature" ? -1 : 1;
        const newCapIdx = (capIdx + delta + allCapabilities.length) % allCapabilities.length;
        return { ...prev, capability: allCapabilities[newCapIdx] };
      }

      return prev;
    });
  };

  const renderSupportCell = (
    cap: Capability,
    toolId: string,
    level: SupportLevel
  ) => {
    const meta = SUPPORT_META[level];
    const hasScreenshots = cap.screenshots.some((s) => s.toolId === toolId);
    const hasNotes = cap.notes?.[toolId];
    // Uno Design Assistant is always clickable unless support is "none"
    const isUnoClickable = toolId === "uno-design-assistant" && level !== "none";
    const isClickable = hasScreenshots || hasNotes || isUnoClickable;

    return (
      <td
        key={toolId}
        className="px-3 py-4 text-center border-b transition-colors"
        style={{ borderColor: "var(--border)" }}
        onClick={() => {
          if (isClickable) openCellModal(cap, toolId);
        }}
        title={
          isClickable
            ? `Click to see details for ${TOOLS.find((t) => t.id === toolId)?.name}`
            : undefined
        }
      >
        <span
          className={`inline-block rounded-[var(--radius-md)] font-semibold transition-all ${
            isClickable ? "cursor-pointer hover:scale-[1.08]" : ""
          }`}
          style={{
            padding: "0.5rem 0.85rem",
            fontSize: "1.3rem",
            background: meta.chipBg,
            border: `1px solid ${meta.chipBorder}`,
            color: meta.chipColor,
          }}
        >
          {meta.icon}
        </span>
      </td>
    );
  };

  return (
    <>
      <div className="w-full overflow-x-auto rounded-[var(--radius-lg)]" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <table className="w-full border-collapse min-w-[900px]" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th
                className="sticky left-0 z-20 px-5 py-4 text-left text-xs font-bold uppercase tracking-widest"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  borderBottom: "2px solid var(--border-bright)",
                  width: "22%",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                }}
              >
                Capability
              </th>
              {TOOLS.map((tool) => (
                <th
                  key={tool.id}
                  className="px-4 py-4 text-center text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors"
                  style={{
                    background: "var(--surface-2)",
                    color: "var(--text)",
                    borderBottom: "2px solid var(--border-bright)",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                    letterSpacing: "0.02em",
                  }}
                  onClick={() => openToolModal(tool.id)}
                  title={`Click to see all ${tool.name} screenshots`}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--uno-violet)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text)"; }}
                >
                  {tool.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_GROUPS.map((group) => (
              <Fragment key={`group-${group.name}`}>
                {/* Group header row */}
                <tr>
                  <td
                    colSpan={TOOLS.length + 1}
                    className="px-5 py-3.5 text-sm font-bold uppercase tracking-widest"
                    style={{
                      background: "linear-gradient(90deg, rgba(140, 0, 184, 0.45) 0%, rgba(140, 0, 184, 0.25) 100%)",
                      borderBottom: "2px solid rgba(140, 0, 184, 0.5)",
                      borderTop: "2px solid rgba(140, 0, 184, 0.5)",
                      borderLeft: "4px solid var(--uno-violet)",
                      color: "#f0d4ff",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {group.name}
                  </td>
                </tr>
                {/* Capability rows */}
                {group.capabilities.map((cap) => (
                  <tr
                    key={cap.id}
                    className="transition-colors"
                    style={{ cursor: "default" }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(21, 155, 255, 0.06)";
                      const stickyTd = e.currentTarget.querySelector('td:first-child') as HTMLElement;
                      if (stickyTd) stickyTd.style.background = "rgba(21, 155, 255, 0.06)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "";
                      const stickyTd = e.currentTarget.querySelector('td:first-child') as HTMLElement;
                      if (stickyTd) stickyTd.style.background = "var(--surface)";
                    }}
                  >
                    <td
                      className="sticky left-0 z-10 px-5 py-4 text-sm font-semibold cursor-pointer transition-colors group"
                      style={{
                        background: "var(--surface)",
                        color: "var(--uno-blue)",
                        borderBottom: "1px solid var(--border)",
                      }}
                      onClick={() => openCapabilityModal(cap)}
                      title="Click to see all tool screenshots"
                    >
                      <span className="group-hover:underline underline-offset-2" style={{ textDecorationColor: "transparent", transition: "text-decoration-color 0.12s" }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.textDecorationColor = "var(--uno-violet)"; (e.currentTarget as HTMLElement).style.color = "var(--uno-violet)"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecorationColor = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--uno-blue)"; }}
                      >
                        {cap.name}
                      </span>
                    </td>
                    {TOOLS.map((tool) =>
                      renderSupportCell(cap, tool.id, cap.support[tool.id])
                    )}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {modal && (
        <ScreenshotModal
          capability={modal.capability}
          toolId={modal.toolId}
          filterToolId={modal.filterToolId}
          onNavigate={modal.capability && modal.filterToolId ? handleNavigate : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
