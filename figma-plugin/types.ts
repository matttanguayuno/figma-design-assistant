// figma-plugin/types.ts
// Type definitions for the Figma plugin payloads and snapshots.

import { OperationBatch } from "../shared/operationSchema";

// ── Selection Snapshot ──────────────────────────────────────────────

export type NodeSnapshot = {
  id: string;
  name: string;
  type: string;
  siblingIndex?: number; // 0-based position among siblings in parent
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  layoutWrap?: "WRAP" | "NO_WRAP";
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  appliedTextStyleId?: string;
  appliedFillStyleId?: string;
  characters?: string;
  childrenCount: number;
  children?: NodeSnapshot[];
  // Visual properties for AI design reasoning
  cornerRadius?: number;
  fillTypes?: string[];  // e.g. ["IMAGE", "SOLID"]
  fillColor?: string;    // hex color of first solid fill, e.g. "#FFFFFF"
  clipsContent?: boolean;
  opacity?: number;
  // Text styling properties
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  letterSpacing?: number;
  letterSpacingUnit?: "PIXELS" | "PERCENT";
  lineHeight?: number | string; // number (px) or "AUTO"
  lineHeightUnit?: "PIXELS" | "PERCENT" | "AUTO";
  textCase?: string;
  textDecoration?: string;
  // Effects (drop shadow, inner shadow, blur)
  effects?: EffectSnapshot[];
  // Image data for export/import round-trip
  imageData?: string;       // base64-encoded PNG
};

export type EffectSnapshot = {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
  visible?: boolean;
  radius: number;
  spread?: number;
  color?: { r: number; g: number; b: number; a: number };
  offset?: { x: number; y: number };
  blendMode?: string;
};

export type SelectionSnapshot = {
  nodes: NodeSnapshot[];
};

// ── Design System Snapshot ──────────────────────────────────────────

export type StyleEntry = {
  id: string;
  name: string;
};

export type ComponentEntry = {
  key: string;
  name: string;
};

export type VariableEntry = {
  id: string;
  name: string;
};

export type DesignSystemSnapshot = {
  textStyles: StyleEntry[];
  fillStyles: StyleEntry[];
  components: ComponentEntry[];
  variables: VariableEntry[];
};

// ── Payload sent to backend ─────────────────────────────────────────

export type BackendPayload = {
  intent: string;
  selection: SelectionSnapshot;
  designSystem: DesignSystemSnapshot;
};

// ── Messages between UI ↔ Plugin ────────────────────────────────────

export type UIToPluginMessage =
  | { type: "run"; intent: string }
  | { type: "revert-last" }
  | { type: "export-json" }
  | { type: "import-json"; data: { selection: { nodes: any[] }; [key: string]: any } }
  | { type: "generate"; prompt: string };

export type PluginToUIMessage =
  | { type: "apply-success"; summary: string }
  | { type: "apply-error"; error: string }
  | { type: "revert-success" }
  | { type: "revert-error"; error: string }
  | { type: "status"; message: string }
  | { type: "selection-change"; label: string }
  | { type: "export-json-result"; data: object; filename: string }
  | { type: "export-json-error"; error: string }
  | { type: "import-json-success"; summary: string }
  | { type: "import-json-error"; error: string }
  | { type: "generate-success"; summary: string }
  | { type: "generate-error"; error: string };

// ── Audit Log Entry ─────────────────────────────────────────────────

export type AuditLogEntry = {
  timestamp: string;
  intent: string;
  operationSummary: string;
};

// ── Revert State ────────────────────────────────────────────────────

export type RevertState = {
  /** Serialised previous node properties keyed by node id */
  previousStates: Record<string, string>;
  batch: OperationBatch;
};
