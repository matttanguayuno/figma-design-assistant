"use client";

import { useState, useCallback } from "react";
import { COMPARISON_DATA } from "@/lib/comparisonData";
import ExecutiveSnapshot from "./ExecutiveSnapshot";
import HeatmapMatrix from "./HeatmapMatrix";
import ArchitectureDiagram from "./ArchitectureDiagram";
import StrategicRisk from "./StrategicRisk";

export default function ComparisonPage() {
  const { figmaSnapshot, unoSnapshot, topDifferentiators, clusters } = COMPARISON_DATA;

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Page header */}
        <header className="mb-10">
          <h1 className="text-3xl sm:text-4xl font-bold text-zinc-100 tracking-tight">
            Figma AI vs Uno Design Assistant
          </h1>
          <p className="text-sm text-zinc-500 mt-2">
            Internal comparison brief · Updated February 2026
          </p>
        </header>

        {/* 1. Executive Snapshot */}
        <ExecutiveSnapshot
          figma={figmaSnapshot}
          uno={unoSnapshot}
          differentiators={topDifferentiators}
        />

        {/* 2. Capability Matrix with inline deep-dive */}
        <HeatmapMatrix
          clusters={clusters}
          expandedId={expandedId}
          onToggle={handleToggle}
        />

        {/* 3. Architecture Diagram */}
        <ArchitectureDiagram />

        {/* 4. Strategic Risk */}
        <StrategicRisk />
      </div>
    </div>
  );
}
