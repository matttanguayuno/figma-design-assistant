/**
 * treeToSnapshot.ts — Converts a layout tree (from Step 0 vision LLM) directly
 * into a Figma NodeSnapshot, bypassing HTML/Puppeteer entirely.
 *
 * Icons, charts, and images are cropped directly from the reference screenshot
 * using sharp, producing pixel-perfect IMAGE fills in Figma.
 */
import sharp from "sharp";

// ── Layout tree types (output of Step 0 LLM) ────────────────────────

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutTree {
  viewport: { width: number; height: number };
  fontFamily: string;
  colors: Record<string, string>;
  tree: LayoutNode;
}

interface LayoutNode {
  // Common
  id?: string;
  type?: string; // "text" | "icon" | "chart" | "progress" | "image" | "toggleGroup" — containers have no type
  el?: string;
  name?: string;
  bbox?: Bbox;

  // Container
  layout?: string; // "row" | "column"
  width?: string;
  height?: string;
  flex?: string;
  bg?: string;
  fg?: string;
  padding?: string;
  gap?: string;
  align?: string;
  justify?: string;
  borderRadius?: string;
  shadow?: string;
  border?: string;
  overflow?: string;
  flexWrap?: string;
  children?: LayoutNode[];

  // Text
  text?: string;
  content?: string; // alias for text
  fontSize?: number | string;
  fontWeight?: number | string;
  color?: string;
  noWrap?: boolean;
  textAlign?: string;

  // Icon
  emoji?: string;
  size?: number | string;

  // Chart
  chartType?: string;
  series?: { name: string; color: string; values: number[] }[];
  xLabels?: string[];
  showArea?: boolean;
  showDots?: boolean;
  showGrid?: boolean;

  // Progress
  label?: string;
  value?: string;
  percent?: number;
  barColor?: string;
  trackColor?: string;

  // Image
  imagePrompt?: string;

  // Toggle group
  options?: { label: string; active?: boolean }[];
  activeBg?: string;
  activeFg?: string;
  inactiveFg?: string;
}

// ── Figma snapshot types ─────────────────────────────────────────────

interface SnapshotNode {
  id: string;
  name: string;
  type: "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE";
  x: number;
  y: number;
  width: number;
  height: number;
  childrenCount: number;

  // FRAME
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX";
  layoutSizingHorizontal?: "FIXED" | "FILL" | "HUG";
  layoutSizingVertical?: "FIXED" | "FILL" | "HUG";
  fillColor?: string;
  cornerRadius?: number;
  clipsContent?: boolean;
  opacity?: number;
  effects?: any[];
  strokeColor?: string;
  strokeWeight?: number;
  children?: SnapshotNode[];

  // TEXT
  characters?: string;
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  lineHeight?: number;

  // RECTANGLE / image
  imageData?: string; // base64 PNG
  imagePrompt?: string;

  // SVG
  svgMarkup?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

let _nodeCounter = 0;
function nextId(): string {
  return `sn-${++_nodeCounter}`;
}

function px(val: string | number | undefined, fallback = 0): number {
  if (val === undefined || val === null) return fallback;
  if (typeof val === "number") return val;
  const n = parseFloat(val);
  return isNaN(n) ? fallback : n;
}

function parsePadding(pad: string | undefined): { top: number; right: number; bottom: number; left: number } {
  if (!pad) return { top: 0, right: 0, bottom: 0, left: 0 };
  const parts = pad.replace(/px/g, "").trim().split(/\s+/).map(Number);
  if (parts.length === 1) return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  if (parts.length === 2) return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  if (parts.length === 3) return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  return { top: parts[0] || 0, right: parts[1] || 0, bottom: parts[2] || 0, left: parts[3] || 0 };
}

function fontWeightToStyle(fw: number | string | undefined): string {
  const w = typeof fw === "string" ? parseInt(fw, 10) : (fw || 400);
  if (w >= 700) return "Bold";
  if (w >= 600) return "Semi Bold";
  if (w >= 500) return "Medium";
  return "Regular";
}

function mapAlign(val: string | undefined): "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" {
  switch (val) {
    case "center": return "CENTER";
    case "end":
    case "flex-end": return "MAX";
    case "space-between": return "SPACE_BETWEEN";
    default: return "MIN";
  }
}

function mapCounterAlign(val: string | undefined): "MIN" | "CENTER" | "MAX" {
  switch (val) {
    case "center": return "CENTER";
    case "end":
    case "flex-end": return "MAX";
    default: return "MIN";
  }
}

function parseShadow(shadow: string | undefined): any[] | undefined {
  if (!shadow || shadow === "none") return undefined;
  // Parse simple box-shadow: offsetX offsetY blur spread color
  const m = shadow.match(/([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px\s+(?:([-\d.]+)px\s+)?(.+)/);
  if (!m) return undefined;
  const x = parseFloat(m[1]) || 0;
  const y = parseFloat(m[2]) || 0;
  const radius = parseFloat(m[3]) || 0;
  const spread = m[4] ? parseFloat(m[4]) : 0;
  // Parse color — just use a sensible default opacity
  return [{
    type: "DROP_SHADOW",
    radius,
    spread,
    offset: { x, y },
    color: { r: 0, g: 0, b: 0, a: 0.15 },
  }];
}

function parseBorderRadius(br: string | number | undefined): number {
  if (br === undefined || br === null) return 0;
  if (typeof br === "number") return br;
  if (br === "50%") return 9999; // Will be clamped to half-size by Figma
  return parseFloat(br) || 0;
}

/** Resolve a color reference — either a hex or a key into the colors map */
function resolveColor(color: string | undefined, colors: Record<string, string>): string | undefined {
  if (!color) return undefined;
  if (color.startsWith("#")) return color;
  // Check if it's a reference to the colors map
  if (colors[color]) return colors[color];
  return color;
}

// ── Cropping helper ──────────────────────────────────────────────────

async function cropRegion(
  refBuf: Buffer,
  imgW: number,
  imgH: number,
  bbox: Bbox
): Promise<string | null> {
  try {
    const left = Math.max(0, Math.round(bbox.x));
    const top = Math.max(0, Math.round(bbox.y));
    let width = Math.round(bbox.w);
    let height = Math.round(bbox.h);
    // Clamp to image bounds
    if (left + width > imgW) width = imgW - left;
    if (top + height > imgH) height = imgH - top;
    if (width <= 0 || height <= 0) return null;

    const cropped = await sharp(refBuf)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    return cropped.toString("base64");
  } catch (err) {
    console.warn(`[treeToSnapshot] crop failed at (${bbox.x},${bbox.y} ${bbox.w}x${bbox.h}):`, err);
    return null;
  }
}

// ── Main conversion function ─────────────────────────────────────────

export async function treeToSnapshot(
  layoutTree: LayoutTree,
  referenceImageBase64: string
): Promise<SnapshotNode> {
  _nodeCounter = 0;

  const refBuf = Buffer.from(referenceImageBase64, "base64");
  const meta = await sharp(refBuf).metadata();
  const imgW = meta.width || 1;
  const imgH = meta.height || 1;

  const viewport = layoutTree.viewport || { width: 1440, height: 900 };
  const fontFamily = layoutTree.fontFamily?.split(",")[0]?.trim() || "Inter";
  const colors = layoutTree.colors || {};

  // The LLM outputs bboxes in the coordinate system of the viewport it perceives.
  // For cropping from the actual image, we need to scale bbox coords → image pixel coords.
  // For Figma node dimensions, we use bbox values directly (they're already in viewport coords).
  const cropScaleX = imgW / viewport.width;
  const cropScaleY = imgH / viewport.height;

  console.log(`[treeToSnapshot] viewport=${viewport.width}x${viewport.height}, image=${imgW}x${imgH}, cropScale=${cropScaleX.toFixed(3)}x${cropScaleY.toFixed(3)}`);
  console.log(`[treeToSnapshot] fontFamily=${fontFamily}, ${Object.keys(colors).length} colors`);

  /** Scale a viewport-coordinate bbox to actual image pixel coordinates for cropping */
  function bboxToImageCoords(bbox: Bbox): Bbox {
    return {
      x: bbox.x * cropScaleX,
      y: bbox.y * cropScaleY,
      w: bbox.w * cropScaleX,
      h: bbox.h * cropScaleY,
    };
  }

  async function convert(node: LayoutNode, parentLayout?: string): Promise<SnapshotNode> {
    const nodeType = node.type;
    const bbox = node.bbox || { x: 0, y: 0, w: 100, h: 50 };

    // Use bbox dimensions directly for Figma — they're already in viewport coordinates
    const w = Math.max(1, Math.round(bbox.w));
    const h = Math.max(1, Math.round(bbox.h));

    let result: SnapshotNode;
    switch (nodeType) {
      case "text":
        result = convertText(node, w, h);
        break;
      case "icon":
        result = await convertIcon(node, bboxToImageCoords(bbox), w, h);
        break;
      case "chart":
        result = await convertChart(node, bboxToImageCoords(bbox), w, h);
        break;
      case "image":
        result = await convertImage(node, bboxToImageCoords(bbox), w, h);
        break;
      case "progress":
        result = convertProgress(node, w, h);
        break;
      case "toggleGroup":
        result = convertToggleGroup(node, w, h);
        break;
      default:
        // Container node (no type field, or unknown)
        result = await convertContainer(node, w, h);
        break;
    }

    // Apply parent-context sizing: children in a vertical parent should FILL width,
    // children in a horizontal parent with flex should FILL width
    if (parentLayout === "column" && result.type !== "TEXT") {
      // In a vertical parent, children should fill the parent width unless they have explicit fixed width
      if (!node.width || node.width === "100%" || node.width === "auto") {
        result.layoutSizingHorizontal = "FILL";
      }
    }
    if (parentLayout === "row" && result.type !== "TEXT") {
      // In a horizontal parent, flex children should fill
      if (node.flex === "1" || node.flex === "2" || node.flex === "3" || node.width === "100%") {
        result.layoutSizingHorizontal = "FILL";
      }
      // Children in a row with stretch alignment should fill vertically
      if (node.height === "100%" || node.height === "100vh") {
        result.layoutSizingVertical = "FILL";
      }
    }

    return result;
  }

  // ── Text node ──────────────────────────────────────────────────────

  function convertText(node: LayoutNode, w: number, h: number): SnapshotNode {
    const textContent = node.text || node.content || "";
    const fs = px(node.fontSize, 14);
    return {
      id: node.id || nextId(),
      name: textContent.slice(0, 30) || "text",
      type: "TEXT",
      x: 0,
      y: 0,
      width: w,
      height: Math.max(h, fs + 4),
      characters: textContent,
      fontSize: fs,
      fontFamily,
      fontStyle: fontWeightToStyle(node.fontWeight),
      fillColor: resolveColor(node.color, colors),
      textAlignHorizontal: (node.textAlign || "LEFT").toUpperCase(),
      // Text should HUG horizontally to avoid clipping; parent auto-layout controls width
      layoutSizingHorizontal: "HUG",
      layoutSizingVertical: "HUG",
      childrenCount: 0,
    };
  }

  // ── Icon node → crop from reference screenshot ─────────────────────

  async function convertIcon(node: LayoutNode, bbox: Bbox, w: number, h: number): Promise<SnapshotNode> {
    const base64 = await cropRegion(refBuf, imgW, imgH, bbox);
    const cr = parseBorderRadius(node.borderRadius);
    const snapNode: SnapshotNode = {
      id: node.id || nextId(),
      name: node.name || node.id || "icon",
      type: "RECTANGLE",
      x: 0,
      y: 0,
      width: w,
      height: h,
      cornerRadius: cr,
      childrenCount: 0,
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
    };

    if (base64) {
      snapNode.imageData = base64;
      console.log(`[treeToSnapshot] icon "${node.id}" cropped: ${w}x${h}px`);
    } else {
      // Fallback: colored rectangle with the icon's bg color
      snapNode.fillColor = resolveColor(node.bg, colors);
      console.warn(`[treeToSnapshot] icon "${node.id}" crop failed, using fallback color`);
    }

    return snapNode;
  }

  // ── Chart node → crop entire chart area from reference ─────────────

  async function convertChart(node: LayoutNode, bbox: Bbox, w: number, h: number): Promise<SnapshotNode> {
    const base64 = await cropRegion(refBuf, imgW, imgH, bbox);
    const snapNode: SnapshotNode = {
      id: node.id || nextId(),
      name: node.name || "chart",
      type: "RECTANGLE",
      x: 0,
      y: 0,
      width: w,
      height: h,
      cornerRadius: 0,
      childrenCount: 0,
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "FIXED",
    };

    if (base64) {
      snapNode.imageData = base64;
      console.log(`[treeToSnapshot] chart cropped: ${w}x${h}px`);
    } else {
      snapNode.fillColor = "#f0f0f0";
    }
    return snapNode;
  }

  // ── Image node → crop from reference or use imagePrompt ────────────

  async function convertImage(node: LayoutNode, bbox: Bbox, w: number, h: number): Promise<SnapshotNode> {
    const cr = parseBorderRadius(node.borderRadius);
    const snapNode: SnapshotNode = {
      id: node.id || nextId(),
      name: node.name || "image",
      type: "RECTANGLE",
      x: 0,
      y: 0,
      width: w,
      height: h,
      cornerRadius: cr,
      childrenCount: 0,
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
    };

    // Try cropping from reference first
    const base64 = await cropRegion(refBuf, imgW, imgH, bbox);
    if (base64) {
      snapNode.imageData = base64;
    } else if (node.imagePrompt) {
      snapNode.imagePrompt = node.imagePrompt;
    }
    return snapNode;
  }

  // ── Progress bar node → label row + track bar, all as Figma frames ─

  function convertProgress(node: LayoutNode, w: number, h: number): SnapshotNode {
    const percent = node.percent || 50;
    const barH = 8;
    const labelH = 20;
    const barColor = resolveColor(node.barColor, colors) || "#6366f1";
    const trackColor = resolveColor(node.trackColor, colors) || "#e5e7eb";

    // Label row: "Housing" ... "$1,400 / $1,500"
    const labelText: SnapshotNode = {
      id: nextId(),
      name: node.label || "label",
      type: "TEXT",
      x: 0, y: 0,
      width: Math.round(w * 0.5),
      height: labelH,
      characters: node.label || "",
      fontSize: 14,
      fontFamily,
      fontStyle: "Semi Bold",
      fillColor: resolveColor(node.color, colors) || "#1f2937",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      childrenCount: 0,
    };

    const valueText: SnapshotNode = {
      id: nextId(),
      name: node.value || "value",
      type: "TEXT",
      x: 0, y: 0,
      width: Math.round(w * 0.5),
      height: labelH,
      characters: node.value || "",
      fontSize: 13,
      fontFamily,
      fontStyle: "Regular",
      fillColor: "#8b8fa8",
      textAlignHorizontal: "RIGHT",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      childrenCount: 0,
    };

    const labelRow: SnapshotNode = {
      id: nextId(),
      name: "progress-label-row",
      type: "FRAME",
      x: 0, y: 0,
      width: w,
      height: labelH,
      layoutMode: "HORIZONTAL",
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER",
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      childrenCount: 2,
      children: [labelText, valueText],
    };

    // Track bar
    const fillWidth = Math.round((w * percent) / 100);

    const fillBar: SnapshotNode = {
      id: nextId(),
      name: "progress-fill",
      type: "RECTANGLE",
      x: 0, y: 0,
      width: fillWidth,
      height: barH,
      fillColor: barColor,
      cornerRadius: 4,
      childrenCount: 0,
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
    };

    const track: SnapshotNode = {
      id: nextId(),
      name: "progress-track",
      type: "FRAME",
      x: 0, y: 0,
      width: w,
      height: barH,
      layoutMode: "HORIZONTAL",
      fillColor: trackColor,
      cornerRadius: 4,
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "FIXED",
      clipsContent: true,
      childrenCount: 1,
      children: [fillBar],
    };

    return {
      id: node.id || nextId(),
      name: node.label || "progress-bar",
      type: "FRAME",
      x: 0, y: 0,
      width: w,
      height: h,
      layoutMode: "VERTICAL",
      itemSpacing: 6,
      layoutSizingHorizontal: "FILL",
      layoutSizingVertical: "HUG",
      childrenCount: 2,
      children: [labelRow, track],
    };
  }

  // ── Toggle group → horizontal frame with button children ───────────

  function convertToggleGroup(node: LayoutNode, w: number, h: number): SnapshotNode {
    const opts = node.options || [];
    const bgColor = resolveColor(node.bg, colors) || "#f3f4f6";
    const activeBg = resolveColor(node.activeBg, colors) || "#6366f1";
    const activeFg = resolveColor(node.activeFg, colors) || "#ffffff";
    const inactiveFg = resolveColor(node.inactiveFg, colors) || "#6b7280";
    const cr = parseBorderRadius(node.borderRadius);
    const fs = px(node.fontSize, 14);

    const btnWidth = opts.length > 0 ? Math.round((w - 6) / opts.length) : 60;
    const btnHeight = Math.max(h - 6, 28);

    const buttons: SnapshotNode[] = opts.map((opt) => {
      const isActive = !!opt.active;
      return {
        id: nextId(),
        name: opt.label,
        type: "FRAME" as const,
        x: 0, y: 0,
        width: btnWidth,
        height: btnHeight,
        layoutMode: "HORIZONTAL" as const,
        primaryAxisAlignItems: "CENTER" as const,
        counterAxisAlignItems: "CENTER" as const,
        fillColor: isActive ? activeBg : undefined,
        cornerRadius: Math.max(cr - 2, 4),
        layoutSizingHorizontal: "FILL" as const,
        layoutSizingVertical: "FILL" as const,
        childrenCount: 1,
        children: [{
          id: nextId(),
          name: opt.label,
          type: "TEXT" as const,
          x: 0, y: 0,
          width: btnWidth - 16,
          height: fs + 4,
          characters: opt.label,
          fontSize: fs,
          fontFamily,
          fontStyle: isActive ? "Semi Bold" : "Medium",
          fillColor: isActive ? activeFg : inactiveFg,
          textAlignHorizontal: "CENTER",
          layoutSizingHorizontal: "HUG" as const,
          layoutSizingVertical: "HUG" as const,
          childrenCount: 0,
        }],
      };
    });

    return {
      id: node.id || nextId(),
      name: "toggle-group",
      type: "FRAME",
      x: 0, y: 0,
      width: w,
      height: h,
      layoutMode: "HORIZONTAL",
      fillColor: bgColor,
      cornerRadius: cr,
      paddingTop: 3,
      paddingRight: 3,
      paddingBottom: 3,
      paddingLeft: 3,
      itemSpacing: 0,
      layoutSizingHorizontal: "HUG",
      layoutSizingVertical: "HUG",
      childrenCount: buttons.length,
      children: buttons,
    };
  }

  // ── Container node → FRAME with auto-layout ────────────────────────

  async function convertContainer(node: LayoutNode, w: number, h: number): Promise<SnapshotNode> {
    const layoutDir = node.layout === "row" ? "HORIZONTAL" : "VERTICAL";
    const pad = parsePadding(node.padding);
    const gap = px(node.gap, 0);
    const cr = parseBorderRadius(node.borderRadius);
    const bgColor = resolveColor(node.bg, colors);
    const effects = parseShadow(node.shadow);

    // Determine sizing based on flex/width
    let sizingH: "FIXED" | "FILL" | "HUG" = "HUG";
    if (node.flex === "1" || node.flex === "2" || node.flex === "3") {
      sizingH = "FILL";
    } else if (node.width === "100%" || node.width === "auto") {
      sizingH = "FILL";
    } else if (node.width && node.width !== "auto" && !node.width.includes("%")) {
      // Explicit pixel width like "180px" → FIXED
      sizingH = "FIXED";
    }

    let sizingV: "FIXED" | "FILL" | "HUG" = "HUG";
    if (node.height === "100vh" || node.height === "100%") {
      sizingV = "FILL";
    } else if (node.height && node.height !== "auto" && !node.height.includes("%")) {
      // Explicit pixel height → FIXED
      sizingV = "FIXED";
    }

    // Convert children, passing current layout direction for context-aware sizing
    const childNodes = node.children || [];
    const children: SnapshotNode[] = [];
    for (const child of childNodes) {
      const childSnap = await convert(child, node.layout);
      children.push(childSnap);
    }

    // Parse border for stroke
    let strokeColor: string | undefined;
    let strokeWeight: number | undefined;
    if (node.border) {
      const bm = node.border.match(/([\d.]+)px\s+\w+\s+(#[0-9a-fA-F]{3,8})/);
      if (bm) {
        strokeWeight = parseFloat(bm[1]);
        strokeColor = bm[2];
      }
    }

    const frame: SnapshotNode = {
      id: node.id || nextId(),
      name: node.name || node.id || "container",
      type: "FRAME",
      x: 0,
      y: 0,
      width: w,
      height: h,
      layoutMode: layoutDir,
      paddingTop: pad.top,
      paddingRight: pad.right,
      paddingBottom: pad.bottom,
      paddingLeft: pad.left,
      itemSpacing: gap,
      primaryAxisAlignItems: mapAlign(node.justify),
      counterAxisAlignItems: mapCounterAlign(node.align),
      layoutSizingHorizontal: sizingH,
      layoutSizingVertical: sizingV,
      fillColor: bgColor,
      cornerRadius: cr,
      clipsContent: node.overflow === "hidden" ? true : undefined,
      childrenCount: children.length,
      children: children.length > 0 ? children : undefined,
    };

    if (effects) frame.effects = effects;
    if (strokeColor) {
      frame.strokeColor = strokeColor;
      frame.strokeWeight = strokeWeight;
    }

    return frame;
  }

  // ── Root conversion ────────────────────────────────────────────────

  const rootNode = layoutTree.tree;
  if (!rootNode) {
    throw new Error("Layout tree has no root node");
  }

  const snapshot = await convert(rootNode, undefined);

  // Ensure root is properly sized and clips content
  snapshot.width = viewport.width;
  snapshot.height = viewport.height;
  snapshot.layoutSizingHorizontal = "FIXED";
  snapshot.layoutSizingVertical = "FIXED";
  snapshot.clipsContent = true;

  // Count total nodes for logging
  let totalNodes = 0;
  let imageNodes = 0;
  function countNodes(n: SnapshotNode) {
    totalNodes++;
    if (n.imageData) imageNodes++;
    if (n.children) n.children.forEach(countNodes);
  }
  countNodes(snapshot);

  console.log(`[treeToSnapshot] Conversion complete: ${totalNodes} nodes, ${imageNodes} with images`);

  return snapshot;
}
