// figma-plugin/code.ts
// Main Figma plugin logic – runs in the Figma sandbox.
// Responsibilities:
//   1. Extract selection snapshot
//   2. Extract design-system snapshot
//   3. Forward intent + snapshots to the backend
//   4. Validate & apply returned operations
//   5. Audit-log changes
//   6. Support revert

import {
  NodeSnapshot,
  SelectionSnapshot,
  DesignSystemSnapshot,
  BackendPayload,
  UIToPluginMessage,
  PluginToUIMessage,
  AuditLogEntry,
  AuditFinding,
  RevertState,
} from "./types";
import { Operation, OperationBatch } from "../shared/operationSchema";

// ── Configuration ───────────────────────────────────────────────────

const CHANGE_LOG_FRAME_NAME = "AI Change Log";

// ── State ───────────────────────────────────────────────────────────

let lastRevertState: RevertState | null = null;
let _skipResizePropagation = false;
let _cancelled = false;
let _working = false;
let _userApiKey = "";
let _selectedProvider = "anthropic";
let _selectedModel = "claude-sonnet-4-20250514";

// ── Extraction caching ──────────────────────────────────────────────
// Caches the expensive tree-walking results so rapid cancel+re-generate
// doesn't freeze the UI for 30+ seconds waiting for extractDesignSystemSnapshot.
const CACHE_TTL_MS = 60_000; // 60 seconds
let _designSystemCache: { data: DesignSystemSnapshot; ts: number } | null = null;
// Separate cache for raw extracted data (before prompt-dependent reference selection)
let _rawTokenCache: {
  ts: number;
  colors: string[];
  cornerRadii: number[];
  fontSizes: number[];
  fontFamilies: string[];
  spacings: number[];
  paddings: number[];
  buttonStyles: any[];
  inputStyles: any[];
  rootFrameLayouts: any[];
  designFramesMeta: { name: string; height: number; childrenCount: number; nodeId: string }[];
} | null = null;

/** Yield to the event loop so Figma can process UI events (cancel clicks). */
function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ── Fetch-via-UI promise (UI iframe has real AbortController) ────────
let _fetchSeq = 0; // monotonic counter to match responses to requests
let _pendingFetch: {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  seq: number;
} | null = null;

/** Ask the UI iframe to do the HTTP call (has real AbortController). */
function fetchViaUI(endpoint: string, body: any): Promise<any> {
  const seq = ++_fetchSeq;
  return new Promise((resolve, reject) => {
    _pendingFetch = { resolve, reject, seq };
    // JSON round-trip strips Symbols and other non-serializable Figma
    // values that would cause "Cannot unwrap symbol" in postMessage.
    const safeBody = JSON.parse(JSON.stringify(body));
    sendToUI({ type: "do-fetch", endpoint, body: safeBody, seq } as any);
  });
}

// ── Parallel Generate Jobs ──────────────────────────────────────────
// Multiple generate jobs can run concurrently. Each has its own cancel
// flag, and its own pending fetch tracked in _pendingFetches.

let _nextJobId = 0;
interface GenerateJobState {
  id: number;
  cancelled: boolean;
}
const _activeJobs = new Map<number, GenerateJobState>();

// Parallel-safe fetch tracking (keyed by seq, separate from _pendingFetch)
const _pendingFetches = new Map<number, {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  jobId: number;
}>();

/** Parallel-safe fetch for generate jobs. */
function fetchViaUIForJob(endpoint: string, body: any, jobId: number): Promise<any> {
  const seq = ++_fetchSeq;
  return new Promise((resolve, reject) => {
    _pendingFetches.set(seq, { resolve, reject, jobId });
    const safeBody = JSON.parse(JSON.stringify(body));
    sendToUI({ type: "do-fetch", endpoint, body: safeBody, seq, jobId } as any);
  });
}

// Track next X position for frame placement (avoids overlap with parallel jobs)
let _nextPlaceX: number | null = null;

// ── Show UI ─────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 340, height: 280, title: "Uno Design Assistant" });

// Clean up any leftover audit badges from a previous session
clearAuditBadges();

// ── Helpers: send message to UI ─────────────────────────────────────

function sendToUI(msg: PluginToUIMessage): void {
  figma.ui.postMessage(msg);
}

// ── 1. Extract Selection Snapshot ───────────────────────────────────

const MAX_SNAPSHOT_DEPTH = 15;

/**
 * Recursively strip imageData from a snapshot tree to reduce payload size
 * when sending design context to the LLM.
 */
function stripImageData(snap: any): void {
  if (!snap) return;
  delete snap.imageData;
  if (Array.isArray(snap.children)) {
    for (const child of snap.children) stripImageData(child);
  }
}

/**
 * Assign temp IDs to an AI-generated snapshot tree so createNodeFromSnapshot
 * can process it (it expects every node to have an id).
 */
let _tempIdCounter = 0;
function assignTempIds(snap: any): void {
  if (!snap) return;
  snap.id = `gen_${++_tempIdCounter}`;
  if (Array.isArray(snap.children)) {
    for (const child of snap.children) assignTempIds(child);
  }
}

/**
 * Extract compact style tokens from existing page frames.
 * Walks the node tree and collects actual values for colors, corner radii,
 * font sizes, spacing, etc. so the LLM can match the design system.
 */
function extractStyleTokens(userPrompt?: string): Record<string, any> {
  // If raw cache is fresh, skip the expensive tree walk but ALWAYS
  // recompute reference frame selection & style prioritization based on prompt.
  const hasFreshRawCache = _rawTokenCache && (Date.now() - _rawTokenCache.ts) < CACHE_TTL_MS;
  if (hasFreshRawCache) {
    console.log("[extractStyleTokens] Using cached raw data (age: " + Math.round((Date.now() - _rawTokenCache!.ts) / 1000) + "s), recomputing reference for prompt");
    return _buildFinalTokens(
      _rawTokenCache!.colors,
      _rawTokenCache!.cornerRadii,
      _rawTokenCache!.fontSizes,
      _rawTokenCache!.fontFamilies,
      _rawTokenCache!.spacings,
      _rawTokenCache!.paddings,
      _rawTokenCache!.buttonStyles,
      _rawTokenCache!.inputStyles,
      _rawTokenCache!.rootFrameLayouts,
      _rawTokenCache!.designFramesMeta,
      userPrompt,
    );
  }

  const colors = new Set<string>();
  const cornerRadii = new Set<number>();
  const fontSizes = new Set<number>();
  const fontFamilies = new Set<string>();
  const spacings = new Set<number>();
  const paddings = new Set<number>();
  const buttonStyles: any[] = [];
  const inputStyles: any[] = [];

  // Include FRAME, COMPONENT, COMPONENT_SET, SECTION — original designs may use any of these
  const validTopLevelTypes = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"]);
  const pageFrames = figma.currentPage.children.filter(
    (c) => validTopLevelTypes.has(c.type) && c.name !== CHANGE_LOG_FRAME_NAME
  );

  // Log top-level node types to help debug detection issues
  console.log("[extractStyleTokens] Top-level nodes:", figma.currentPage.children.map(c => `${c.name} (${c.type})`).join(", "));

  // Helper: convert solid fill to hex
  function solidToHex(fills: readonly Paint[]): string | undefined {
    const s = Array.isArray(fills) ? fills.find(f => f.type === "SOLID" && f.visible !== false) : undefined;
    if (s && s.type === "SOLID") {
      const c = s.color;
      return "#" + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
    }
    return undefined;
  }

  // Helper: check if a node has text children (up to 4 levels deep)
  function findTextChild(node: SceneNode, maxDepth: number = 4): TextNode | null {
    if (!("children" in node)) return null;
    function search(n: SceneNode, depth: number): TextNode | null {
      if (depth > maxDepth) return null;
      if (!("children" in n)) return null;
      for (const child of (n as any).children) {
        if (child.type === "TEXT") return child as TextNode;
        const deeper = search(child, depth + 1);
        if (deeper) return deeper;
      }
      return null;
    }
    return search(node, 0);
  }

  // Helper: count text descendants 
  function countTextDescendants(node: SceneNode): number {
    let count = 0;
    if (node.type === "TEXT") count++;
    if ("children" in node) {
      for (const child of (node as any).children) {
        count += countTextDescendants(child);
      }
    }
    return count;
  }

  // Helper: extract text props from a TextNode
  function extractTextProps(tn: TextNode): any {
    const props: any = {};
    try {
      const tFills = tn.fills as Paint[];
      const tHex = solidToHex(tFills);
      if (tHex) props.textColor = tHex;
    } catch (_) {}
    if (typeof tn.fontSize === "number") props.textFontSize = tn.fontSize;
    if (typeof tn.fontName !== "symbol" && tn.fontName) {
      props.textFontFamily = (tn.fontName as FontName).family;
      props.textFontStyle = (tn.fontName as FontName).style;
    }
    if (tn.textDecoration && tn.textDecoration !== "NONE") {
      props.textDecoration = tn.textDecoration;
    }
    if (tn.textAlignHorizontal) props.textAlignHorizontal = tn.textAlignHorizontal;
    return props;
  }

  let currentRootFrameName = "";
  function walkNode(node: SceneNode, depth: number): void {
    if (depth > 6) return;

    // Collect fill colors
    if ("fills" in node && Array.isArray(node.fills)) {
      const hex = solidToHex(node.fills as Paint[]);
      if (hex) colors.add(hex);
    }

    // Collect corner radius
    if ("cornerRadius" in node && typeof (node as any).cornerRadius === "number" && (node as any).cornerRadius > 0) {
      cornerRadii.add((node as any).cornerRadius);
    }

    // Collect font info from text nodes
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      if (typeof textNode.fontSize === "number") fontSizes.add(textNode.fontSize);
      if (typeof textNode.fontName !== "symbol" && textNode.fontName) {
        fontFamilies.add((textNode.fontName as FontName).family);
      }
    }

    // Collect spacing/padding from auto-layout frames
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
      const frame = node as FrameNode;
      if (frame.layoutMode && frame.layoutMode !== "NONE") {
        if (frame.itemSpacing > 0) spacings.add(frame.itemSpacing);
        if (frame.paddingTop > 0) paddings.add(frame.paddingTop);
        if (frame.paddingRight > 0) paddings.add(frame.paddingRight);
        if (frame.paddingBottom > 0) paddings.add(frame.paddingBottom);
        if (frame.paddingLeft > 0) paddings.add(frame.paddingLeft);
      }

      // ── Name-based classification ──
      const nameLower = frame.name.toLowerCase();
      const isInputByName = /textbox|passwordbox|\binput\b|searchbox|text.?field/.test(nameLower);
      const isButtonByName = /^button$/i.test(frame.name) || /\bbutton\b/i.test(frame.name);
      const isExcludedFromButton = /navigationbar|\btab|tabbar|tabsstack|personpicture|avatar|chipgroup|template\//.test(nameLower);
      // Fills that indicate backgrounds/inputs, not buttons
      const nonButtonFills = new Set(["#FFFFFF", "#FCFBFF", "#F5F5F5", "#F0F0F0", "#F3EFF5", "#E5DEFF", "#1C1B1F"]);

      // ── Input detection (name-based, runs first) ──
      if (isInputByName && frame.height >= 35 && frame.height <= 70) {
        const textChild = findTextChild(node);
        if (textChild) {
          const fillHex = solidToHex(frame.fills as Paint[]);
          const strokeHex = solidToHex(frame.strokes as Paint[]);
          const inputStyle: any = {
            name: frame.name,
            cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : undefined,
            height: Math.round(frame.height),
            width: Math.round(frame.width),
          };
          if (fillHex) inputStyle.fillColor = fillHex;
          if (strokeHex) {
            inputStyle.strokeColor = strokeHex;
            if (typeof frame.strokeWeight === "number") inputStyle.strokeWeight = frame.strokeWeight;
          }
          // Check for individual stroke sides (bottom border, etc)
          const stw = {
            top: (frame as any).strokeTopWeight || 0,
            right: (frame as any).strokeRightWeight || 0,
            bottom: (frame as any).strokeBottomWeight || 0,
            left: (frame as any).strokeLeftWeight || 0,
          };
          if (stw.bottom > 0 && stw.top === 0 && stw.left === 0 && stw.right === 0) {
            inputStyle.bottomBorderOnly = true;
            inputStyle.bottomBorderWeight = stw.bottom;
          }
          if (frame.layoutMode && frame.layoutMode !== "NONE") {
            inputStyle.layoutMode = frame.layoutMode;
            inputStyle.paddingTop = frame.paddingTop;
            inputStyle.paddingBottom = frame.paddingBottom;
            inputStyle.paddingLeft = frame.paddingLeft;
            inputStyle.paddingRight = frame.paddingRight;
            inputStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
            inputStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
          }
          Object.assign(inputStyle, extractTextProps(textChild));
          inputStyle._sourceFrame = currentRootFrameName;
          inputStyles.push(inputStyle);
        }
      }
      // ── Button detection ──
      // Name-based buttons: explicitly named "Button" — always capture regardless of size
      // Structural buttons: frame with solid fill, text, height 30-75px, not an input/nav
      else if (!isInputByName && !isExcludedFromButton && (isButtonByName || (frame.height >= 30 && frame.height <= 75))) {
        const fillHex = solidToHex(frame.fills as Paint[]);
        const textChild = findTextChild(node);
        // Must have a non-background fill and text
        if (fillHex && textChild && !nonButtonFills.has(fillHex)) {
          const textCount = countTextDescendants(node);
          // Buttons have 1-3 text items; name-based buttons skip width check
          if (textCount <= 3) {
            const btnStyle: any = {
              name: frame.name,
              cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : undefined,
              fillColor: fillHex,
              height: Math.round(frame.height),
              width: Math.round(frame.width),
            };
            if (frame.layoutMode && frame.layoutMode !== "NONE") {
              btnStyle.layoutMode = frame.layoutMode;
              btnStyle.paddingTop = frame.paddingTop;
              btnStyle.paddingBottom = frame.paddingBottom;
              btnStyle.paddingLeft = frame.paddingLeft;
              btnStyle.paddingRight = frame.paddingRight;
              btnStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
              btnStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
            }
            // Capture sizing mode (FILL, FIXED, HUG) — critical for full-width buttons
            if ((frame as any).layoutSizingHorizontal) btnStyle.layoutSizingHorizontal = (frame as any).layoutSizingHorizontal;
            if ((frame as any).layoutSizingVertical) btnStyle.layoutSizingVertical = (frame as any).layoutSizingVertical;
            Object.assign(btnStyle, extractTextProps(textChild));
            btnStyle._sourceFrame = currentRootFrameName;
            buttonStyles.push(btnStyle);
          }
        }
        // Also detect outline buttons: stroke + text, no saturated fill
        if (!fillHex || nonButtonFills.has(fillHex)) {
          const strokeHex = solidToHex(frame.strokes as Paint[]);
          if (strokeHex && textChild && isButtonByName) {
            const textCount = countTextDescendants(node);
            if (textCount <= 3) {
              const btnStyle: any = {
                name: frame.name,
                cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : undefined,
                fillColor: fillHex || "#FFFFFF",
                strokeColor: strokeHex,
                strokeWeight: typeof frame.strokeWeight === "number" ? frame.strokeWeight : 1,
                height: Math.round(frame.height),
                width: Math.round(frame.width),
              };
              if (frame.layoutMode && frame.layoutMode !== "NONE") {
                btnStyle.layoutMode = frame.layoutMode;
                btnStyle.paddingTop = frame.paddingTop;
                btnStyle.paddingBottom = frame.paddingBottom;
                btnStyle.paddingLeft = frame.paddingLeft;
                btnStyle.paddingRight = frame.paddingRight;
                btnStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
                btnStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
              }
              if ((frame as any).layoutSizingHorizontal) btnStyle.layoutSizingHorizontal = (frame as any).layoutSizingHorizontal;
              if ((frame as any).layoutSizingVertical) btnStyle.layoutSizingVertical = (frame as any).layoutSizingVertical;
              Object.assign(btnStyle, extractTextProps(textChild));
              btnStyle._sourceFrame = currentRootFrameName;
              buttonStyles.push(btnStyle);
            }
          }
        }
      }
      // ── Structural input detection (fallback for unnamed inputs) ──
      // Frame 35-70px tall, has text, has fill/stroke, not a button
      else if (frame.height >= 35 && frame.height <= 70 && !isInputByName && !isButtonByName && !isExcludedFromButton) {
        const textChild = findTextChild(node);
        const textSize = textChild && typeof textChild.fontSize === "number" ? textChild.fontSize : 0;
        if (textChild && countTextDescendants(node) <= 3 && textSize <= 16) {
          const fillHex = solidToHex(frame.fills as Paint[]);
          const strokeHex = solidToHex(frame.strokes as Paint[]);
          // Check for bottom-only border
          let bottomBorderWeight = 0;
          let strokeInfo: any = {};
          const stw = {
            top: (frame as any).strokeTopWeight || 0,
            right: (frame as any).strokeRightWeight || 0,
            bottom: (frame as any).strokeBottomWeight || 0,
            left: (frame as any).strokeLeftWeight || 0,
          };
          if (stw.bottom > 0 && stw.top === 0 && stw.left === 0 && stw.right === 0) {
            bottomBorderWeight = stw.bottom;
            strokeInfo.bottomBorderOnly = true;
            strokeInfo.bottomBorderWeight = bottomBorderWeight;
          }
          const isInput = (fillHex && nonButtonFills.has(fillHex)) || strokeHex || bottomBorderWeight > 0;
          if (isInput) {
            const inputStyle: any = {
              name: frame.name,
              cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : undefined,
              height: Math.round(frame.height),
              width: Math.round(frame.width),
            };
            if (fillHex) inputStyle.fillColor = fillHex;
            if (strokeHex) {
              inputStyle.strokeColor = strokeHex;
              if (typeof frame.strokeWeight === "number") inputStyle.strokeWeight = frame.strokeWeight;
            }
            Object.assign(inputStyle, strokeInfo);
            if (frame.layoutMode && frame.layoutMode !== "NONE") {
              inputStyle.layoutMode = frame.layoutMode;
              inputStyle.paddingTop = frame.paddingTop;
              inputStyle.paddingBottom = frame.paddingBottom;
              inputStyle.paddingLeft = frame.paddingLeft;
              inputStyle.paddingRight = frame.paddingRight;
              inputStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
              inputStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
            }
            Object.assign(inputStyle, extractTextProps(textChild));
            inputStyle._sourceFrame = currentRootFrameName;
            inputStyles.push(inputStyle);
          }
        }
      }
    }

    // Recurse into children
    if ("children" in node) {
      for (const child of (node as any).children) {
        walkNode(child, depth + 1);
      }
    }
  }

  // Walk ORIGINAL page frames only — skip generated output and non-design frames
  const designFrames = pageFrames.filter(f => {
    // Skip name-based patterns
    if (f.name.startsWith("Generation ") || f.name.startsWith("Try the plugin")) return false;
    // Skip frames tagged as generated by this plugin
    if ("getPluginData" in f && (f as SceneNode).getPluginData("generated") === "true") return false;
    return true;
  });
  console.log("[extractStyleTokens] Walking", designFrames.length, "design frames (skipping generated):", designFrames.map(f => `${f.name} (${f.type})`).join(", "));
  for (const frame of designFrames) {
    currentRootFrameName = frame.name;
    walkNode(frame, 0);
  }
  console.log("[extractStyleTokens] Found", buttonStyles.length, "buttons:", JSON.stringify(buttonStyles));
  console.log("[extractStyleTokens] Found", inputStyles.length, "inputs:", JSON.stringify(inputStyles));

  // Extract root frame layout info (page-level padding, dimensions) — sample up to 5
  const rootFrameLayouts: any[] = [];
  for (const frame of designFrames.slice(0, 5)) {
    if ("layoutMode" in frame) {
      const f = frame as FrameNode;
      const layout: any = {
        name: f.name,
        width: Math.round(f.width),
        height: Math.round(f.height),
      };
      if (f.layoutMode && f.layoutMode !== "NONE") {
        layout.layoutMode = f.layoutMode;
        layout.paddingTop = f.paddingTop;
        layout.paddingRight = f.paddingRight;
        layout.paddingBottom = f.paddingBottom;
        layout.paddingLeft = f.paddingLeft;
        layout.itemSpacing = f.itemSpacing;
        layout.primaryAxisAlignItems = f.primaryAxisAlignItems;
        layout.counterAxisAlignItems = f.counterAxisAlignItems;
      }
      // Root frame fill
      const fills = f.fills as Paint[];
      const solidFill = Array.isArray(fills) ? fills.find(fl => fl.type === "SOLID" && fl.visible !== false) : undefined;
      if (solidFill && solidFill.type === "SOLID") {
        const c = solidFill.color;
        layout.fillColor = "#" + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
      }
      rootFrameLayouts.push(layout);
    }
  }

  // Build design frame metadata for reference selection (cached for later prompt-aware reuse)
  const designFramesMeta = designFrames
    .filter(f => "children" in f && (f as FrameNode).height >= 500 && (f as any).children.length >= 3)
    .map(f => ({
      name: f.name,
      height: Math.round((f as FrameNode).height),
      childrenCount: (f as any).children.length,
      nodeId: f.id,
    }));

  // Cache raw extracted data (before prompt-dependent reference selection)
  _rawTokenCache = {
    ts: Date.now(),
    colors: [...colors],
    cornerRadii: [...cornerRadii].sort((a, b) => a - b),
    fontSizes: [...fontSizes].sort((a, b) => a - b),
    fontFamilies: [...fontFamilies],
    spacings: [...spacings].sort((a, b) => a - b),
    paddings: [...paddings].sort((a, b) => a - b),
    buttonStyles: buttonStyles.map(b => ({ ...b })), // preserve _sourceFrame
    inputStyles: inputStyles.map(i => ({ ...i })),   // preserve _sourceFrame
    rootFrameLayouts,
    designFramesMeta,
  };

  return _buildFinalTokens(
    _rawTokenCache.colors,
    _rawTokenCache.cornerRadii,
    _rawTokenCache.fontSizes,
    _rawTokenCache.fontFamilies,
    _rawTokenCache.spacings,
    _rawTokenCache.paddings,
    _rawTokenCache.buttonStyles,
    _rawTokenCache.inputStyles,
    _rawTokenCache.rootFrameLayouts,
    _rawTokenCache.designFramesMeta,
    userPrompt,
  );
}

// ── Compact snapshot helper (module-level for reuse) ──
function _compactSnapshot(node: SceneNode, depth: number, maxDepth: number): any | null {
  if (depth > maxDepth) return null;
  const snap: any = { name: node.name, type: node.type };

  // Size (skip position to save tokens)
  snap.width = Math.round(node.width);
  snap.height = Math.round(node.height);

  // Layout properties
  if ("layoutMode" in node) {
    const frame = node as FrameNode;
    const lm = frame.layoutMode;
    if (lm === "HORIZONTAL" || lm === "VERTICAL") {
      snap.layoutMode = lm;
      if (frame.paddingTop > 0) snap.paddingTop = frame.paddingTop;
      if (frame.paddingRight > 0) snap.paddingRight = frame.paddingRight;
      if (frame.paddingBottom > 0) snap.paddingBottom = frame.paddingBottom;
      if (frame.paddingLeft > 0) snap.paddingLeft = frame.paddingLeft;
      if (frame.itemSpacing > 0) snap.itemSpacing = frame.itemSpacing;
      snap.primaryAxisAlignItems = frame.primaryAxisAlignItems;
      snap.counterAxisAlignItems = frame.counterAxisAlignItems;
      if ("layoutSizingHorizontal" in frame) {
        snap.layoutSizingHorizontal = (frame as any).layoutSizingHorizontal;
        snap.layoutSizingVertical = (frame as any).layoutSizingVertical;
      }
    }
  }

  // Fill
  if ("fills" in node) {
    try {
      const fills = (node as GeometryMixin).fills;
      if (Array.isArray(fills) && fills.length > 0) {
        const sf = fills.find((f: Paint) => f.type === "SOLID" && f.visible !== false) as SolidPaint | undefined;
        if (sf) {
          const toH = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
          snap.fillColor = `#${toH(sf.color.r)}${toH(sf.color.g)}${toH(sf.color.b)}`.toUpperCase();
        }
      }
    } catch (_) {}
  }

  // Corner radius
  if ("cornerRadius" in node) {
    const cr = (node as any).cornerRadius;
    if (typeof cr === "number" && cr > 0) snap.cornerRadius = cr;
  }

  // Strokes
  if ("strokes" in node) {
    try {
      const strokes = (node as GeometryMixin).strokes;
      if (Array.isArray(strokes) && strokes.length > 0) {
        const ss = strokes.find((s: Paint) => s.type === "SOLID" && s.visible !== false) as SolidPaint | undefined;
        if (ss) {
          const toH = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
          snap.strokeColor = `#${toH(ss.color.r)}${toH(ss.color.g)}${toH(ss.color.b)}`.toUpperCase();
          const sw = (node as any).strokeWeight;
          if (typeof sw === "number" && sw > 0) snap.strokeWeight = sw;
          // Individual stroke weights
          const stw = (node as any).strokeTopWeight;
          if (typeof stw === "number") {
            const top = stw || 0, right = (node as any).strokeRightWeight || 0;
            const bottom = (node as any).strokeBottomWeight || 0, left = (node as any).strokeLeftWeight || 0;
            if (top !== bottom || left !== right || top !== left) {
              snap.strokeTopWeight = top; snap.strokeRightWeight = right;
              snap.strokeBottomWeight = bottom; snap.strokeLeftWeight = left;
            }
          }
        }
      }
    } catch (_) {}
  }

  // Text properties
  if (node.type === "TEXT") {
    const tn = node as TextNode;
    snap.characters = tn.characters;
    if (typeof tn.fontSize === "number") snap.fontSize = tn.fontSize;
    if (typeof tn.fontName !== "symbol" && tn.fontName) {
      snap.fontFamily = (tn.fontName as FontName).family;
      snap.fontStyle = (tn.fontName as FontName).style;
    }
    snap.textAlignHorizontal = tn.textAlignHorizontal;
    try {
      const tFills = tn.fills as Paint[];
      if (Array.isArray(tFills)) {
        const sf = tFills.find((f: Paint) => f.type === "SOLID" && f.visible !== false) as SolidPaint | undefined;
        if (sf) {
          const toH = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
          snap.fillColor = `#${toH(sf.color.r)}${toH(sf.color.g)}${toH(sf.color.b)}`.toUpperCase();
        }
      }
    } catch (_) {}
    const td = tn.textDecoration;
    if (typeof td === "string" && td !== "NONE") snap.textDecoration = td;
  }

  // Children
  if ("children" in node && depth < maxDepth) {
    const children = (node as any).children;
    if (children.length > 0) {
      const mapped = children.map((c: SceneNode) => _compactSnapshot(c, depth + 1, maxDepth)).filter(Boolean);
      if (mapped.length > 0) snap.children = mapped;
    }
  }

  return snap;
}

// ── Build final tokens with prompt-aware reference frame selection ──
// This is separated from the tree walk so cached raw data can be reused
// while still picking the right reference frame for each prompt.
function _buildFinalTokens(
  colors: string[],
  cornerRadii: number[],
  fontSizes: number[],
  fontFamilies: string[],
  spacings: number[],
  paddings: number[],
  rawButtonStyles: any[],
  rawInputStyles: any[],
  rootFrameLayouts: any[],
  designFramesMeta: { name: string; height: number; childrenCount: number; nodeId: string }[],
  userPrompt?: string,
): Record<string, any> {
  // ── Reference Snapshots ──
  // Pick 1 representative frame based on prompt keywords + detected descendants
  const referenceSnapshots: any[] = [];

  const detectedNames = new Set([
    ...rawButtonStyles.map((b: any) => b.name),
    ...rawInputStyles.map((i: any) => i.name),
  ]);

  // Count detected descendants in a Figma node (for scoring)
  function countDetectedDescendants(node: SceneNode): number {
    let count = 0;
    if (detectedNames.has(node.name)) count++;
    if ("children" in node) {
      for (const c of (node as any).children) count += countDetectedDescendants(c);
    }
    return count;
  }

  // Score reference frames primarily by prompt keyword relevance
  const promptWords = (userPrompt || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);

  let bestFrameNode: FrameNode | null = null;
  let bestFrameName = "";
  let bestScore = -1;
  for (const meta of designFramesMeta) {
    let score = 0;
    // Prompt keyword matching is the primary signal (e.g., "login" matches "01. Login")
    const frameNameLower = meta.name.toLowerCase();
    for (const word of promptWords) {
      if (frameNameLower.includes(word)) { score += 100; break; }
    }
    // Try to find the node for deeper scoring
    const frameNode = figma.currentPage.findOne(n => n.id === meta.nodeId) as FrameNode | null;
    if (frameNode) {
      // Detected descendants as secondary signal
      score += countDetectedDescendants(frameNode);
      // Tie-breaker: prefer frames with more children (richer content)
      score += Math.min(meta.childrenCount, 10) * 0.1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestFrameNode = frameNode;
      bestFrameName = meta.name;
    }
  }
  // Fallback: first qualifying frame if none scored
  if (!bestFrameNode) {
    for (const meta of designFramesMeta) {
      const frameNode = figma.currentPage.findOne(n => n.id === meta.nodeId) as FrameNode | null;
      if (frameNode) { bestFrameNode = frameNode; bestFrameName = meta.name; break; }
    }
  }
  if (bestFrameNode) {
    console.log("[extractStyleTokens] Reference snapshot from:", bestFrameName, "(score:", bestScore, ")");
    referenceSnapshots.push(_compactSnapshot(bestFrameNode, 0, 4));
  }

  // ── Prioritize buttons/inputs from the reference frame ──
  // Sort so tokens from the reference frame come first, then trim.
  const refFrameName = bestFrameName;
  const sortBySource = (a: any, b: any) => {
    const aMatch = a._sourceFrame === refFrameName ? 0 : 1;
    const bMatch = b._sourceFrame === refFrameName ? 0 : 1;
    return aMatch - bMatch;
  };
  // Work on copies to avoid mutating the cached raw arrays
  const sortedButtons = [...rawButtonStyles].sort(sortBySource);
  const sortedInputs = [...rawInputStyles].sort(sortBySource);

  // Trim to top 3 and strip internal _sourceFrame tag
  const finalButtonStyles = sortedButtons.slice(0, 3).map(({ _sourceFrame, ...rest }: any) => rest);
  const finalInputStyles = sortedInputs.slice(0, 3).map(({ _sourceFrame, ...rest }: any) => rest);

  console.log("[extractStyleTokens] Final buttons (ref=" + refFrameName + "):", JSON.stringify(finalButtonStyles));
  console.log("[extractStyleTokens] Final inputs (ref=" + refFrameName + "):", JSON.stringify(finalInputStyles));

  return {
    colors,
    cornerRadii,
    fontSizes,
    fontFamilies,
    spacings,
    paddings,
    buttonStyles: finalButtonStyles,
    inputStyles: finalInputStyles,
    rootFrameLayouts,
    referenceSnapshots,
  };
}

function snapshotNode(node: SceneNode, depth: number, siblingIndex?: number): NodeSnapshot {
  const snap: NodeSnapshot = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
    childrenCount: "children" in node ? (node as any).children.length : 0,
  };

  if (siblingIndex !== undefined) {
    snap.siblingIndex = siblingIndex;
  }

  // Layout mode (frames / component instances)
  if ("layoutMode" in node) {
    const frame = node as FrameNode;
    const lm = frame.layoutMode;
    snap.layoutMode = lm === "HORIZONTAL" || lm === "VERTICAL" ? lm : "NONE";

    // Layout wrap
    if ("layoutWrap" in frame && (frame as any).layoutWrap) {
      snap.layoutWrap = (frame as any).layoutWrap as "WRAP" | "NO_WRAP";
    }

    // Padding
    if (lm === "HORIZONTAL" || lm === "VERTICAL") {
      if (frame.paddingTop > 0) snap.paddingTop = frame.paddingTop;
      if (frame.paddingRight > 0) snap.paddingRight = frame.paddingRight;
      if (frame.paddingBottom > 0) snap.paddingBottom = frame.paddingBottom;
      if (frame.paddingLeft > 0) snap.paddingLeft = frame.paddingLeft;
      if (frame.itemSpacing > 0) snap.itemSpacing = frame.itemSpacing;
      if ("counterAxisSpacing" in frame) {
        const cas = (frame as any).counterAxisSpacing;
        if (typeof cas === "number" && cas > 0) snap.counterAxisSpacing = cas;
      }
    }

    // Sizing modes
    if ("layoutSizingHorizontal" in frame) {
      snap.layoutSizingHorizontal = (frame as any).layoutSizingHorizontal;
      snap.layoutSizingVertical = (frame as any).layoutSizingVertical;
    }

    // Alignment
    if (lm === "HORIZONTAL" || lm === "VERTICAL") {
      snap.primaryAxisAlignItems = frame.primaryAxisAlignItems;
      snap.counterAxisAlignItems = frame.counterAxisAlignItems;
    }
  }

  // Strokes (borders)
  if ("strokes" in node) {
    try {
      const strokes = (node as GeometryMixin).strokes;
      if (Array.isArray(strokes) && strokes.length > 0) {
        const solidStroke = strokes.find((s: Paint) => s.type === "SOLID" && s.visible !== false) as SolidPaint | undefined;
        if (solidStroke) {
          const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
          snap.strokeColor = `#${toHex(solidStroke.color.r)}${toHex(solidStroke.color.g)}${toHex(solidStroke.color.b)}`.toUpperCase();
          const sw = (node as any).strokeWeight;
          if (typeof sw === "number" && sw > 0) snap.strokeWeight = sw;
          // Individual stroke weights
          const stw = (node as any).strokeTopWeight;
          if (typeof stw === "number") {
            const top = stw || 0;
            const right = (node as any).strokeRightWeight || 0;
            const bottom = (node as any).strokeBottomWeight || 0;
            const left = (node as any).strokeLeftWeight || 0;
            if (top !== bottom || left !== right || top !== left) {
              snap.strokeTopWeight = top;
              snap.strokeRightWeight = right;
              snap.strokeBottomWeight = bottom;
              snap.strokeLeftWeight = left;
            }
          }
        }
      }
    } catch (_e) { /* mixed strokes — skip */ }
  }

  // Applied text style
  if (node.type === "TEXT") {
    const textNode = node as TextNode;
    snap.characters = textNode.characters;
    if (typeof textNode.textStyleId === "string" && textNode.textStyleId) {
      snap.appliedTextStyleId = textNode.textStyleId;
    }
    // Text styling properties (use first segment values if uniform)
    const fs = textNode.fontSize;
    if (typeof fs === "number") snap.fontSize = fs;
    const fn = textNode.fontName;
    if (fn && typeof fn !== "symbol" && "family" in fn) {
      snap.fontFamily = fn.family;
      snap.fontStyle = fn.style;
    }
    snap.textAlignHorizontal = textNode.textAlignHorizontal;
    snap.textAlignVertical = textNode.textAlignVertical;
    snap.textAutoResize = textNode.textAutoResize;
    const ls = textNode.letterSpacing;
    if (ls && typeof ls !== "symbol" && ls.value !== 0) {
      snap.letterSpacing = ls.value;
      snap.letterSpacingUnit = ls.unit as "PIXELS" | "PERCENT";
    }
    const lh = textNode.lineHeight;
    if (lh && typeof lh !== "symbol") {
      if (lh.unit === "AUTO") {
        snap.lineHeight = "AUTO";
        snap.lineHeightUnit = "AUTO";
      } else {
        snap.lineHeight = lh.value;
        snap.lineHeightUnit = lh.unit as "PIXELS" | "PERCENT";
      }
    }
    const tc = textNode.textCase;
    if (typeof tc === "string" && tc !== "ORIGINAL") snap.textCase = tc;
    const td = textNode.textDecoration;
    if (typeof td === "string" && td !== "NONE") snap.textDecoration = td;
  }

  // Applied fill style
  if ("fillStyleId" in node) {
    const fid = (node as any).fillStyleId;
    if (typeof fid === "string" && fid) {
      snap.appliedFillStyleId = fid;
    }
  }

  // Visual properties for AI design reasoning
  if ("cornerRadius" in node) {
    const cr = (node as any).cornerRadius;
    if (typeof cr === "number" && cr > 0) snap.cornerRadius = Math.round(cr);
  }
  if ("fills" in node) {
    try {
      const fills = (node as GeometryMixin).fills;
      if (Array.isArray(fills) && fills.length > 0) {
        snap.fillTypes = fills.map((f: Paint) => f.type);
        // Extract the hex color of the first solid fill so the LLM can reason about contrast
        const solidFill = fills.find((f: Paint) => f.type === "SOLID") as SolidPaint | undefined;
        if (solidFill) {
          const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
          snap.fillColor = `#${toHex(solidFill.color.r)}${toHex(solidFill.color.g)}${toHex(solidFill.color.b)}`.toUpperCase();
        }
      }
    } catch (_e) { /* mixed fills — skip */ }
  }
  if ("clipsContent" in node) {
    snap.clipsContent = (node as FrameNode).clipsContent;
  }
  if ("opacity" in node) {
    const op = (node as SceneNode).opacity;
    if (op < 1) snap.opacity = op;
  }

  // Effects (drop shadows, inner shadows, blurs)
  if ("effects" in node) {
    try {
      const effects = (node as any).effects;
      if (Array.isArray(effects) && effects.length > 0) {
        snap.effects = effects.map((e: any) => {
          const eff: any = { type: e.type, radius: e.radius };
          if (e.visible === false) eff.visible = false;
          if (e.spread != null && e.spread !== 0) eff.spread = e.spread;
          if (e.color) eff.color = { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a };
          if (e.offset) eff.offset = { x: e.offset.x, y: e.offset.y };
          if (e.blendMode && e.blendMode !== "NORMAL") eff.blendMode = e.blendMode;
          return eff;
        });
      }
    } catch (_e) { /* mixed effects — skip */ }
  }

  // Recurse into children (up to MAX_SNAPSHOT_DEPTH)
  if ("children" in node && depth < MAX_SNAPSHOT_DEPTH) {
    const childNodes = (node as FrameNode).children;
    if (childNodes.length > 0) {
      snap.children = childNodes.map((child, idx) => snapshotNode(child, depth + 1, idx));
    }
  }

  return snap;
}

function extractSelectionSnapshot(): SelectionSnapshot {
  const nodes: NodeSnapshot[] = figma.currentPage.selection.map((node) =>
    snapshotNode(node, 0)
  );
  return { nodes };
}

// ── 1a. Embed image data into snapshot tree (async) ─────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (a << 16) | (b << 8) | c;
    result += chars[(triplet >> 18) & 63];
    result += chars[(triplet >> 12) & 63];
    result += (i + 1 < bytes.length) ? chars[(triplet >> 6) & 63] : "=";
    result += (i + 2 < bytes.length) ? chars[triplet & 63] : "=";
  }
  return result;
}

function base64ToUint8(base64: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(128);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  // Remove padding
  let len = base64.length;
  if (base64[len - 1] === "=") len--;
  if (base64[len - 1] === "=") len--;
  const byteLen = (len * 3) >> 2;
  const bytes = new Uint8Array(byteLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[base64.charCodeAt(i)];
    const b = lookup[base64.charCodeAt(i + 1)];
    const c = i + 2 < len ? lookup[base64.charCodeAt(i + 2)] : 0;
    const d = i + 3 < len ? lookup[base64.charCodeAt(i + 3)] : 0;
    bytes[p++] = (a << 2) | (b >> 4);
    if (p < byteLen) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < byteLen) bytes[p++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

async function embedImagesInSnapshot(snap: NodeSnapshot, node: SceneNode): Promise<void> {
  // Determine if this node should be rasterized as a PNG:
  // 1. Nodes with IMAGE fills
  // 2. Vector/shape nodes (VECTOR, BOOLEAN_OPERATION, STAR, POLYGON, LINE, ELLIPSE, RECTANGLE)
  //    that are leaf nodes or have no meaningful children to recurse into
  const isShapeNode = [
    "VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE",
    "ELLIPSE", "RECTANGLE",
  ].includes(node.type);

  // Groups with only vector children should be rasterized as a whole (icons)
  const isIconGroup = node.type === "GROUP" && "children" in node &&
    (node as GroupNode).children.every((c: SceneNode) =>
      ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE", "ELLIPSE", "RECTANGLE", "GROUP"].includes(c.type)
    );

  let hasImageFill = false;
  if ("fills" in node) {
    try {
      const fills = (node as GeometryMixin).fills;
      if (Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE")) {
        hasImageFill = true;
      }
    } catch (_e) {}
  }

  if (isShapeNode || isIconGroup || hasImageFill) {
    try {
      const bytes = await (node as ExportMixin).exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 2 },  // 2x for crisp icons
      });
      snap.imageData = uint8ToBase64(bytes);
    } catch (_e) { /* skip if export fails */ }

    // Don't recurse into shape/icon children — they’re baked into the image
    if (isShapeNode || isIconGroup) {
      snap.children = [];  // Clear children so import treats this as a rasterised leaf
      return;
    }
  }

  // Recurse into children
  if (snap.children && "children" in node) {
    const childNodes = (node as FrameNode).children;
    for (let i = 0; i < snap.children.length; i++) {
      if (i < childNodes.length) {
        await embedImagesInSnapshot(snap.children[i], childNodes[i]);
      }
    }
  }
}

// ── 1a-bis. Accessibility Audit ─────────────────────────────────────

const AUDIT_BADGE_FRAME_NAME = "A11y Audit Badges";

/** Extract the first solid fill colour from a node as {r,g,b} in 0-1 range */
function extractFillColor(node: SceneNode): { r: number; g: number; b: number } | null {
  if (!("fills" in node)) return null;
  const fills = (node as any).fills;
  if (!Array.isArray(fills)) return null;
  for (const f of fills) {
    if (f.type === "SOLID" && f.visible !== false) {
      return { r: f.color.r, g: f.color.g, b: f.color.b };
    }
  }
  return null;
}

/** Walk up to find the nearest ancestor background colour */
function resolveBackgroundColor(node: SceneNode): { r: number; g: number; b: number } {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    const col = extractFillColor(current as SceneNode);
    if (col) return col;
    current = current.parent;
  }
  // Default: white
  return { r: 1, g: 1, b: 1 };
}

/** Compute WCAG luminance from 0-1 RGB (audit-local helper) */
function auditLuminance(r: number, g: number, b: number): number {
  const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

/** Compute WCAG contrast ratio (audit-local helper) */
function auditContrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Check whether a node (or any ancestor) is hidden */
function isNodeHidden(node: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if ("visible" in current && (current as SceneNode).visible === false) return true;
    current = current.parent;
  }
  return false;
}

/** Check if a node name looks like a Figma component internal / template part */
function isInternalTemplateName(name: string): boolean {
  return name.startsWith("Template/") || name.startsWith(".Template") || name.startsWith("_");
}

/** Check if a name is a decorative / non-content layer */
function isDecorativeLayer(name: string): boolean {
  const lower = name.toLowerCase();
  return /^(tint|overlay|shade|mask|divider|separator|spacer|background|bg|shadow|border|stroke)(\s|$|[-_ ])/i.test(lower);
}

/** Run deterministic WCAG checks on nodes, return de-duplicated findings */
function runAccessibilityAudit(nodes: SceneNode[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  /**
   * @param node         the current node
   * @param insideInstance  true when we are inside a component INSTANCE (skip most checks)
   */
  function walk(node: SceneNode, insideInstance: boolean = false) {
    // Skip audit badge / changelog frames
    if (node.name === AUDIT_BADGE_FRAME_NAME || node.name === CHANGE_LOG_FRAME_NAME) return;

    // Skip hidden nodes entirely
    if ("visible" in node && node.visible === false) return;

    // Skip Figma internal template children (e.g. Template/.Template_Button)
    if (isInternalTemplateName(node.name)) return;

    // ── 1. Contrast check (text nodes) ──────────────────────
    if (node.type === "TEXT" && !insideInstance) {
      const textNode = node as TextNode;
      const fg = extractFillColor(textNode);
      if (fg) {
        const bg = resolveBackgroundColor(textNode);
        const fgLum = auditLuminance(fg.r, fg.g, fg.b);
        const bgLum = auditLuminance(bg.r, bg.g, bg.b);
        const ratio = auditContrastRatio(fgLum, bgLum);
        const fontSize = typeof textNode.fontSize === "number" ? textNode.fontSize : 16;
        const isLargeText = fontSize >= 18 || (fontSize >= 14 && (textNode.fontWeight as any) >= 700);
        const threshold = isLargeText ? 3.0 : 4.5;
        if (ratio < threshold) {
          const fgHex = "#" + [fg.r, fg.g, fg.b].map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
          const bgHex = "#" + [bg.r, bg.g, bg.b].map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
          findings.push({
            nodeId: node.id,
            nodeName: node.name,
            severity: ratio < 3.0 ? "error" : "warning",
            checkType: "contrast",
            message: `Low contrast ratio ${ratio.toFixed(2)}:1 (needs ${threshold}:1). Text "${(textNode.characters || "").slice(0, 30)}" (${fgHex}) on background (${bgHex}).`,
          });
        }
      }

      // ── 2. Small font size ────────────────────────────────
      const fontSize = typeof textNode.fontSize === "number" ? textNode.fontSize : 0;
      if (fontSize > 0 && fontSize < 12) {
        findings.push({
          nodeId: node.id,
          nodeName: node.name,
          severity: "warning",
          checkType: "font-size",
          message: `Font size ${fontSize}px is below 12px minimum for readability.`,
        });
      }

      // ── 3. Empty text node ────────────────────────────────
      if (!textNode.characters || textNode.characters.trim() === "") {
        findings.push({
          nodeId: node.id,
          nodeName: node.name,
          severity: "warning",
          checkType: "empty-text",
          message: `Text node "${node.name}" has no visible content. Check if a label is missing.`,
        });
      }
    }

    // ── 4. Touch target size (interactive-looking elements) ──
    // Only check top-level interactive elements, NOT children inside instances
    if (!insideInstance && (node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT")) {
      const nameLower = node.name.toLowerCase();
      const isInteractive = /button|btn|link|tab|toggle|switch|checkbox|radio|input|search|icon[-_ ]?btn|cta/i.test(nameLower);
      if (isInteractive && (node.width < 44 || node.height < 44)) {
        findings.push({
          nodeId: node.id,
          nodeName: node.name,
          severity: "warning",
          checkType: "touch-target",
          message: `Touch target "${node.name}" is ${Math.round(node.width)}×${Math.round(node.height)}px — minimum 44×44px recommended (WCAG 2.5.5).`,
        });
      }
    }

    // ── 5. Low opacity (only on content elements, not decorative layers) ──
    if ("opacity" in node && typeof (node as any).opacity === "number" && !insideInstance) {
      const opacity = (node as any).opacity;
      if (opacity > 0 && opacity < 0.4 && !isDecorativeLayer(node.name)) {
        findings.push({
          nodeId: node.id,
          nodeName: node.name,
          severity: "warning",
          checkType: "low-opacity",
          message: `Node "${node.name}" has opacity ${(opacity * 100).toFixed(0)}% which may be hard to perceive.`,
        });
      }
    }

    // ── Recurse ─────────────────────────────────────────────
    // When we enter an INSTANCE, mark children so we skip most checks
    // (component internals are not directly editable by the user)
    if ("children" in node) {
      const nowInsideInstance = insideInstance || node.type === "INSTANCE";
      for (const child of (node as FrameNode).children) {
        walk(child, nowInsideInstance);
      }
    }
  }

  for (const node of nodes) {
    walk(node);
  }

  // ── De-duplicate: remove truly identical findings (same nodeId + checkType) ──
  const seen = new Set<string>();
  const deduped: AuditFinding[] = [];
  for (const f of findings) {
    const key = `${f.nodeId}||${f.checkType}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  return deduped;
}

/** Create coloured badge annotations on the canvas next to flagged nodes (max 30) */
function createAuditBadges(findings: AuditFinding[]): void {
  // Remove any existing badges
  clearAuditBadges();

  if (findings.length === 0) return;

  // Only create badges for the first 30 findings to avoid visual noise
  const capped = findings.slice(0, 30);

  for (const finding of capped) {
    try {
      const targetNode = figma.getNodeById(finding.nodeId) as SceneNode;
      if (!targetNode) continue;

      // Get absolute position of the target node
      const abs = targetNode.absoluteTransform;
      const nodeX = abs[0][2];
      const nodeY = abs[1][2];

      // Create badge
      const badge = figma.createFrame();
      badge.name = `a11y-badge: ${finding.nodeName}`;
      badge.resize(20, 20);
      badge.cornerRadius = 10;
      badge.fills = [
        {
          type: "SOLID",
          color: finding.severity === "error"
            ? { r: 0.84, g: 0.19, b: 0.19 } // red
            : { r: 0.95, g: 0.61, b: 0.07 }, // orange
        },
      ];

      // Position at top-right corner of the target node
      badge.x = nodeX + targetNode.width - 10;
      badge.y = nodeY - 10;

      // Add severity icon text (! or ⚠)
      const iconText = figma.createText();
      figma.loadFontAsync({ family: "Inter", style: "Bold" }).then(() => {
        iconText.characters = "!";
        iconText.fontSize = 12;
        iconText.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
        iconText.textAlignHorizontal = "CENTER";
        iconText.textAlignVertical = "CENTER";
        iconText.resize(20, 20);
        badge.appendChild(iconText);
      });

      figma.currentPage.appendChild(badge);
    } catch (e) {
      console.warn("[a11y] Badge creation failed for", finding.nodeId, e);
    }
  }
}

/** Remove all audit badge annotations from the canvas */
function clearAuditBadges(): void {
  const badges = figma.currentPage.findAll(
    (n) => n.name === AUDIT_BADGE_FRAME_NAME || n.name.startsWith("a11y-badge:")
  );
  for (const b of badges) {
    b.remove();
  }
}

// ── 1b. Create Nodes from Snapshot (Import) ─────────────────────────

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16) / 255,
    g: parseInt(h.substring(2, 4), 16) / 255,
    b: parseInt(h.substring(4, 6), 16) / 255,
  };
}

// Import stats – set before each import run
let _importStats = { texts: 0, frames: 0, images: 0, failed: 0, errors: [] as string[] };

async function createNodeFromSnapshot(
  snap: any,
  parent: BaseNode & ChildrenMixin
): Promise<SceneNode | null> {
  let node: SceneNode;

  // Check if the parent is an auto-layout frame
  const parentIsAutoLayout =
    "layoutMode" in parent &&
    ((parent as any).layoutMode === "HORIZONTAL" ||
     (parent as any).layoutMode === "VERTICAL");

  if (snap.type === "TEXT") {
    // ── Text node creation with maximum resilience ──
    const textNode = figma.createText();

    // Robust font loading: try exact → same family Regular → Inter Regular
    let loadedFamily = "Inter";
    let loadedStyle = "Regular";
    let fontReady = false;

    const wantFamily = snap.fontFamily || "Inter";
    const wantStyle = snap.fontStyle || "Regular";

    // Attempt 1: exact font
    try {
      await figma.loadFontAsync({ family: wantFamily, style: wantStyle });
      loadedFamily = wantFamily;
      loadedStyle = wantStyle;
      fontReady = true;
    } catch (_) {}

    // Attempt 2: same family, "Regular" style
    if (!fontReady && wantStyle !== "Regular") {
      try {
        await figma.loadFontAsync({ family: wantFamily, style: "Regular" });
        loadedFamily = wantFamily;
        loadedStyle = "Regular";
        fontReady = true;
      } catch (_) {}
    }

    // Attempt 3: Inter Regular (always available in Figma)
    if (!fontReady) {
      try {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        fontReady = true;
      } catch (_) {}
    }

    // Set fontName
    try {
      textNode.fontName = { family: loadedFamily, style: loadedStyle } as FontName;
    } catch (_) {}

    // Set text styling properties — each in its own try/catch
    try { if (snap.fontSize && typeof snap.fontSize === "number") textNode.fontSize = snap.fontSize; } catch (_) {}
    try { if (snap.textAlignHorizontal) textNode.textAlignHorizontal = snap.textAlignHorizontal as any; } catch (_) {}
    try { if (snap.textAlignVertical) textNode.textAlignVertical = snap.textAlignVertical as any; } catch (_) {}
    try { if (snap.textAutoResize) textNode.textAutoResize = snap.textAutoResize as any; } catch (_) {}
    try { if (snap.letterSpacing != null) textNode.letterSpacing = { value: snap.letterSpacing, unit: snap.letterSpacingUnit || "PIXELS" }; } catch (_) {}
    try {
      if (snap.lineHeight != null) {
        if (snap.lineHeight === "AUTO" || snap.lineHeightUnit === "AUTO") {
          textNode.lineHeight = { unit: "AUTO" };
        } else {
          textNode.lineHeight = { value: Number(snap.lineHeight), unit: snap.lineHeightUnit || "PIXELS" };
        }
      }
    } catch (_) {}
    try { if (snap.textCase) textNode.textCase = snap.textCase as any; } catch (_) {}
    try { if (snap.textDecoration) textNode.textDecoration = snap.textDecoration as any; } catch (_) {}

    // Set characters
    try {
      textNode.characters = snap.characters || "";
    } catch (charErr) {
      // If characters fail, try loading Inter Regular and retry
      try {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        textNode.fontName = { family: "Inter", style: "Regular" };
        textNode.characters = snap.characters || "";
      } catch (_) {
        // Last resort: leave empty
      }
    }

    // Set fill color (text color)
    try {
      if (snap.fillColor) {
        textNode.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
      }
    } catch (_) {}

    node = textNode;
    _importStats.texts++;
  } else if (snap.type === "ELLIPSE") {
    // Create a native ellipse
    const ellipse = figma.createEllipse();
    ellipse.resize(snap.width ?? 100, snap.height ?? 100);

    // Fill: image, solid, or empty
    if (snap.imageData) {
      try {
        const bytes = base64ToUint8(snap.imageData);
        const img = figma.createImage(bytes);
        ellipse.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
        _importStats.images++;
      } catch (_e) {
        if (snap.fillColor) ellipse.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        else ellipse.fills = [];
      }
    } else if (snap.fillColor) {
      ellipse.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
    } else {
      ellipse.fills = [];
    }

    node = ellipse;
    _importStats.frames++;
  } else if (snap.type === "RECTANGLE") {
    // Create a native rectangle
    const rect = figma.createRectangle();
    rect.resize(snap.width ?? 100, snap.height ?? 100);
    if (snap.cornerRadius != null && snap.cornerRadius > 0) rect.cornerRadius = snap.cornerRadius;

    // Fill: image, solid, or empty
    if (snap.imageData) {
      try {
        const bytes = base64ToUint8(snap.imageData);
        const img = figma.createImage(bytes);
        rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
        _importStats.images++;
      } catch (_e) {
        if (snap.fillColor) rect.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        else rect.fills = [];
      }
    } else if (snap.fillColor) {
      rect.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
    } else {
      rect.fills = [];
    }

    node = rect;
    _importStats.frames++;
  } else if (snap.imageData && (!snap.children || snap.children.length === 0)) {
    // Vector/icon nodes that were rasterized — create a frame with image fill
    const frame = figma.createFrame();
    frame.resize(snap.width ?? 100, snap.height ?? 100);
    frame.fills = [];
    try {
      const bytes = base64ToUint8(snap.imageData);
      const img = figma.createImage(bytes);
      frame.fills = [{ type: "IMAGE", scaleMode: "FIT", imageHash: img.hash }];
      _importStats.images++;
    } catch (_e) {
      if (snap.fillColor) frame.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
    }
    if (snap.cornerRadius != null && snap.cornerRadius > 0) frame.cornerRadius = snap.cornerRadius;
    if (snap.clipsContent != null) frame.clipsContent = snap.clipsContent;
    node = frame;
    _importStats.frames++;
  } else {
    // Everything else becomes a frame
    const frame = figma.createFrame();
    frame.resize(
      snap.width ?? 100,
      snap.height ?? 100
    );

    // Layout mode
    if (snap.layoutMode === "HORIZONTAL" || snap.layoutMode === "VERTICAL") {
      frame.layoutMode = snap.layoutMode;

      // Padding
      if (snap.paddingTop != null) frame.paddingTop = snap.paddingTop;
      if (snap.paddingRight != null) frame.paddingRight = snap.paddingRight;
      if (snap.paddingBottom != null) frame.paddingBottom = snap.paddingBottom;
      if (snap.paddingLeft != null) frame.paddingLeft = snap.paddingLeft;

      // Spacing
      if (snap.itemSpacing != null) frame.itemSpacing = snap.itemSpacing;
      if (snap.counterAxisSpacing != null) {
        (frame as any).counterAxisSpacing = snap.counterAxisSpacing;
      }

      // Alignment (critical for centering text in buttons)
      const validPrimary = ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"];
      const validCounter = ["MIN", "CENTER", "MAX", "BASELINE"];
      if (snap.primaryAxisAlignItems && validPrimary.indexOf(snap.primaryAxisAlignItems) !== -1) {
        frame.primaryAxisAlignItems = snap.primaryAxisAlignItems;
      }
      if (snap.counterAxisAlignItems && validCounter.indexOf(snap.counterAxisAlignItems) !== -1) {
        frame.counterAxisAlignItems = snap.counterAxisAlignItems;
      }

      // Wrap
      if (snap.layoutWrap === "WRAP") {
        (frame as any).layoutWrap = "WRAP";
      }
    }

    // Corner radius
    if (snap.cornerRadius != null && snap.cornerRadius > 0) {
      frame.cornerRadius = snap.cornerRadius;
    }

    // Clips content
    if (snap.clipsContent != null) {
      frame.clipsContent = snap.clipsContent;
    }

    // Stroke (borders)
    if (snap.strokeColor) {
      try {
        frame.strokes = [{ type: "SOLID", color: hexToRgb(snap.strokeColor) }];
        frame.strokeWeight = snap.strokeWeight ?? 1;
        frame.strokeAlign = "INSIDE";

        // Individual stroke weights (e.g. bottom-border-only for input fields)
        if (snap.strokeBottomWeight != null) {
          (frame as any).strokeTopWeight = snap.strokeTopWeight ?? 0;
          (frame as any).strokeRightWeight = snap.strokeRightWeight ?? 0;
          (frame as any).strokeBottomWeight = snap.strokeBottomWeight;
          (frame as any).strokeLeftWeight = snap.strokeLeftWeight ?? 0;
        }
      } catch (_) {}
    }

    // Fill color or image
    if (snap.imageData) {
      // Restore image from base64
      try {
        const bytes = base64ToUint8(snap.imageData);
        const img = figma.createImage(bytes);
        frame.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
        _importStats.images++;
      } catch (_e) {
        // Fall back to solid fill or empty
        if (snap.fillColor) {
          frame.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        } else {
          frame.fills = [];
        }
      }
    } else if (snap.fillColor) {
      frame.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
    } else {
      frame.fills = []; // transparent by default
    }

    // Recursively create children
    if (snap.children && snap.children.length > 0) {
      for (const childSnap of snap.children) {
        try {
          await createNodeFromSnapshot(childSnap, frame);
        } catch (childErr) {
          _importStats.failed++;
          _importStats.errors.push(`"${childSnap.name}": ${(childErr as Error).message}`);
        }
      }
    }

    node = frame;
    _importStats.frames++;
  }

  // Common properties
  node.name = snap.name || "Imported Node";
  if (snap.opacity != null && snap.opacity < 1) node.opacity = snap.opacity;

  // Restore effects (drop shadows, inner shadows, blurs)
  if (snap.effects && snap.effects.length > 0 && "effects" in node) {
    try {
      (node as any).effects = snap.effects.map((e: any) => {
        const eff: any = {
          type: e.type,
          radius: e.radius,
          visible: e.visible !== false, // default true
        };
        if (e.color) eff.color = { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a };
        if (e.offset) eff.offset = { x: e.offset.x, y: e.offset.y };
        if (e.spread != null) eff.spread = e.spread;
        eff.blendMode = e.blendMode || "NORMAL";
        return eff;
      });
    } catch (_e) { /* skip if effects fail */ }
  }

  // Append to parent first — sizing props require being in the tree
  parent.appendChild(node);

  // Position (only meaningful for non-auto-layout parents or absolute positioning)
  if (!parentIsAutoLayout) {
    if (snap.x != null) node.x = snap.x;
    if (snap.y != null) node.y = snap.y;
  }

  // Layout sizing — must be set AFTER appending to parent
  if (parentIsAutoLayout) {
    const sizing = snap.layoutSizingHorizontal;
    const sizingV = snap.layoutSizingVertical;
    if (sizing) {
      try { (node as any).layoutSizingHorizontal = sizing; } catch (_e) { /* skip */ }
    }
    if (sizingV) {
      try { (node as any).layoutSizingVertical = sizingV; } catch (_e) { /* skip */ }
    }
  }

  // Resize text after appending (text auto-sizes, so set explicit dimensions)
  if (snap.type === "TEXT" && snap.width && snap.height) {
    try {
      (node as TextNode).resize(snap.width, snap.height);
    } catch (_) {}
  }

  return node;
}

// ── 2. Extract Design System Snapshot ───────────────────────────────

async function extractDesignSystemSnapshot(): Promise<DesignSystemSnapshot> {
  // Return cached result if fresh
  if (_designSystemCache && (Date.now() - _designSystemCache.ts) < CACHE_TTL_MS) {
    console.log("[extractDesignSystemSnapshot] Using cached result (age: " + Math.round((Date.now() - _designSystemCache.ts) / 1000) + "s)");
    return _designSystemCache.data;
  }

  const textStyles = figma.getLocalTextStyles().map((s) => {
    const entry: any = {
      id: s.id,
      name: s.name,
    };
    if (s.fontName && typeof s.fontName !== "symbol") {
      entry.fontFamily = (s.fontName as FontName).family;
      entry.fontStyle = (s.fontName as FontName).style;
    }
    if (typeof s.fontSize === "number") entry.fontSize = s.fontSize;
    if (s.lineHeight && typeof s.lineHeight !== "symbol") {
      const lh = s.lineHeight as any;
      if (lh.unit === "AUTO") entry.lineHeight = "AUTO";
      else if (lh.value) entry.lineHeight = lh.value;
    }
    if (typeof s.letterSpacing !== "symbol" && s.letterSpacing) {
      const ls = s.letterSpacing as any;
      if (ls.value) entry.letterSpacing = ls.value;
    }
    return entry;
  });

  const fillStyles = figma.getLocalPaintStyles().map((s) => {
    const entry: any = { id: s.id, name: s.name };
    // Resolve hex value from the first solid paint
    try {
      const paints = s.paints;
      if (Array.isArray(paints)) {
        const solid = paints.find((p: Paint) => p.type === "SOLID" && p.visible !== false) as SolidPaint | undefined;
        if (solid) {
          const toH = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
          entry.hex = `#${toH(solid.color.r)}${toH(solid.color.g)}${toH(solid.color.b)}`.toUpperCase();
          if (typeof solid.opacity === "number" && solid.opacity < 1) {
            entry.opacity = Math.round(solid.opacity * 100);
          }
        }
      }
    } catch (_) {}
    return entry;
  });

  const components: { key: string; name: string }[] = [];
  // Only scan current page — scanning figma.root.findAll() traverses ALL pages
  // and blocks the main thread for many seconds on large documents.
  figma.currentPage.findAll((n) => n.type === "COMPONENT").forEach((c) => {
    const comp = c as ComponentNode;
    components.push({ key: comp.key, name: comp.name });
  });

  // Variables (Figma Variables API)
  let variables: { id: string; name: string }[] = [];
  try {
    const collections =
      await figma.variables.getLocalVariableCollectionsAsync();
    for (const col of collections) {
      for (const varId of col.variableIds) {
        const v = await figma.variables.getVariableByIdAsync(varId);
        if (v) {
          variables.push({ id: v.id, name: v.name });
        }
      }
    }
  } catch (_e) {
    // Variables API may not be available in all contexts
  }

  const result: DesignSystemSnapshot = { textStyles, fillStyles, components, variables };
  _designSystemCache = { data: result, ts: Date.now() };
  return result;
}

// ── Generate Design Docs (LLM-friendly markdown) ───────────────────

async function generateDesignDocs(): Promise<{ markdown: string; filename: string }> {
  // Extract tokens from actual visual usage (works on unstructured files)
  const tokens = await extractStyleTokens();
  // Extract named Figma styles/components/variables (may be empty on messy files)
  const ds = await extractDesignSystemSnapshot();
  const pageName = figma.currentPage.name;
  const now = new Date().toISOString().split("T")[0];

  // ── Helpers ──
  const STATE_KEYWORDS = /Hover|Focus|Press|Drag|Select|Disable|Medium\s*Brush|Low\s*Brush/i;
  const FIGMA_INTERNAL = /^Figma\s*\(/i;
  const MAX_TOKEN_VALUE = 64; // cap spacing/padding outliers

  // Deduplicate component specs by signature (fill + stroke + radius)
  function dedupeComponents(items: any[]): any[] {
    const seen = new Set<string>();
    return items.filter(item => {
      const sig = [item.fillColor || "", item.strokeColor || "", item.cornerRadius || 0].join("|");
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  // Strip redundant group prefix from token name  (e.g. "Primary/PrimaryColor" → "PrimaryColor")
  function stripGroupPrefix(name: string): string {
    const slash = name.indexOf("/");
    if (slash === -1) return name;
    return name.substring(slash + 1);
  }

  // Round a number to n decimal places
  function round(v: number, decimals: number): number {
    const m = Math.pow(10, decimals);
    return Math.round(v * m) / m;
  }

  // Collect design frame names for screen inventory
  const validTopLevelTypes = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"]);
  const designFrames = figma.currentPage.children.filter(c => {
    if (!validTopLevelTypes.has(c.type)) return false;
    if (c.name === CHANGE_LOG_FRAME_NAME) return false;
    if (c.name.startsWith("Generation ") || c.name.startsWith("Try the plugin")) return false;
    if ("getPluginData" in c && (c as SceneNode).getPluginData("generated") === "true") return false;
    return true;
  });

  const lines: string[] = [];

  // ── Front matter (Copilot instructions) ──
  lines.push("---");
  lines.push(`applyTo: "**"`);
  lines.push("---");
  lines.push("");
  lines.push(`# Design System — ${pageName}`);
  lines.push("");
  lines.push(`> Auto-extracted from Figma on ${now}. Use these tokens and component specs as the`);
  lines.push(`> single source of truth when generating UI code for this project.`);
  lines.push("");

  // ── Color Palette ──
  lines.push("## Color Palette");
  lines.push("");
  if (tokens.colors && tokens.colors.length > 0) {
    lines.push("| Hex | Role |");
    lines.push("|-----|------|");
    // Build a set of known roles from named fill styles for smarter inference
    const knownPrimary = new Set<string>();
    const knownError = new Set<string>();
    for (const s of (ds.fillStyles || []) as any[]) {
      const lower = (s.name || "").toLowerCase();
      if (s.hex) {
        if (lower.includes("error") && !lower.includes("on error")) knownError.add(s.hex);
        else if (lower.includes("primary") && !lower.includes("on primary")) knownPrimary.add(s.hex);
      }
    }
    for (const hex of tokens.colors) {
      let role = "—";
      if (knownPrimary.has(hex)) role = "Primary";
      else if (knownError.has(hex)) role = "Error / Danger";
      else if (hex === "#FFFFFF" || hex === "#FCFBFF") role = "Background / Surface";
      else if (hex === "#000000" || hex === "#1C1B1F") role = "On Surface (text)";
      lines.push(`| \`${hex}\` | ${role} |`);
    }
  } else {
    lines.push("_No colors detected._");
  }
  lines.push("");

  // ── Named Fill Styles (filtered, with hex values) ──
  const filteredFillStyles = (ds.fillStyles || []).filter((s: any) =>
    !STATE_KEYWORDS.test(s.name) && !FIGMA_INTERNAL.test(s.name)
  );
  if (filteredFillStyles.length > 0) {
    // Group by Light/Dark prefix
    const lightStyles = filteredFillStyles.filter((s: any) => s.name.startsWith("Light/"));
    const darkStyles = filteredFillStyles.filter((s: any) => s.name.startsWith("Dark/"));
    const otherStyles = filteredFillStyles.filter((s: any) => !s.name.startsWith("Light/") && !s.name.startsWith("Dark/"));

    const renderStyleTable = (styles: any[], themePrefix: string) => {
      lines.push("| Token | Hex |");
      lines.push("|-------|-----|");
      for (const s of styles) {
        // Strip theme prefix ("Light/") then strip redundant group prefix ("Primary/PrimaryColor" → "PrimaryColor")
        let name = themePrefix ? s.name.replace(new RegExp("^" + themePrefix + "/"), "") : s.name;
        name = stripGroupPrefix(name);
        const hex = s.hex ? `\`${s.hex}\`` : "—";
        lines.push(`| ${name} | ${hex} |`);
      }
      lines.push("");
    };

    if (lightStyles.length > 0) {
      lines.push("### Light Theme Tokens");
      lines.push("");
      renderStyleTable(lightStyles, "Light");
    }
    if (darkStyles.length > 0) {
      lines.push("### Dark Theme Tokens");
      lines.push("");
      renderStyleTable(darkStyles, "Dark");
    }
    if (otherStyles.length > 0) {
      lines.push("### Other Color Tokens");
      lines.push("");
      renderStyleTable(otherStyles, "");
    }
  }

  // ── Typography ──
  lines.push("## Typography");
  lines.push("");
  if (tokens.fontFamilies && tokens.fontFamilies.length > 0) {
    lines.push("### Font Families");
    lines.push("");
    for (const ff of tokens.fontFamilies) {
      lines.push(`- ${ff}`);
    }
    lines.push("");
  }
  if (tokens.fontSizes && tokens.fontSizes.length > 0) {
    lines.push("### Type Scale (px)");
    lines.push("");
    lines.push(tokens.fontSizes.join(", "));
    lines.push("");
  }

  // Named text styles (filtered, rounded)
  const filteredTextStyles = (ds.textStyles || []).filter((s: any) =>
    !FIGMA_INTERNAL.test(s.name)
  );
  if (filteredTextStyles.length > 0) {
    lines.push("### Named Text Styles");
    lines.push("");
    lines.push("| Name | Font | Size | Line Height | Letter Spacing |");
    lines.push("|------|------|------|-------------|----------------|");
    for (const s of filteredTextStyles as any[]) {
      const font = s.fontFamily ? `${s.fontFamily} ${s.fontStyle || ""}`.trim() : "—";
      const size = s.fontSize ? `${s.fontSize}px` : "—";
      const lh = s.lineHeight !== undefined ? (s.lineHeight === "AUTO" ? "Auto" : `${s.lineHeight}`) : "—";
      const ls = s.letterSpacing !== undefined ? `${round(s.letterSpacing, 2)}` : "—";
      lines.push(`| ${s.name} | ${font} | ${size} | ${lh} | ${ls} |`);
    }
    lines.push("");
  }

  // ── Spacing (capped) ──
  lines.push("## Spacing Scale (px)");
  lines.push("");
  if (tokens.spacings && tokens.spacings.length > 0) {
    const capped = tokens.spacings.filter((v: number) => v <= MAX_TOKEN_VALUE);
    lines.push(capped.length > 0 ? capped.join(", ") : "_No spacing values detected._");
  } else {
    lines.push("_No spacing values detected._");
  }
  lines.push("");

  if (tokens.paddings && tokens.paddings.length > 0) {
    const capped = tokens.paddings.filter((v: number) => v <= MAX_TOKEN_VALUE);
    if (capped.length > 0) {
      lines.push("### Padding Values (px)");
      lines.push("");
      lines.push(capped.join(", "));
      lines.push("");
    }
  }

  // ── Corner Radii ──
  lines.push("## Corner Radii (px)");
  lines.push("");
  if (tokens.cornerRadii && tokens.cornerRadii.length > 0) {
    lines.push(tokens.cornerRadii.join(", "));
  } else {
    lines.push("_No corner radii detected._");
  }
  lines.push("");

  // ── Component Specs: Buttons (deduplicated) ──
  lines.push("## Components");
  lines.push("");
  if (tokens.buttonStyles && tokens.buttonStyles.length > 0) {
    const buttons = dedupeComponents(tokens.buttonStyles);
    lines.push("### Buttons");
    lines.push("");
    for (const btn of buttons) {
      // Use a descriptive label: "Primary Button", "Outline Button"
      let label = btn.name || "Button";
      if (btn.strokeColor && (!btn.fillColor || btn.fillColor === "#FFFFFF")) label = "Outline Button";
      else if (btn.fillColor && btn.fillColor !== "#FFFFFF") label = "Filled Button";
      lines.push(`**${label}**`);
      lines.push("");
      const props: string[] = [];
      if (btn.fillColor) props.push(`- Fill: \`${btn.fillColor}\``);
      if (btn.strokeColor) props.push(`- Border: \`${btn.strokeColor}\` (${typeof btn.strokeWeight === "number" ? btn.strokeWeight : 1}px)`);
      if (btn.cornerRadius !== undefined) props.push(`- Corner radius: ${btn.cornerRadius}px`);
      if (btn.height) props.push(`- Height: ${btn.height}px`);
      if (btn.textFontSize) props.push(`- Font size: ${btn.textFontSize}px`);
      if (btn.textFontFamily) props.push(`- Font: ${btn.textFontFamily} ${btn.textFontStyle || ""}`.trim());
      if (btn.textColor) props.push(`- Text color: \`${btn.textColor}\``);
      if (btn.layoutMode) {
        props.push(`- Layout: ${btn.layoutMode}`);
        const pad = [btn.paddingTop, btn.paddingRight, btn.paddingBottom, btn.paddingLeft].filter((v: number) => v !== undefined);
        if (pad.length > 0) props.push(`- Padding: ${pad.join(" / ")}px`);
      }
      if (btn.layoutSizingHorizontal) props.push(`- Horizontal sizing: ${btn.layoutSizingHorizontal}`);
      lines.push(props.join("\n"));
      lines.push("");
    }
  }

  // ── Component Specs: Inputs (deduplicated) ──
  if (tokens.inputStyles && tokens.inputStyles.length > 0) {
    const inputs = dedupeComponents(tokens.inputStyles);
    lines.push("### Text Inputs");
    lines.push("");
    for (const inp of inputs) {
      lines.push(`**${inp.name || "Input"}**`);
      lines.push("");
      const props: string[] = [];
      if (inp.fillColor) props.push(`- Fill: \`${inp.fillColor}\``);
      if (inp.strokeColor) props.push(`- Border: \`${inp.strokeColor}\` (${typeof inp.strokeWeight === "number" ? inp.strokeWeight : 1}px)`);
      if (inp.bottomBorderOnly) props.push(`- Bottom border only: ${typeof inp.bottomBorderWeight === "number" ? inp.bottomBorderWeight : 1}px`);
      if (inp.cornerRadius !== undefined) props.push(`- Corner radius: ${inp.cornerRadius}px`);
      if (inp.height) props.push(`- Height: ${inp.height}px`);
      if (inp.textFontSize) props.push(`- Font size: ${inp.textFontSize}px`);
      if (inp.textFontFamily) props.push(`- Font: ${inp.textFontFamily} ${inp.textFontStyle || ""}`.trim());
      if (inp.textColor) props.push(`- Text color: \`${inp.textColor}\``);
      if (inp.layoutMode) {
        props.push(`- Layout: ${inp.layoutMode}`);
        const pad = [inp.paddingTop, inp.paddingRight, inp.paddingBottom, inp.paddingLeft].filter((v: number) => v !== undefined);
        if (pad.length > 0) props.push(`- Padding: ${pad.join(" / ")}px`);
      }
      lines.push(props.join("\n"));
      lines.push("");
    }
  }

  // ── Named Components (Figma) ──
  if (ds.components && ds.components.length > 0) {
    lines.push("### Named Components");
    lines.push("");
    lines.push("| Name | Key |");
    lines.push("|------|-----|");
    for (const c of ds.components) {
      lines.push(`| ${c.name} | \`${c.key}\` |`);
    }
    lines.push("");
  }

  // ── Variables ──
  if (ds.variables && ds.variables.length > 0) {
    lines.push("## Design Variables");
    lines.push("");
    lines.push("| Name | ID |");
    lines.push("|------|----|");
    for (const v of ds.variables) {
      lines.push(`| ${v.name} | \`${v.id}\` |`);
    }
    lines.push("");
  }

  // ── Layout Patterns ──
  if (tokens.rootFrameLayouts && tokens.rootFrameLayouts.length > 0) {
    lines.push("## Layout Patterns");
    lines.push("");
    for (const layout of tokens.rootFrameLayouts) {
      lines.push(`**${layout.name}** — ${layout.width}×${layout.height}`);
      const props: string[] = [];
      if (layout.layoutMode) props.push(`Layout: ${layout.layoutMode}`);
      if (layout.fillColor) props.push(`Background: \`${layout.fillColor}\``);
      if (layout.paddingTop !== undefined) {
        props.push(`Padding: ${layout.paddingTop} / ${layout.paddingRight} / ${layout.paddingBottom} / ${layout.paddingLeft}`);
      }
      if (layout.itemSpacing) props.push(`Gap: ${layout.itemSpacing}px`);
      if (props.length > 0) lines.push(props.map(p => `- ${p}`).join("\n"));
      lines.push("");
    }
  }

  // ── Screen Inventory (only frames NOT already listed in Layout Patterns) ──
  const layoutNames = new Set((tokens.rootFrameLayouts || []).map((l: any) => l.name));
  const unlisted = designFrames.filter(f => !layoutNames.has(f.name));
  if (unlisted.length > 0) {
    lines.push("## Additional Screens");
    lines.push("");
    for (const f of unlisted) {
      const w = Math.round(f.width);
      const h = Math.round(f.height);
      lines.push(`- **${f.name}** (${w}×${h})`);
    }
    lines.push("");
  }

  const safeName = pageName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `design-system-${safeName}.md`;
  return { markdown: lines.join("\n"), filename };
}

// ── 4. Operation Applicators ────────────────────────────────────────

async function applyInsertComponent(op: Extract<Operation, { type: "INSERT_COMPONENT" }>) {
  const comp = await figma.importComponentByKeyAsync(op.componentKey);
  const instance = comp.createInstance();
  const parent = figma.getNodeById(op.parentId);
  if (parent && "appendChild" in parent) {
    (parent as FrameNode).appendChild(instance);
  }
}

function applyCreateFrame(op: Extract<Operation, { type: "CREATE_FRAME" }>) {
  const frame = figma.createFrame();
  frame.name = op.name;

  if (op.layout) {
    if (op.layout.direction) {
      frame.layoutMode = op.layout.direction;
    }
    // spacingToken / paddingToken — resolve from variables or use numeric fallback
    if (op.layout.spacingToken) {
      const spacing = parseFloat(op.layout.spacingToken);
      if (!isNaN(spacing)) {
        frame.itemSpacing = spacing;
      }
    }
    if (op.layout.paddingToken) {
      const pad = parseFloat(op.layout.paddingToken);
      if (!isNaN(pad)) {
        frame.paddingTop = pad;
        frame.paddingRight = pad;
        frame.paddingBottom = pad;
        frame.paddingLeft = pad;
      }
    }
  }

  const parent = figma.getNodeById(op.parentId);
  if (parent && "appendChild" in parent) {
    (parent as FrameNode).appendChild(frame);
  }
}

async function applySetText(op: Extract<Operation, { type: "SET_TEXT" }>) {
  let node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }

  // If the LLM targeted a container instead of the TEXT node, find the
  // best matching TEXT child (prefer one whose characters match the intent).
  if (node.type !== "TEXT" && "findOne" in node) {
    const container = node as FrameNode;
    // First try to find a text node that has non-empty content (likely the placeholder)
    const textChild = container.findOne((n) => n.type === "TEXT") as TextNode | null;
    if (textChild) {
      node = textChild;
    } else {
      throw new Error(`Node ${op.nodeId} is not a TEXT node and contains no TEXT children`);
    }
  } else if (node.type !== "TEXT") {
    throw new Error(`Node ${op.nodeId} is not a TEXT node`);
  }

  const textNode = node as TextNode;

  // Load all fonts used by this text node
  // fontName can be a FontName or figma.mixed — handle both cases
  const fontName = textNode.fontName;
  if (fontName === figma.mixed) {
    // Mixed fonts — load each character range individually
    const len = textNode.characters.length || 1;
    const loaded = new Set<string>();
    for (let i = 0; i < len; i++) {
      const f = textNode.getRangeFontName(i, i + 1);
      if (f !== figma.mixed) {
        const key = (f as FontName).family + "::" + (f as FontName).style;
        if (!loaded.has(key)) {
          loaded.add(key);
          await figma.loadFontAsync(f as FontName);
        }
      }
    }
  } else {
    await figma.loadFontAsync(fontName as FontName);
  }

  textNode.characters = op.text;
}

async function applyTextStyle(op: Extract<Operation, { type: "APPLY_TEXT_STYLE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node || node.type !== "TEXT") {
    throw new Error(`Node ${op.nodeId} is not a TEXT node`);
  }
  const textNode = node as TextNode;

  // Load fonts before assigning style
  const style = figma.getStyleById(op.styleId) as TextStyle | null;
  if (style) {
    await figma.loadFontAsync(style.fontName);
  }

  (textNode as any).textStyleId = op.styleId;
}

function applyFillStyle(op: Extract<Operation, { type: "APPLY_FILL_STYLE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if ("fillStyleId" in node) {
    (node as any).fillStyleId = op.styleId;
  } else {
    throw new Error(`Node ${op.nodeId} does not support fill styles`);
  }
}

function applyRenameNode(op: Extract<Operation, { type: "RENAME_NODE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  node.name = op.name;
}

async function applySetImage(op: Extract<Operation, { type: "SET_IMAGE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if (!("fills" in node)) {
    throw new Error(`Node ${op.nodeId} (${node.type}) does not support fills`);
  }

  // The backend resolves imagePrompt → imageBase64 before sending the response
  const base64 = (op as any).imageBase64 as string | undefined;
  if (!base64) {
    throw new Error(
      `No image data resolved for this SET_IMAGE (prompt: "${op.imagePrompt}"). ` +
      `Keys on op: ${Object.keys(op).join(", ")}`
    );
  }

  // Decode base64 to Uint8Array (atob is NOT available in Figma's sandbox)
  const lookup = new Uint8Array(128);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

  // Strip any data-url prefix if present
  const b64 = base64.indexOf(",") >= 0 ? base64.split(",")[1] : base64;
  const cleanB64 = b64.replace(/[^A-Za-z0-9+/]/g, "");  // strip whitespace/padding
  const rawLen = (cleanB64.length * 3) / 4;
  const bytes = new Uint8Array(rawLen);
  let p = 0;
  for (let i = 0; i < cleanB64.length; i += 4) {
    const a = lookup[cleanB64.charCodeAt(i)];
    const b = lookup[cleanB64.charCodeAt(i + 1)];
    const c = lookup[cleanB64.charCodeAt(i + 2)];
    const d = lookup[cleanB64.charCodeAt(i + 3)];
    bytes[p++] = (a << 2) | (b >> 4);
    if (i + 2 < cleanB64.length) bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < cleanB64.length) bytes[p++] = ((c & 3) << 6) | d;
  }
  const trimmed = bytes.slice(0, p);  // trim any excess from padding

  // Create a Figma image from raw bytes (runs locally, no network needed)
  const image = figma.createImage(trimmed);

  // Replace fills with a single image fill (FILL mode scales to cover)
  (node as GeometryMixin & SceneNode).fills = [
    {
      type: "IMAGE",
      scaleMode: "FILL",
      imageHash: image.hash,
    },
  ];
}

// ── Deep recursive scaling helper ───────────────────────────────────

/**
 * Bottom-up auto-layout tight-fit: walk the subtree and shrink each
 * auto-layout frame to exactly fit its children + padding + gaps.
 * This removes excess space caused by skipped descendants (icons, vectors).
 */
function tightFitAutoLayout(node: SceneNode): void {
  if (!("children" in node)) return;
  const r = node as any;
  const kids = r.children as SceneNode[];

  // Recurse children first (bottom-up)
  for (const kid of kids) {
    tightFitAutoLayout(kid);
  }

  // Only tight-fit auto-layout frames
  if (!("layoutMode" in node) || r.layoutMode === "NONE" || !("resize" in node)) return;

  const padTop = r.paddingTop || 0;
  const padBottom = r.paddingBottom || 0;
  const padLeft = r.paddingLeft || 0;
  const padRight = r.paddingRight || 0;
  const gap = r.itemSpacing || 0;
  const isHoriz = r.layoutMode === "HORIZONTAL";

  if (kids.length === 0) return;

  let neededH: number;
  let neededW: number;
  if (isHoriz) {
    neededH = padTop + Math.max(...kids.map((k: SceneNode) => k.height)) + padBottom;
    neededW = padLeft;
    for (let i = 0; i < kids.length; i++) {
      if (i > 0) neededW += gap;
      neededW += kids[i].width;
    }
    neededW += padRight;
  } else {
    neededH = padTop;
    for (let i = 0; i < kids.length; i++) {
      if (i > 0) neededH += gap;
      neededH += kids[i].height;
    }
    neededH += padBottom;
    neededW = padLeft + Math.max(...kids.map((k: SceneNode) => k.width)) + padRight;
  }

  const curW = (node as FrameNode).width;
  const curH = (node as FrameNode).height;
  const fitW = Math.min(curW, Math.round(neededW));
  const fitH = Math.min(curH, Math.round(neededH));

  if (fitH < curH || fitW < curW) {
    console.log(`[resize] Tight-fit "${node.name}" ${curW}x${curH} → ${fitW}x${fitH}`);
    // Clear min dimensions BEFORE resize so they don't block shrinking
    if (r.minHeight !== undefined) r.minHeight = null;
    if (r.minWidth !== undefined) r.minWidth = null;
    (node as FrameNode).resize(fitW, fitH);
    // Set min to new value after resize
    if (r.minHeight !== undefined) r.minHeight = fitH;
    if (r.minWidth !== undefined) r.minWidth = fitW;
  }
}

/**
 * After scaleSubtree, GRID containers may have cells whose content
 * wasn't scaled consistently (Figma's grid engine auto-manages cell
 * sizes, overriding our resize). Walk the tree, find GRID containers,
 * and scale each cell's content to match the reference (first) cell's
 * proportions.
 */
function normalizeGridCells(root: SceneNode, scaleX: number, scaleY: number): void {
  if (!("children" in root)) return;
  const kids = (root as any).children as SceneNode[];
  const rootR = root as any;

  // If this node is a GRID container with multiple children, normalize them
  if ("layoutMode" in root && rootR.layoutMode === "GRID" && kids.length > 1) {
    console.log(`[resize] Normalizing GRID "${root.name}" with ${kids.length} cells`);

    // Find the reference cell (first child) — it should already be scaled
    const refCell = kids[0];
    
    // For each sibling cell, ensure its internal content matches reference proportions
    for (let i = 1; i < kids.length; i++) {
      const cell = kids[i];
      if (!("children" in cell)) continue;
      const cellKids = (cell as any).children as SceneNode[];
      const refKids = "children" in refCell ? (refCell as any).children as SceneNode[] : [];

      // Match each child in this cell to the corresponding child in the reference cell
      for (let j = 0; j < cellKids.length && j < refKids.length; j++) {
        const refKid = refKids[j];
        const cellKid = cellKids[j];

        // If the reference child was resized but this one wasn't, fix it
        if ("resize" in cellKid && "resize" in refKid) {
          const cellKidR = cellKid as any;
          const cellKidOldW = cellKid.width;
          const cellKidOldH = cellKid.height;

          // Match the size to the reference child's size
          if (Math.abs(cellKid.height - refKid.height) > 1 || Math.abs(cellKid.width - refKid.width) > 1) {
            const targetH = refKid.height;
            const targetW = refKid.width;
            console.log(`[resize] GRID cell ${i} child "${cellKid.name}" ${cellKidOldW}x${cellKidOldH} → ${targetW}x${targetH} (matching reference "${refKid.name}")`);

            // Force FIXED sizing
            if ("layoutSizingVertical" in cellKid && cellKidR.layoutSizingVertical !== "FIXED") {
              cellKidR.layoutSizingVertical = "FIXED";
            }
            if ("layoutSizingHorizontal" in cellKid && cellKidR.layoutSizingHorizontal !== "FIXED") {
              cellKidR.layoutSizingHorizontal = "FIXED";
            }

            (cellKid as FrameNode).resize(targetW, targetH);

            // Compute the scale factors for this child's content
            const childScaleX = targetW / cellKidOldW;
            const childScaleY = targetH / cellKidOldH;

            // Scale padding/spacing on auto-layout children
            if ("layoutMode" in cellKid && cellKidR.layoutMode !== "NONE") {
              cellKidR.paddingTop = Math.round((cellKidR.paddingTop || 0) * childScaleY);
              cellKidR.paddingBottom = Math.round((cellKidR.paddingBottom || 0) * childScaleY);
              cellKidR.paddingLeft = Math.round((cellKidR.paddingLeft || 0) * childScaleX);
              cellKidR.paddingRight = Math.round((cellKidR.paddingRight || 0) * childScaleX);
              const isHoriz = cellKidR.layoutMode === "HORIZONTAL";
              cellKidR.itemSpacing = Math.round((cellKidR.itemSpacing || 0) * (isHoriz ? childScaleX : childScaleY));
            }

            // Recursively scale the content inside to match the reference
            scaleSubtree(cellKid, childScaleX, childScaleY);
          }
        }
      }
    }
  }

  // Recurse into children to find nested GRIDs
  for (const kid of kids) {
    normalizeGridCells(kid, scaleX, scaleY);
  }
}

function scaleSubtree(node: SceneNode, scaleX: number, scaleY: number): void {
  if (!("children" in node)) return;
  const kids = (node as any).children as SceneNode[];
  const parentLayout = "layoutMode" in node ? (node as any).layoutMode : "NONE";

  for (const kid of kids) {
    const kidR = kid as any;

    // Skip text nodes — don't resize, only reposition
    if (kid.type === "TEXT") {
      if (parentLayout === "NONE" || parentLayout === undefined) {
        kid.x = Math.round(kid.x * scaleX);
        kid.y = Math.round(kid.y * scaleY);
      }
      continue;
    }

    // Skip vector/path nodes — these are icon geometry, don't distort them
    const vectorTypes = ["VECTOR", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"];
    if (vectorTypes.includes(kid.type)) {
      if (parentLayout === "NONE" || parentLayout === undefined) {
        kid.x = Math.round(kid.x * scaleX);
        kid.y = Math.round(kid.y * scaleY);
      }
      console.log(`[resize] Skipping vector "${kid.name}" (${kid.type}) — reposition only`);
      continue;
    }

    // Skip small icon-like frames (< 48px both dims) — don't stretch icons
    const isSmallIconFrame = kid.width <= 48 && kid.height <= 48 &&
      "children" in kid &&
      ((kid as any).children as SceneNode[]).every(
        (c: SceneNode) => vectorTypes.includes(c.type) || c.type === "TEXT" || c.type === "ELLIPSE" ||
          (c.width <= 48 && c.height <= 48)
      );
    if (isSmallIconFrame) {
      if (parentLayout === "NONE" || parentLayout === undefined) {
        kid.x = Math.round(kid.x * scaleX);
        kid.y = Math.round(kid.y * scaleY);
      }
      console.log(`[resize] Skipping icon frame "${kid.name}" ${kid.width}x${kid.height} — reposition only`);
      continue;
    }

    const kOldW = kid.width;
    const kOldH = kid.height;
    let kNewW = Math.round(kOldW * scaleX);
    let kNewH = Math.round(kOldH * scaleY);

    // Preserve circular shapes — only for actual circles/ellipses,
    // not for square-ish containers (like icon frames)
    const hasRoundCorners = "cornerRadius" in kid &&
      typeof (kid as any).cornerRadius === "number" &&
      (kid as any).cornerRadius >= Math.min(kOldW, kOldH) / 2 - 2;
    const isCircular = kid.type === "ELLIPSE" ||
      (Math.abs(kOldW - kOldH) <= 5 && kOldW > 20 && hasRoundCorners);
    if (isCircular) {
      const maxDim = Math.max(kNewW, kNewH);
      kNewW = maxDim;
      kNewH = maxDim;
    }

    // Force FIXED sizing so resize sticks
    if ("layoutSizingHorizontal" in kid) {
      if (kidR.layoutSizingHorizontal !== "FIXED") kidR.layoutSizingHorizontal = "FIXED";
      if (kidR.layoutSizingVertical !== "FIXED") kidR.layoutSizingVertical = "FIXED";
    }

    if ("resize" in kid) {
      (kid as FrameNode).resize(kNewW, kNewH);
      console.log(`[resize] Deep-scaled "${kid.name}" ${kOldW}x${kOldH} → ${kNewW}x${kNewH}${isCircular ? " (circle)" : ""}`);
    }

    // Reposition in NONE-layout parents
    if (parentLayout === "NONE" || parentLayout === undefined) {
      const origX = kid.x;
      const origY = kid.y;
      kid.x = Math.round(origX * scaleX);
      kid.y = Math.round(origY * scaleY);

      // If circle enforcement made the node larger than proportional scaling,
      // center the extra growth around the node's proportionally-scaled center
      const proportionalW = Math.round(kOldW * scaleX);
      const proportionalH = Math.round(kOldH * scaleY);
      if (kNewW !== proportionalW) {
        const extraW = kNewW - proportionalW;
        kid.x -= Math.round(extraW / 2);
        console.log(`[resize] Centering "${kid.name}" x: shifted left by ${Math.round(extraW / 2)}px (circle grew ${extraW}px wider than proportional)`);
      }
      if (kNewH !== proportionalH) {
        const extraH = kNewH - proportionalH;
        kid.y -= Math.round(extraH / 2);
        console.log(`[resize] Centering "${kid.name}" y: shifted up by ${Math.round(extraH / 2)}px (circle grew ${extraH}px taller than proportional)`);
      }

      // Clamp to parent bounds preserving consistent padding
      const parentW = (node as any).width as number;
      const parentH = (node as any).height as number;

      // Compute original margins (before scaling) to determine padding
      const parentOldW = scaleX !== 0 ? parentW / scaleX : parentW;
      const parentOldH = scaleY !== 0 ? parentH / scaleY : parentH;
      const origLeftMargin = origX;
      const origRightMargin = Math.max(0, parentOldW - origX - kOldW);
      const origTopMargin = origY;
      const origBottomMargin = Math.max(0, parentOldH - origY - kOldH);

      // Use the smaller of the two margins (the tighter side) as min padding
      const minHPad = Math.round(Math.min(origLeftMargin, origRightMargin) * scaleX);
      const minVPad = Math.round(Math.min(origTopMargin, origBottomMargin) * scaleY);

      // Clamp right/bottom first, then left/top
      if (kid.x + kNewW > parentW - minHPad) {
        const clamped = Math.max(minHPad, parentW - kNewW - minHPad);
        console.log(`[resize] Clamping "${kid.name}" x: ${kid.x} → ${clamped} (preserving ${minHPad}px padding)`);
        kid.x = clamped;
      }
      if (kid.x < minHPad && kid.x + kNewW + minHPad <= parentW) {
        // Only enforce left padding if there's room
        console.log(`[resize] Clamping "${kid.name}" x: ${kid.x} → ${minHPad} (left padding)`);
        kid.x = minHPad;
      }
      if (kid.x < 0) kid.x = 0;

      if (kid.y + kNewH > parentH - minVPad) {
        const clamped = Math.max(minVPad, parentH - kNewH - minVPad);
        console.log(`[resize] Clamping "${kid.name}" y: ${kid.y} → ${clamped} (preserving ${minVPad}px padding)`);
        kid.y = clamped;
      }
      if (kid.y < minVPad && kid.y + kNewH + minVPad <= parentH) {
        console.log(`[resize] Clamping "${kid.name}" y: ${kid.y} → ${minVPad} (top padding)`);
        kid.y = minVPad;
      }
      if (kid.y < 0) kid.y = 0;
    }

    // Scale corner radius
    if ("cornerRadius" in kid) {
      const cr = kidR.cornerRadius;
      if (typeof cr === "number" && cr > 0) {
        kidR.cornerRadius = Math.round(cr * Math.max(scaleX, scaleY));
      }
    }

    // Scale padding/spacing on auto-layout children
    if ("layoutMode" in kid && kidR.layoutMode !== "NONE") {
      if ("paddingTop" in kid) {
        kidR.paddingTop = Math.round((kidR.paddingTop || 0) * scaleY);
        kidR.paddingBottom = Math.round((kidR.paddingBottom || 0) * scaleY);
        kidR.paddingLeft = Math.round((kidR.paddingLeft || 0) * scaleX);
        kidR.paddingRight = Math.round((kidR.paddingRight || 0) * scaleX);
      }
      if ("itemSpacing" in kid) {
        const isHoriz = kidR.layoutMode === "HORIZONTAL";
        kidR.itemSpacing = Math.round((kidR.itemSpacing || 0) * (isHoriz ? scaleX : scaleY));
      }
    }

    // Recurse into children
    scaleSubtree(kid, scaleX, scaleY);
  }
}

// ── Apply single operation (dispatcher) ─────────────────────────────

function applyResizeNode(op: Extract<Operation, { type: "RESIZE_NODE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if (!("resize" in node)) {
    throw new Error(`Node ${op.nodeId} (${node.type}) does not support resize`);
  }
  const resizable = node as SceneNode & {
    resize(w: number, h: number): void;
    resizeWithoutConstraints(w: number, h: number): void;
    x: number; y: number; width: number; height: number;
  };
  const r = resizable as any;
  const oldW = resizable.width;
  const oldH = resizable.height;
  const newW = op.width ?? oldW;
  const newH = op.height ?? oldH;

  // ── Refinement mode: simple resize only ───────────────────
  if (_skipResizePropagation) {
    console.log(`[resize] Refinement: "${node.name}" ${oldW}x${oldH} → ${newW}x${newH}`);
    if ("layoutSizingHorizontal" in resizable) {
      if (op.width !== undefined && r.layoutSizingHorizontal !== "FIXED") r.layoutSizingHorizontal = "FIXED";
      if (op.height !== undefined && r.layoutSizingVertical !== "FIXED") r.layoutSizingVertical = "FIXED";
    }
    resizable.resize(newW, newH);
    return;
  }

  // ── Diagnostics: before ───────────────────────────────────
  console.log(`[resize] Node ${op.nodeId} type=${node.type} name="${node.name}" old=${oldW}x${oldH} new=${newW}x${newH}`);
  if ("absoluteBoundingBox" in resizable) {
    const bb = r.absoluteBoundingBox;
    console.log(`[resize] BEFORE absoluteBoundingBox: x=${bb?.x} y=${bb?.y} w=${bb?.width} h=${bb?.height}`);
  }
  if ("absoluteRenderBounds" in resizable) {
    const rb = r.absoluteRenderBounds;
    console.log(`[resize] BEFORE absoluteRenderBounds: x=${rb?.x} y=${rb?.y} w=${rb?.width} h=${rb?.height}`);
  }
  console.log(`[resize] visible=${r.visible} opacity=${r.opacity} clipsContent=${r.clipsContent}`);
  if ("fills" in resizable) {
    try {
      const fills = r.fills;
      console.log(`[resize] fills: ${JSON.stringify(fills)}`);
    } catch (_e) { console.log("[resize] fills: mixed"); }
  }
  if ("layoutMode" in resizable) {
    console.log(`[resize] layoutMode=${r.layoutMode} primaryAxisSizingMode=${r.primaryAxisSizingMode} counterAxisSizingMode=${r.counterAxisSizingMode}`);
    console.log(`[resize] padding: T=${r.paddingTop} B=${r.paddingBottom} L=${r.paddingLeft} R=${r.paddingRight} gap=${r.itemSpacing}`);
  }
  if ("layoutSizingHorizontal" in resizable) {
    console.log(`[resize] layoutSizing: H=${r.layoutSizingHorizontal} V=${r.layoutSizingVertical}`);
  }
  const parent = resizable.parent;
  if (parent) {
    console.log(`[resize] parent: type=${parent.type} name="${parent.name}" layoutMode=${"layoutMode" in parent ? (parent as any).layoutMode : "N/A"}`);
  }
  // Log children
  if ("children" in resizable) {
    const kids = (resizable as any).children as SceneNode[];
    console.log(`[resize] children count=${kids.length}`);
    for (const kid of kids) {
      console.log(`[resize]   child: id=${kid.id} type=${kid.type} name="${kid.name}" size=${kid.width}x${kid.height}`);
    }
  }

  // ── Force sizing to FIXED ─────────────────────────────────
  if ("layoutSizingHorizontal" in resizable) {
    if (op.width !== undefined && r.layoutSizingHorizontal !== "FIXED") {
      r.layoutSizingHorizontal = "FIXED";
    }
    if (op.height !== undefined && r.layoutSizingVertical !== "FIXED") {
      r.layoutSizingVertical = "FIXED";
    }
  }
  if ("primaryAxisSizingMode" in resizable) {
    if (r.primaryAxisSizingMode === "AUTO") r.primaryAxisSizingMode = "FIXED";
    if (r.counterAxisSizingMode === "AUTO") r.counterAxisSizingMode = "FIXED";
  }

  // ── Snapshot gaps between siblings BEFORE resize ─────────
  // For every NONE-layout ancestor, record the gaps between
  // sorted siblings so we can restore them after resize.
  type GapSnapshot = { parentId: string; nodeId: string; gaps: { sibId: string; gap: number }[] };
  const gapSnapshots: GapSnapshot[] = [];
  {
    let cur: SceneNode = resizable;
    for (let d = 0; d < 10; d++) {
      const p = cur.parent;
      if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
      const pAny = p as any;
      const pLayout = "layoutMode" in p ? pAny.layoutMode : "NONE";
      if (pLayout === "NONE" && "children" in p) {
        const sibs = (pAny.children as SceneNode[]).slice().sort((a: SceneNode, b: SceneNode) => a.y - b.y);
        const idx = sibs.findIndex((s: SceneNode) => s.id === cur.id);
        if (idx >= 0) {
          const gaps: { sibId: string; gap: number }[] = [];
          const curBottom = cur.y + cur.height;
          for (let i = idx + 1; i < sibs.length; i++) {
            const prev = i === idx + 1 ? cur : sibs[i - 1];
            const prevBottom = prev.y + prev.height;
            gaps.push({ sibId: sibs[i].id, gap: sibs[i].y - prevBottom });
          }
          gapSnapshots.push({ parentId: p.id, nodeId: cur.id, gaps });
          console.log(`[resize] Gap snapshot at "${(p as any).name}": ${gaps.map(g => `${g.sibId}:${g.gap}px`).join(", ")}`);
        }
      }
      cur = p as SceneNode;
    }
  }

  // ── Scale corner radius proportionally ────────────────────
  if ("cornerRadius" in resizable) {
    const cr = r.cornerRadius;
    if (typeof cr === "number" && cr > 0) {
      const scale = Math.max(newW / oldW, newH / oldH);
      r.cornerRadius = Math.round(cr * scale);
    }
  }

  // ── Perform the actual resize ─────────────────────────────
  // Clear minHeight/minWidth first so resize isn't blocked
  if ("layoutMode" in resizable && r.layoutMode !== "NONE") {
    if (r.minHeight !== undefined) r.minHeight = null;
    if (r.minWidth !== undefined) r.minWidth = null;
  }
  resizable.resize(newW, newH);
  // NOTE: Don't set minHeight here — wait until after tight-fit adjustments

  // ── Scale entire subtree proportionally ───────────────────
  const scaleX = newW / oldW;
  const scaleY = newH / oldH;

  // Scale padding/spacing on the resized section itself
  if ("layoutMode" in resizable && r.layoutMode !== "NONE") {
    r.paddingTop = Math.round((r.paddingTop || 0) * scaleY);
    r.paddingBottom = Math.round((r.paddingBottom || 0) * scaleY);
    r.paddingLeft = Math.round((r.paddingLeft || 0) * scaleX);
    r.paddingRight = Math.round((r.paddingRight || 0) * scaleX);
    const isHoriz = r.layoutMode === "HORIZONTAL";
    r.itemSpacing = Math.round((r.itemSpacing || 0) * (isHoriz ? scaleX : scaleY));
  }

  // Recursively scale ALL descendants (deep, not just direct children)
  scaleSubtree(resizable as SceneNode, scaleX, scaleY);

  // ── Normalize GRID cells ──────────────────────────────────
  // GRID containers auto-manage cell sizes. After scaleSubtree,
  // some cells may have inconsistent content. Match all cells to
  // the reference (first) cell's proportions.
  normalizeGridCells(resizable as SceneNode, scaleX, scaleY);
  // Also check if the resized node ITSELF sits inside a GRID parent —
  // the GRID may have auto-resized sibling cells that need normalizing.
  if (resizable.parent && "layoutMode" in resizable.parent && (resizable.parent as any).layoutMode === "GRID") {
    console.log(`[resize] Parent "${resizable.parent.name}" is GRID — normalizing sibling cells`);
    normalizeGridCells(resizable.parent as SceneNode, scaleX, scaleY);
  }

  // ── Bottom-up tight-fit ───────────────────────────────────
  // After scaling, some descendants (icons, vectors) were skipped,
  // leaving auto-layout frames oversized. Walk bottom-up and shrink
  // each auto-layout frame to exactly fit its content.
  tightFitAutoLayout(resizable as SceneNode);

  // ── Content-tight-fit adjustment ────────────────────────
  // After scaling, the section may be larger than its content needs.
  // Shrink to fit content so gap between sections stays minimal.
  // Applies to any auto-layout section (not just transparent wrappers).
  if ("children" in resizable && "layoutMode" in resizable) {
    try {
      const layoutMode = r.layoutMode;
      if (layoutMode && layoutMode !== "NONE") {
        const kids = (resizable as any).children as SceneNode[];
        if (kids.length > 0) {
          const padTop = r.paddingTop || 0;
          const padBottom = r.paddingBottom || 0;
          const padLeft = r.paddingLeft || 0;
          const padRight = r.paddingRight || 0;
          const gapVal = r.itemSpacing || 0;
          const isHorizontal = layoutMode === "HORIZONTAL";

          // Current content size (after scaling)
          let contentH: number;
          let contentW: number;
          if (isHorizontal) {
            // HORIZONTAL: height = tallest child + padding
            contentH = padTop + Math.max(...kids.map((k: SceneNode) => k.height)) + padBottom;
            contentW = padLeft;
            for (let i = 0; i < kids.length; i++) {
              if (i > 0) contentW += gapVal;
              contentW += kids[i].width;
            }
            contentW += padRight;
          } else {
            // VERTICAL: height = sum of children + gaps + padding
            contentH = padTop;
            for (let i = 0; i < kids.length; i++) {
              if (i > 0) contentH += gapVal;
              contentH += kids[i].height;
            }
            contentH += padBottom;
            contentW = padLeft + Math.max(...kids.map((k: SceneNode) => k.width)) + padRight;
          }

          // Original content size (undo scaling to compute delta)
          let origContentH: number;
          if (isHorizontal) {
            origContentH = Math.round(padTop / scaleY)
              + Math.max(...kids.map((k: SceneNode) => Math.round(k.height / scaleY)))
              + Math.round(padBottom / scaleY);
          } else {
            origContentH = Math.round(padTop / scaleY);
            for (let i = 0; i < kids.length; i++) {
              if (i > 0) origContentH += Math.round(gapVal / scaleY);
              origContentH += Math.round(kids[i].height / scaleY);
            }
            origContentH += Math.round(padBottom / scaleY);
          }

          // Section should grow only by the content delta
          const contentDelta = contentH - origContentH;
          const adjustedH = Math.round(oldH + contentDelta);
          if (adjustedH < newH && adjustedH > oldH) {
            console.log(`[resize] Content tight-fit (${layoutMode}): ${newH}px → ${adjustedH}px (content grew ${Math.round(contentDelta)}px, saved ${newH - adjustedH}px)`);
            if (r.minHeight !== undefined) r.minHeight = null;
            resizable.resize(newW, adjustedH);
            r.minHeight = adjustedH;
          } else if (adjustedH <= oldH) {
            // Content didn't actually grow (e.g. icons skipped) — keep original size
            console.log(`[resize] Content tight-fit (${layoutMode}): content didn't grow, reverting to original ${oldH}px`);
            if (r.minHeight !== undefined) r.minHeight = null;
            resizable.resize(newW, oldH);
            r.minHeight = oldH;
          }
        }
      }
    } catch (_e) { /* skip adjustment on error */ }
  }

  // ── Measure ACTUAL height/width change after all adjustments ──
  // This is far more reliable than trying to predict the delta
  // through tight-fit calculations.
  const actualDH = resizable.height - oldH;
  const actualDW = resizable.width - oldW;
  console.log(`[resize] Actual measured delta: dW=${actualDW} dH=${actualDH} (frame is now ${resizable.width}x${resizable.height})`);

  // ── Propagate size change up the tree ─────────────────────
  // Walk up ancestors. Only grow when the child truly overflows
  // the parent. Track the running delta at each level — it can
  // shrink to 0 when a child fits inside its parent.
  if (actualDH !== 0 || actualDW !== 0) {
    let current: SceneNode = resizable;
    let runningDH = actualDH;
    let runningDW = actualDW;

    for (let depth = 0; depth < 10; depth++) {
      const par = current.parent;
      if (!par || par.type === "PAGE" || par.type === "DOCUMENT") break;

      const parAny = par as any;
      const parLayout = "layoutMode" in par ? parAny.layoutMode : "NONE";

      if (parLayout !== "NONE") {
        // Auto-layout parent — it reflows siblings automatically.
        // Only grow if the child actually overflows the parent's content area.
        if ("resize" in par) {
          const pf = par as FrameNode;
          const isHoriz = parLayout === "HORIZONTAL";

          if (isHoriz) {
            // HORIZONTAL layout: height = counter axis. Only grow if
            // child height exceeds available content height.
            const padT = parAny.paddingTop || 0;
            const padB = parAny.paddingBottom || 0;
            const availH = pf.height - padT - padB;
            const overflow = current.height - availH;
            if (overflow > 0 && (parAny.layoutSizingVertical === "FIXED" || parAny.counterAxisSizingMode === "FIXED")) {
              console.log(`[resize] HORIZONTAL ancestor "${pf.name}": child ${current.height}px overflows avail ${availH}px by ${overflow}px → grow ${pf.height} → ${pf.height + overflow}`);
              if (parAny.minHeight !== undefined) parAny.minHeight = null;
              pf.resize(pf.width, pf.height + overflow);
              if (parAny.minHeight !== undefined) parAny.minHeight = pf.height;
              runningDH = overflow;
            } else {
              console.log(`[resize] HORIZONTAL ancestor "${pf.name}": child ${current.height}px fits in avail ${availH}px — no growth needed`);
              runningDH = 0;
            }
          } else {
            // VERTICAL layout: children stack vertically, so height
            // grows by the child's delta.
            if (runningDH > 0 && (parAny.layoutSizingVertical === "FIXED" || parAny.primaryAxisSizingMode === "FIXED")) {
              console.log(`[resize] VERTICAL ancestor "${pf.name}": grow ${pf.height} → ${pf.height + runningDH}`);
              if (parAny.minHeight !== undefined) parAny.minHeight = null;
              pf.resize(pf.width, pf.height + runningDH);
              if (parAny.minHeight !== undefined) parAny.minHeight = pf.height;
            }
          }
        }
        current = par as SceneNode;
        continue;
      }

      // If no remaining delta, skip shifting/growing
      if (runningDH === 0 && runningDW === 0) {
        current = par as SceneNode;
        continue;
      }

      // Parent has NO auto-layout — shift siblings at EVERY NONE-layout level
      if ("children" in par) {
        const siblings = parAny.children as SceneNode[];
        const sorted = siblings.slice().sort((a: SceneNode, b: SceneNode) => a.y - b.y);
        const idx = sorted.findIndex((s: SceneNode) => s.id === current.id);

        for (let i = idx + 1; i < sorted.length; i++) {
          const sib = sorted[i];
          console.log(`[resize] Shifting "${sib.name}" y: ${sib.y} → ${sib.y + runningDH} (at ancestor "${(par as any).name}")`);
          sib.y += runningDH;
        }
      }

      // Grow this parent to accommodate
      if ("resize" in par) {
        const pf = par as FrameNode;
        const grewH = runningDH > 0 ? runningDH : 0;
        const grewW = runningDW > 0 ? runningDW : 0;
        if (grewH > 0 || grewW > 0) {
          console.log(`[resize] Growing ancestor "${pf.name}" ${pf.width}x${pf.height} → ${pf.width + grewW}x${pf.height + grewH}`);
          pf.resize(pf.width + grewW, pf.height + grewH);
        }
      }

      current = par as SceneNode;
    }
  }

  // ── Post-resize gap correction ────────────────────────────
  // Regardless of what actualDH said, walk through our snapshots and
  // reposition siblings so the original gaps are preserved exactly.
  for (const snap of gapSnapshots) {
    const snapParent = figma.getNodeById(snap.parentId);
    const snapNode = figma.getNodeById(snap.nodeId);
    if (!snapParent || !snapNode || !("children" in snapParent)) continue;
    const sibs = ((snapParent as any).children as SceneNode[]).slice().sort((a: SceneNode, b: SceneNode) => a.y - b.y);
    const idx = sibs.findIndex((s: SceneNode) => s.id === snap.nodeId);
    if (idx < 0) continue;

    // Reposition each sibling after the resized node to preserve original gaps
    for (let i = 0; i < snap.gaps.length; i++) {
      const gapInfo = snap.gaps[i];
      const sib = figma.getNodeById(gapInfo.sibId) as SceneNode | null;
      if (!sib) continue;
      const prev = i === 0 ? (snapNode as SceneNode) : (figma.getNodeById(snap.gaps[i - 1].sibId) as SceneNode);
      if (!prev) continue;
      const prevBottom = prev.y + prev.height;
      const expectedY = prevBottom + gapInfo.gap;
      if (Math.abs(sib.y - expectedY) > 0.5) {
        console.log(`[resize] Gap correction: "${sib.name}" y: ${sib.y} → ${expectedY} (gap=${gapInfo.gap}px after "${prev.name}")`);
        sib.y = expectedY;
      }
    }

    // Grow parent to fit all children
    if ("resize" in snapParent) {
      const pf = snapParent as FrameNode;
      const lastChild = sibs[sibs.length - 1];
      const neededH = (lastChild.y + lastChild.height) - sibs[0].y + (sibs[0].y - 0); // relative to frame top
      // Use the bottom of last child relative to frame origin
      const bottomEdge = lastChild.y + lastChild.height;
      if (bottomEdge > pf.height) {
        console.log(`[resize] Gap correction: growing "${pf.name}" ${pf.height} → ${bottomEdge}`);
        pf.resize(pf.width, bottomEdge);
      }
    }
  }

  // ── Ensure all ancestors fit their content ────────────────
  // After all resize, propagation, gap correction, and shifting,
  // walk from the resized node to the root frame and grow any
  // ancestor whose children extend past its bottom/right edge.
  {
    let cur: SceneNode = resizable;
    for (let d = 0; d < 15; d++) {
      const p = cur.parent;
      if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
      if ("children" in p && "resize" in p) {
        const pf = p as FrameNode;
        const pAny = p as any;
        const kids = (pAny.children as SceneNode[]);
        let maxBottom = 0;
        let maxRight = 0;
        for (const kid of kids) {
          const kidBottom = kid.y + kid.height;
          const kidRight = kid.x + kid.width;
          if (kidBottom > maxBottom) maxBottom = kidBottom;
          if (kidRight > maxRight) maxRight = kidRight;
        }
        // Add bottom/right padding for auto-layout frames
        const padB = pAny.paddingBottom || 0;
        const padR = pAny.paddingRight || 0;
        const neededH = maxBottom + padB;
        const neededW = maxRight + padR;
        let grew = false;
        let finalW = pf.width;
        let finalH = pf.height;
        if (neededH > pf.height + 0.5) {
          finalH = neededH;
          grew = true;
        }
        if (neededW > pf.width + 0.5) {
          finalW = neededW;
          grew = true;
        }
        if (grew) {
          console.log(`[resize] Fit-content: growing "${pf.name}" ${pf.width}x${pf.height} → ${finalW}x${finalH}`);
          if (pAny.minHeight !== undefined) pAny.minHeight = null;
          if (pAny.minWidth !== undefined) pAny.minWidth = null;
          pf.resize(finalW, finalH);
        }
      }
      cur = p as SceneNode;
    }
  }

  // ── Diagnostics: after ────────────────────────────────────
  console.log(`[resize] AFTER: width=${resizable.width} height=${resizable.height}`);

  // ── Re-select + zoom to show the resize visually ───────
  figma.currentPage.selection = [resizable];
  figma.viewport.scrollAndZoomIntoView([resizable]);
  console.log(`[resize] Done`);
}

function applyMoveNode(op: Extract<Operation, { type: "MOVE_NODE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  const movable = node as SceneNode;
  movable.x = op.x;
  movable.y = op.y;
}

function applyCloneNode(op: Extract<Operation, { type: "CLONE_NODE" }>) {
  const sourceNode = figma.getNodeById(op.nodeId);
  if (!sourceNode) {
    throw new Error(`Source node ${op.nodeId} not found`);
  }
  const parentNode = figma.getNodeById(op.parentId);
  if (!parentNode) {
    throw new Error(`Parent node ${op.parentId} not found`);
  }
  if (!("children" in parentNode)) {
    throw new Error(`Parent node ${op.parentId} (${parentNode.type}) cannot have children`);
  }

  const source = sourceNode as SceneNode;
  const parent = parentNode as FrameNode;
  const parentOldH = parent.height;
  const clone = source.clone();

  // Insert into parent at specified index
  if (op.insertIndex !== undefined && op.insertIndex < parent.children.length) {
    parent.insertChild(op.insertIndex, clone);
  } else {
    parent.appendChild(clone);
  }

  // Determine parent layout to position the clone correctly
  const pAny = parent as any;
  const pLayout = "layoutMode" in parent ? pAny.layoutMode : "NONE";

  if (pLayout === "NONE") {
    // Find a representative gap between siblings in this parent.
    // Scan all adjacent pairs (sorted by y) and pick the most common
    // positive gap — this matches existing spacing on the page.
    const allSibs = (pAny.children as SceneNode[]);
    const sortedSibs = allSibs
      .filter((c: SceneNode) => c.id !== clone.id)
      .slice()
      .sort((a: SceneNode, b: SceneNode) => a.y - b.y);

    const gaps: number[] = [];
    for (let i = 1; i < sortedSibs.length; i++) {
      const prevBottom = sortedSibs[i - 1].y + sortedSibs[i - 1].height;
      const gap = sortedSibs[i].y - prevBottom;
      if (gap > 0) gaps.push(gap);
    }

    // Use the most common gap, or fallback to the gap right after source, or 0
    let typicalGap = 0;
    if (gaps.length > 0) {
      // Round gaps to nearest integer to group similar values
      const rounded = gaps.map(g => Math.round(g));
      const counts = new Map<number, number>();
      for (const g of rounded) counts.set(g, (counts.get(g) || 0) + 1);
      let bestGap = rounded[0];
      let bestCount = 0;
      for (const [g, c] of counts) {
        if (c > bestCount) { bestCount = c; bestGap = g; }
      }
      typicalGap = bestGap;
    }
    console.log(`[clone] Detected typical gap between siblings: ${typicalGap}px (from ${gaps.length} pairs: ${gaps.map(g => Math.round(g)).join(",")})`);

    // Place clone directly below the source with the typical gap
    clone.x = source.x;
    clone.y = source.y + source.height + typicalGap;
    console.log(`[clone] Positioned clone at y=${clone.y} (source bottom=${source.y + source.height}, gap=${typicalGap})`);

    // Shift all siblings that were below the source down by clone height + gap
    const shiftAmount = clone.height + typicalGap;
    for (const sib of allSibs) {
      if (sib.id === clone.id || sib.id === source.id) continue;
      if (sib.y >= clone.y - 0.5) {
        console.log(`[clone] Shifting sibling "${sib.name}" y: ${sib.y} → ${sib.y + shiftAmount}`);
        sib.y += shiftAmount;
      }
    }

    // Grow parent to accommodate
    const lastChild = allSibs.reduce((max: SceneNode, c: SceneNode) =>
      (c.y + c.height > max.y + max.height) ? c : max, allSibs[0]);
    const padB = pAny.paddingBottom || 0;
    const neededH = lastChild.y + lastChild.height + padB;
    if (neededH > parent.height + 0.5) {
      console.log(`[clone] Growing parent "${parent.name}" ${parent.height} → ${neededH}`);
      if (pAny.minHeight !== undefined) pAny.minHeight = null;
      parent.resize(parent.width, neededH);
    }
  }
  // For auto-layout parents (HORIZONTAL/VERTICAL), Figma handles positioning automatically.

  // Walk up all ancestors: shift siblings below cur and grow frames.
  // Track how much the current node grew so we know how far to shift
  // siblings at each level.
  let cur: SceneNode = parent;
  let shiftDelta = parent.height - parentOldH; // how much the direct parent grew
  console.log(`[clone] Parent grew by ${shiftDelta}px (${parentOldH} → ${parent.height})`);

  for (let d = 0; d < 15; d++) {
    if (shiftDelta < 0.5) break; // nothing to propagate

    const p = cur.parent;
    if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;

    if (!("children" in p) || !("resize" in p)) {
      cur = p as SceneNode;
      continue;
    }

    const pf = p as FrameNode;
    const ppAny = p as any;
    const ppLayout = "layoutMode" in p ? ppAny.layoutMode : "NONE";

    if (ppLayout === "NONE") {
      // cur grew — shift all siblings that are below cur
      const sibs = (ppAny.children as SceneNode[]);
      // Use cur's old bottom = cur.y + cur.height - shiftDelta
      // (cur already grew, so subtract shiftDelta to get where it ended before)
      const curOldBottom = cur.y + cur.height - shiftDelta;
      for (const sib of sibs) {
        if (sib.id === cur.id) continue;
        if (sib.y >= curOldBottom - 0.5) {
          console.log(`[clone] Shifting "${sib.name}" y: ${sib.y} → ${sib.y + shiftDelta} (at "${pf.name}")`);
          sib.y += shiftDelta;
        }
      }
    }

    // Grow ancestor to fit all children
    const kids = (ppAny.children as SceneNode[]);
    let maxBottom = 0;
    for (const kid of kids) {
      const kb = kid.y + kid.height;
      if (kb > maxBottom) maxBottom = kb;
    }
    const ppPadB = ppAny.paddingBottom || 0;
    const ppNeededH = maxBottom + ppPadB;
    const oldAncH = pf.height;
    if (ppNeededH > pf.height + 0.5) {
      console.log(`[clone] Growing ancestor "${pf.name}" ${pf.height} → ${ppNeededH}`);
      if (ppAny.minHeight !== undefined) ppAny.minHeight = null;
      pf.resize(pf.width, ppNeededH);
    }

    // Update shiftDelta for the next level — it's how much THIS ancestor grew
    shiftDelta = pf.height - oldAncH;
    cur = p as SceneNode;
  }
  // The parent may also auto-resize if its sizing mode is HUG.

  console.log(`[clone] Cloned "${source.name}" (${source.id}) → "${clone.name}" (${clone.id}) into "${parent.name}" (${parent.id})`);
}

// ── DELETE_NODE ─────────────────────────────────────────────────────

function applyDeleteNode(op: Extract<Operation, { type: "DELETE_NODE" }>) {
  const targetNode = figma.getNodeById(op.nodeId);
  if (!targetNode) {
    throw new Error(`Node ${op.nodeId} not found`);
  }

  const target = targetNode as SceneNode;
  const parent = target.parent;

  if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") {
    // Top-level frame on the page — just remove it, no shifting needed
    console.log(`[delete] Removing top-level node "${target.name}" (${target.id})`);
    target.remove();
    return;
  }

  if (!("children" in parent) || !("resize" in parent)) {
    console.log(`[delete] Removing "${target.name}" from non-frame parent "${parent.name}"`);
    target.remove();
    return;
  }

  const pf = parent as FrameNode;
  const pAny = parent as any;
  const pLayout = "layoutMode" in parent ? pAny.layoutMode : "NONE";

  // Record target geometry before removal
  const targetY = target.y;
  const targetH = target.height;
  const parentOldH = pf.height;

  // Determine the gap that existed between the deleted node and the next sibling below
  // so we can close the space cleanly.
  let gapToClose = targetH;
  if (pLayout === "NONE") {
    // Find the typical gap between siblings (same logic as CLONE_NODE)
    const allSibs = (pAny.children as SceneNode[]);
    const sortedSibs = allSibs
      .filter((c: SceneNode) => c.id !== target.id)
      .slice()
      .sort((a: SceneNode, b: SceneNode) => a.y - b.y);

    // Also look at where the deleted node sat in the sorted order to determine
    // the gap we should close. Find the sibling directly above and below.
    const allSorted = allSibs.slice().sort((a: SceneNode, b: SceneNode) => a.y - b.y);
    const targetIdx = allSorted.findIndex(s => s.id === target.id);
    
    // Gap above the target
    const sibAbove = targetIdx > 0 ? allSorted[targetIdx - 1] : null;
    const sibBelow = targetIdx < allSorted.length - 1 ? allSorted[targetIdx + 1] : null;

    let gapAbove = 0;
    if (sibAbove) {
      gapAbove = target.y - (sibAbove.y + sibAbove.height);
      if (gapAbove < 0) gapAbove = 0;
    }

    let gapBelow = 0;
    if (sibBelow) {
      gapBelow = sibBelow.y - (target.y + target.height);
      if (gapBelow < 0) gapBelow = 0;
    }

    // Total vertical space the target occupies including one gap
    // Keep one gap (the one above) so siblings below close up naturally
    gapToClose = targetH + gapBelow;
    console.log(`[delete] Target "${target.name}" y=${targetY} h=${targetH} gapAbove=${gapAbove} gapBelow=${gapBelow} → shifting siblings up by ${gapToClose}px`);

    // Remove the target node
    const targetName = target.name;
    target.remove();
    console.log(`[delete] Removed "${targetName}"`);

    // Shift all siblings that were below the target upward
    // Re-read children after removal
    const remainingSibs = (pAny.children as SceneNode[]);
    for (const sib of remainingSibs) {
      if (sib.y >= targetY + targetH - 0.5) {
        console.log(`[delete] Shifting sibling "${sib.name}" y: ${Math.round(sib.y)} → ${Math.round(sib.y - gapToClose)}`);
        sib.y -= gapToClose;
      }
    }

    // Shrink parent to fit children
    const kids = (pAny.children as SceneNode[]);
    if (kids.length === 0) {
      // Parent is now empty — leave it as is
      console.log(`[delete] Parent "${pf.name}" is now empty`);
    } else {
      let maxBottom = 0;
      for (const kid of kids) {
        const kb = kid.y + kid.height;
        if (kb > maxBottom) maxBottom = kb;
      }
      const padB = pAny.paddingBottom || 0;
      const neededH = maxBottom + padB;
      if (neededH < pf.height - 0.5) {
        console.log(`[delete] Shrinking parent "${pf.name}" ${Math.round(pf.height)} → ${Math.round(neededH)}`);
        if (pAny.minHeight !== undefined) pAny.minHeight = null;
        pf.resize(pf.width, neededH);
      }
    }
  } else {
    // Auto-layout parent — just remove and Figma handles repositioning
    console.log(`[delete] Removing "${target.name}" from auto-layout parent "${pf.name}"`);
    target.remove();
    return; // auto-layout handles shrinking automatically
  }

  // Walk up ancestors: shift siblings above cur's old bottom upward, shrink frames
  let cur: SceneNode = pf;
  let shrinkDelta = parentOldH - pf.height; // how much the direct parent shrank
  console.log(`[delete] Parent shrank by ${Math.round(shrinkDelta)}px (${Math.round(parentOldH)} → ${Math.round(pf.height)})`);

  for (let d = 0; d < 15; d++) {
    if (shrinkDelta < 0.5) break;

    const p = cur.parent;
    if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
    if (!("children" in p) || !("resize" in p)) {
      cur = p as SceneNode;
      continue;
    }

    const ancFrame = p as FrameNode;
    const ancAny = p as any;
    const ancLayout = "layoutMode" in p ? ancAny.layoutMode : "NONE";

    if (ancLayout === "NONE") {
      // cur shrank — shift all siblings below cur upward
      const sibs = (ancAny.children as SceneNode[]);
      const curBottom = cur.y + cur.height; // current (already-shrunken) bottom
      for (const sib of sibs) {
        if (sib.id === cur.id) continue;
        // Siblings whose y is at or below where cur's OLD bottom was
        if (sib.y >= curBottom + shrinkDelta - 0.5) {
          console.log(`[delete] Shifting "${sib.name}" y: ${Math.round(sib.y)} → ${Math.round(sib.y - shrinkDelta)} (at "${ancFrame.name}")`);
          sib.y -= shrinkDelta;
        }
      }
    }

    // Shrink ancestor to fit children
    const kids = (ancAny.children as SceneNode[]);
    let maxBottom = 0;
    for (const kid of kids) {
      const kb = kid.y + kid.height;
      if (kb > maxBottom) maxBottom = kb;
    }
    const ancPadB = ancAny.paddingBottom || 0;
    const neededH = maxBottom + ancPadB;
    const oldAncH = ancFrame.height;
    if (neededH < ancFrame.height - 0.5) {
      console.log(`[delete] Shrinking ancestor "${ancFrame.name}" ${Math.round(ancFrame.height)} → ${Math.round(neededH)}`);
      if (ancAny.minHeight !== undefined) ancAny.minHeight = null;
      ancFrame.resize(ancFrame.width, neededH);
    }

    shrinkDelta = oldAncH - ancFrame.height;
    cur = p as SceneNode;
  }
}

// ── SET_FILL_COLOR ──────────────────────────────────────────────────

function applySetFillColor(op: Extract<Operation, { type: "SET_FILL_COLOR" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if (!("fills" in node)) {
    throw new Error(`Node ${op.nodeId} (${node.type}) does not support fills`);
  }

  // Parse hex color
  const hex = op.color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  const fill: SolidPaint = {
    type: "SOLID",
    color: { r, g, b },
    opacity: 1,
  };

  (node as GeometryMixin).fills = [fill];
  console.log(`[setFillColor] Set "${(node as SceneNode).name}" fill to ${op.color}`);
}

// ── SET_LAYOUT_MODE ─────────────────────────────────────────────────

function applySetLayoutMode(op: Extract<Operation, { type: "SET_LAYOUT_MODE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if (!("layoutMode" in node)) {
    throw new Error(`Node ${op.nodeId} (${node.type}) does not support auto-layout`);
  }

  const frame = node as FrameNode;
  frame.layoutMode = op.layoutMode;

  if (op.wrap !== undefined && "layoutWrap" in frame) {
    (frame as any).layoutWrap = op.wrap ? "WRAP" : "NO_WRAP";
  }

  console.log(`[setLayoutMode] Set "${frame.name}" layoutMode to ${op.layoutMode}${op.wrap ? " (wrap)" : ""}`);
}

// ── SET_LAYOUT_PROPS ────────────────────────────────────────────────

function applySetLayoutProps(op: Extract<Operation, { type: "SET_LAYOUT_PROPS" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if (!("layoutMode" in node)) {
    throw new Error(`Node ${op.nodeId} (${node.type}) does not support auto-layout`);
  }

  const frame = node as FrameNode;

  if (op.paddingTop !== undefined) frame.paddingTop = op.paddingTop;
  if (op.paddingRight !== undefined) frame.paddingRight = op.paddingRight;
  if (op.paddingBottom !== undefined) frame.paddingBottom = op.paddingBottom;
  if (op.paddingLeft !== undefined) frame.paddingLeft = op.paddingLeft;
  if (op.itemSpacing !== undefined) frame.itemSpacing = op.itemSpacing;
  if (op.counterAxisSpacing !== undefined && "counterAxisSpacing" in frame) {
    (frame as any).counterAxisSpacing = op.counterAxisSpacing;
  }

  const changes: string[] = [];
  if (op.paddingTop !== undefined || op.paddingRight !== undefined ||
      op.paddingBottom !== undefined || op.paddingLeft !== undefined) {
    changes.push(`padding: ${op.paddingTop ?? frame.paddingTop}/${op.paddingRight ?? frame.paddingRight}/${op.paddingBottom ?? frame.paddingBottom}/${op.paddingLeft ?? frame.paddingLeft}`);
  }
  if (op.itemSpacing !== undefined) changes.push(`itemSpacing: ${op.itemSpacing}`);
  if (op.counterAxisSpacing !== undefined) changes.push(`counterAxisSpacing: ${op.counterAxisSpacing}`);

  console.log(`[setLayoutProps] Set "${frame.name}" ${changes.join(", ")}`);
}

// ── SET_SIZE_MODE ───────────────────────────────────────────────────

function applySetSizeMode(op: Extract<Operation, { type: "SET_SIZE_MODE" }>) {
  const node = figma.getNodeById(op.nodeId);
  if (!node) {
    throw new Error(`Node ${op.nodeId} not found`);
  }
  if (!("layoutSizingHorizontal" in node)) {
    throw new Error(`Node ${op.nodeId} (${node.type}) does not support layout sizing`);
  }

  const frame = node as FrameNode;

  // Validate parent has auto-layout before setting FILL or HUG
  const parent = node.parent;
  const parentAny = parent as any;
  const parentHasAutoLayout = parent && "layoutMode" in parent &&
    (parentAny.layoutMode === "VERTICAL" || parentAny.layoutMode === "HORIZONTAL");

  if (op.horizontal !== undefined) {
    if ((op.horizontal === "FILL" || op.horizontal === "HUG") && !parentHasAutoLayout) {
      console.log(`[setSizeMode] Skipping H=${op.horizontal} on "${frame.name}" — parent has no auto-layout`);
    } else {
      (frame as any).layoutSizingHorizontal = op.horizontal;
    }
  }
  if (op.vertical !== undefined) {
    if ((op.vertical === "FILL" || op.vertical === "HUG") && !parentHasAutoLayout) {
      console.log(`[setSizeMode] Skipping V=${op.vertical} on "${frame.name}" — parent has no auto-layout`);
    } else {
      (frame as any).layoutSizingVertical = op.vertical;
    }
  }

  console.log(`[setSizeMode] Set "${frame.name}" sizing: H=${op.horizontal ?? "unchanged"}, V=${op.vertical ?? "unchanged"}`);
}

// ── CONTRAST SAFETY NET ─────────────────────────────────────────────

/** Convert a hex colour string (#RRGGBB) to {r,g,b} in 0-1 range. */
function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16) / 255,
    g: parseInt(h.substring(2, 4), 16) / 255,
    b: parseInt(h.substring(4, 6), 16) / 255,
  };
}

/** Format {r,g,b} (0-1) to uppercase #RRGGBB. */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/** WCAG relative luminance from 0-1 RGB. */
function relativeLuminance(r: number, g: number, b: number): number {
  const srgb = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

/** WCAG contrast ratio between two hex colours. Returns value >= 1. */
function contrastRatio(hexA: string, hexB: string): number {
  const a = hexToRgb01(hexA);
  const b = hexToRgb01(hexB);
  const lA = relativeLuminance(a.r, a.g, a.b);
  const lB = relativeLuminance(b.r, b.g, b.b);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Walk up the tree from `node` to find the nearest ancestor with a solid fill. */
function getEffectiveBackground(node: SceneNode): string | null {
  let cur: BaseNode | null = node.parent;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    if ("fills" in cur) {
      try {
        const fills = (cur as GeometryMixin).fills;
        if (Array.isArray(fills)) {
          // Walk fills in reverse — last visible solid fill wins (Figma layer order)
          for (let i = fills.length - 1; i >= 0; i--) {
            const f = fills[i] as SolidPaint;
            if (f.type === "SOLID" && (f.visible === undefined || f.visible)) {
              return rgbToHex(f.color.r, f.color.g, f.color.b);
            }
          }
        }
      } catch (_e) { /* skip */ }
    }
    cur = cur.parent;
  }
  return null; // no background found — assume white
}

/** Get the current solid fill hex of a node, or null. */
function getNodeFillHex(node: SceneNode): string | null {
  if (!("fills" in node)) return null;
  try {
    const fills = (node as GeometryMixin).fills;
    if (!Array.isArray(fills)) return null;
    for (let i = fills.length - 1; i >= 0; i--) {
      const f = fills[i] as SolidPaint;
      if (f.type === "SOLID" && (f.visible === undefined || f.visible)) {
        return rgbToHex(f.color.r, f.color.g, f.color.b);
      }
    }
  } catch (_e) { /* skip */ }
  return null;
}

/**
 * Determine whether a hex colour is "dark" (luminance < 0.4).
 * Used to pick the right contrasting colour.
 */
function isDark(hex: string): boolean {
  const { r, g, b } = hexToRgb01(hex);
  return relativeLuminance(r, g, b) < 0.4;
}

/**
 * Recursively scan all TEXT and icon/vector nodes inside `root` and fix any
 * that have a contrast ratio < 4.5:1 against their effective background.
 * Returns the number of fixes applied.
 */
function fixContrastRecursive(root: SceneNode): number {
  let fixes = 0;
  const MINIMUM_CONTRAST = 4.5; // WCAG AA for normal text

  // Node types that are "leaf visuals" needing contrast against their background.
  // These are typically icons, decorative shapes, etc.
  const ICON_TYPES = new Set([
    "VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "POLYGON",
  ]);

  /** Get the current solid stroke hex of a node, or null. */
  function getNodeStrokeHex(node: SceneNode): string | null {
    if (!("strokes" in node)) return null;
    try {
      const strokes = (node as GeometryMixin).strokes;
      if (!Array.isArray(strokes)) return null;
      for (let i = strokes.length - 1; i >= 0; i--) {
        const s = strokes[i] as SolidPaint;
        if (s.type === "SOLID" && (s.visible === undefined || s.visible)) {
          return rgbToHex(s.color.r, s.color.g, s.color.b);
        }
      }
    } catch (_e) { /* skip */ }
    return null;
  }

  function fixNodeContrast(node: SceneNode, label: string) {
    const bgHex = getEffectiveBackground(node) || "#FFFFFF";

    // Fix fills
    const fillHex = getNodeFillHex(node);
    if (fillHex) {
      const ratio = contrastRatio(fillHex, bgHex);
      if (ratio < MINIMUM_CONTRAST) {
        const newColor = isDark(bgHex) ? "#FFFFFF" : "#1A1A1A";
        const newRatio = contrastRatio(newColor, bgHex);
        if (newRatio > ratio) {
          const { r, g, b } = hexToRgb01(newColor);
          (node as GeometryMixin).fills = [{ type: "SOLID", color: { r, g, b }, opacity: 1 }];
          console.log(
            `[contrastFix] Fixed ${label} fill "${node.name}": ` +
            `${fillHex} on ${bgHex} (ratio ${ratio.toFixed(1)}) → ${newColor} (ratio ${newRatio.toFixed(1)})`
          );
          fixes++;
        }
      }
    }

    // Fix strokes (common for icon outlines)
    const strokeHex = getNodeStrokeHex(node);
    if (strokeHex) {
      const ratio = contrastRatio(strokeHex, bgHex);
      if (ratio < MINIMUM_CONTRAST) {
        const newColor = isDark(bgHex) ? "#FFFFFF" : "#1A1A1A";
        const newRatio = contrastRatio(newColor, bgHex);
        if (newRatio > ratio) {
          const { r, g, b } = hexToRgb01(newColor);
          (node as GeometryMixin).strokes = [{ type: "SOLID", color: { r, g, b }, opacity: 1 }];
          console.log(
            `[contrastFix] Fixed ${label} stroke "${node.name}": ` +
            `${strokeHex} on ${bgHex} (ratio ${ratio.toFixed(1)}) → ${newColor} (ratio ${newRatio.toFixed(1)})`
          );
          fixes++;
        }
      }
    }
  }

  function walk(node: SceneNode) {
    if (node.type === "TEXT") {
      fixNodeContrast(node, "text");
    } else if (ICON_TYPES.has(node.type)) {
      fixNodeContrast(node, "icon");
    }

    // Recurse into children
    if ("children" in node) {
      for (const child of (node as FrameNode).children) {
        walk(child);
      }
    }
  }

  walk(root);
  return fixes;
}

// ── DUPLICATE_FRAME ─────────────────────────────────────────────────

/**
 * Detect whether a variant intent is a responsive layout conversion.
 * Returns target type or null for non-layout intents (dark mode, translation, etc.)
 */
function detectResponsiveType(intent: string): "mobile-to-desktop" | "desktop-to-mobile" | null {
  const lower = intent.toLowerCase();
  if (/desktop|wide|full.?screen|large.?screen|laptop|web\s*layout|widescreen/i.test(lower)) {
    return "mobile-to-desktop";
  }
  if (/mobile|phone|narrow|small.?screen|compact|smartphone/i.test(lower)) {
    return "desktop-to-mobile";
  }
  return null;
}

/**
 * After the LLM pass on a responsive variant, walk the tree and fix
 * any children that are wider than their parent (runaway stretching).
 */
function fixRunawaySizing(root: SceneNode, targetWidth: number): number {
  let fixes = 0;

  function walk(node: SceneNode, maxW: number) {
    // Clamp this node if it's wider than allowed
    if (node.width > maxW + 1 && "resize" in node) {
      console.log(`[responsiveFix] Clamping "${node.name}" from ${Math.round(node.width)}px to ${Math.round(maxW)}px`);
      (node as FrameNode).resize(maxW, node.height);
      fixes++;
    }

    // Recurse into children
    if ("children" in node) {
      const children = (node as FrameNode).children;
      // If this frame has auto-layout, children should fit within its content area
      const nodeAny = node as any;
      let childMaxW = node.width;
      if ("layoutMode" in node && (nodeAny.layoutMode === "HORIZONTAL" || nodeAny.layoutMode === "VERTICAL")) {
        const padL = nodeAny.paddingLeft || 0;
        const padR = nodeAny.paddingRight || 0;
        childMaxW = node.width - padL - padR;
      }
      for (const child of children) {
        walk(child, childMaxW);
      }
    }
  }

  walk(root, targetWidth);
  return fixes;
}

/**
 * Programmatic pre-processing for mobile→desktop conversion.
 * Does ALL heavy layout work so the LLM only needs to fine-tune.
 *
 * Steps:
 * 1. clipsContent on all frames
 * 2. Move bottom nav to top
 * 3. Set direct children to FILL
 * 4. Apply desktop padding to all sections
 * 5. Convert card lists to horizontal wrap grids
 * 6. Recursively set FILL on inner containers
 */
/**
 * Layout preferences parsed from the user's prompt.
 * These control programmatic layout decisions during desktop conversion.
 */
interface DesktopLayoutPrefs {
  /** Where to place the search bar: "header" (same row as nav), "below-header" (row 2), or "auto" (fit-based) */
  searchPlacement: "header" | "below-header" | "auto";
}

/**
 * Parse layout preferences from the user's variant intent string.
 * Users can write things like:
 *   "convert to desktop layout with search below header"
 *   "desktop layout, search in header row"
 */
function parseLayoutPrefs(intent: string): DesktopLayoutPrefs {
  const lower = intent.toLowerCase();
  let searchPlacement: DesktopLayoutPrefs["searchPlacement"] = "auto";

  if (/search.*(below|under|second row|row 2|separate row)/i.test(lower)) {
    searchPlacement = "below-header";
  } else if (/search.*(in|same|header row|nav row|top row|inline)/i.test(lower)) {
    searchPlacement = "header";
  }

  console.log(`[prefs] Parsed layout prefs from intent: searchPlacement=${searchPlacement}`);
  return { searchPlacement };
}

async function preProcessDesktopLayout(root: SceneNode, targetWidth: number, prefs?: DesktopLayoutPrefs): Promise<void> {
  if (!("children" in root)) return;

  // ── 0. Find the "effective root" ──────────────────────────
  // The clone may wrap content in several single-child frames
  // (e.g. Clone → pK → Container → actual sections).
  // Drill down through single-child frames to reach the real content root.
  const effectiveRoot = findEffectiveRoot(root as FrameNode);
  console.log(`[preProcess] Root "${root.name}" → effective root "${effectiveRoot.name}" (${effectiveRoot.children.length} children)`);

  // ── 1. Ensure VERTICAL auto-layout on effective root + wrappers ─
  // Many Figma frames start with layoutMode=NONE; we need auto-layout
  // so that FILL sizing works on children.
  let cur: SceneNode = root;
  while (cur && "children" in cur) {
    const f = cur as FrameNode;
    if ("clipsContent" in f) f.clipsContent = true;
    if ("layoutMode" in f) {
      const fAny = f as any;
      if (fAny.layoutMode === "NONE") {
        fAny.layoutMode = "VERTICAL";
        console.log(`[preProcess] Set "${f.name}" layoutMode to VERTICAL (was NONE)`);
      }
    }
    // Also set FILL on wrapper frames (except the actual root which has explicit width)
    if (cur !== root && "layoutSizingHorizontal" in f) {
      const fAny2 = f as any;
      if (fAny2.layoutSizingHorizontal !== "FILL") {
        try {
          fAny2.layoutSizingHorizontal = "FILL";
          console.log(`[preProcess] Set "${f.name}" wrapper horizontal sizing to FILL`);
        } catch (e) {
          console.warn(`[preProcess] Could not set FILL on wrapper "${f.name}": ${(e as Error).message}`);
        }
      }
    }
    if (cur === effectiveRoot) break;
    if (f.children.length === 1) {
      cur = f.children[0];
    } else break;
  }

  // ── 2. Move bottom nav to top ─────────────────────────────
  await moveBottomNavToTop(effectiveRoot);

  // ── 2b. Merge header elements (cart, account, search) into nav bar ─
  const layoutPrefs = prefs || { searchPlacement: "auto" as const };
  await mergeHeaderIntoNav(effectiveRoot, layoutPrefs);

  // ── 3. Set all direct children to FILL horizontally ───────
  const erAny = effectiveRoot as any;
  const erHasAutoLayout = "layoutMode" in effectiveRoot &&
    (erAny.layoutMode === "VERTICAL" || erAny.layoutMode === "HORIZONTAL");

  for (const child of effectiveRoot.children) {
    if (erHasAutoLayout && "layoutSizingHorizontal" in child) {
      const childAny = child as any;
      if (childAny.layoutSizingHorizontal !== "FILL") {
        try {
          console.log(`[preProcess] Setting "${child.name}" horizontal sizing to FILL (was ${childAny.layoutSizingHorizontal})`);
          childAny.layoutSizingHorizontal = "FILL";
        } catch (e) {
          console.warn(`[preProcess] Could not set FILL on "${child.name}": ${(e as Error).message}`);
        }
      }
    }
    if ("clipsContent" in child) {
      (child as FrameNode).clipsContent = true;
    }
  }

  // ── 4. Apply desktop padding to all sections ──────────────
  applyDesktopPadding(effectiveRoot);

  // ── 5. Convert vertical card lists to horizontal wrap grids ─
  convertCardListsToGrid(effectiveRoot, targetWidth);

  // ── 5b. Transform hero/banner sections for desktop ─────────
  await transformHeroSections(effectiveRoot, targetWidth);

  // ── 6. Recursively set FILL on inner containers ───────────
  recursivelySetFill(effectiveRoot, 0);
}

/**
 * Drill down through single-child wrapper frames to find the frame
 * that actually contains the multi-section content.
 */
function findEffectiveRoot(frame: FrameNode): FrameNode {
  let current = frame;
  // Keep drilling while there's exactly one child that is itself a frame
  while (current.children.length === 1) {
    const only = current.children[0];
    if (!("children" in only) || only.type === "TEXT") break;
    // Only drill into FRAME / GROUP / COMPONENT / COMPONENT_SET
    if (only.type !== "FRAME" && only.type !== "GROUP" &&
        only.type !== "COMPONENT" && only.type !== "COMPONENT_SET") break;
    console.log(`[preProcess] Drilling: "${current.name}" → "${only.name}" (${(only as FrameNode).children.length} children)`);
    current = only as FrameNode;
  }
  return current;
}

/**
 * Detect the bottom navigation bar and move it to position 0 (top).
 * Uses a scoring system across ALL children to find the most nav-like frame.
 * Then restyled for desktop: icons hidden, text-only horizontal links.
 */
async function moveBottomNavToTop(rootFrame: FrameNode): Promise<void> {
  const children = rootFrame.children;
  if (children.length < 2) return;

  // ── Score every child to find the most nav-like one ────────
  let bestScore = 0;
  let bestIndex = -1;
  let bestNode: SceneNode | null = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!("children" in child)) continue;

    let score = 0;
    const childAny = child as any;
    const childFrame = child as FrameNode;
    const name = child.name.toLowerCase();

    const isHorizontal = "layoutMode" in child && childAny.layoutMode === "HORIZONTAL";
    const isShort = child.height < 120;

    // Name-based (+10) — strong signal
    if (/nav|tab.?bar|bottom.?bar|toolbar/i.test(name)) {
      score += 10;
    }
    // "menu" in name is weaker (could be food menu)
    if (/\bmenu\b/i.test(name) && !/food|drink|coffee|item/i.test(name)) {
      score += 6;
    }

    // Content-based: count nav-word matches in ALL nested text
    let navWordCount = 0;
    try {
      const allText = childFrame.findAll(n => n.type === "TEXT") as TextNode[];
      const navWords = /\b(home|explore|search|orders|favorites|profile|browse|settings|account|discover|cart|shop|menu|feed|inbox|notifications|activity|library|saved)\b/i;
      navWordCount = allText.filter(t => navWords.test(t.characters)).length;
      if (navWordCount >= 4) score += 10;       // almost certainly nav
      else if (navWordCount >= 3) score += 8;
      else if (navWordCount >= 2) score += 5;
    } catch (_e) { /* skip */ }

    // Structure: horizontal, short, 3-7 similar-height direct children
    if (isHorizontal && isShort) {
      score += 3;
      const navKids = childFrame.children;
      if (navKids.length >= 3 && navKids.length <= 7) {
        const heights = navKids.map(k => k.height);
        const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
        const allSimilar = heights.every(h => Math.abs(h - avgH) < avgH * 0.4);
        if (allSimilar) score += 3;
      }
    } else if (isShort) {
      score += 1; // short but not horizontal — weak signal
    }

    // Position bonus: bottom children are more likely to be nav bars
    if (i >= children.length - 2) score += 3;
    else if (i >= children.length - 4) score += 1;

    console.log(`[navDetect] "${child.name}" i=${i} score=${score} (navWords=${navWordCount}, horiz=${isHorizontal}, short=${isShort})`);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      bestNode = child;
    }
  }

  // Minimum score threshold — need reasonable confidence
  if (!bestNode || bestScore < 5) {
    console.log(`[preProcess] No nav detected (best score=${bestScore}) — skipping`);
    return;
  }

  console.log(`[preProcess] ✓ Nav found: "${bestNode.name}" score=${bestScore} at index ${bestIndex}/${children.length - 1}`);

  try {
    // ── Move to top ──────────────────────────────────────────
    rootFrame.insertChild(0, bestNode);
    console.log(`[preProcess] Moved "${bestNode.name}" to index 0`);

    const navFrame = bestNode as FrameNode;
    const navAny = navFrame as any;

    // ── Ensure HORIZONTAL layout ─────────────────────────────
    if ("layoutMode" in bestNode) {
      navAny.layoutMode = "HORIZONTAL";
    }

    // ── Desktop nav dimensions ───────────────────────────────
    // HUG height so nav adjusts to content (icons + text + padding)
    if ("layoutSizingVertical" in bestNode) {
      navAny.layoutSizingVertical = "HUG";
    }
    // Only set FILL if parent has auto-layout
    const parentAny = rootFrame as any;
    const parentHasAL = "layoutMode" in rootFrame &&
      (parentAny.layoutMode === "VERTICAL" || parentAny.layoutMode === "HORIZONTAL");
    if (parentHasAL && "layoutSizingHorizontal" in bestNode) {
      try {
        navAny.layoutSizingHorizontal = "FILL";
      } catch (e) {
        console.warn(`[preProcess] Could not set nav FILL: ${(e as Error).message}`);
      }
    }

    // ── Desktop nav padding & spacing ────────────────────────
    if ("layoutMode" in bestNode) {
      navAny.paddingLeft = 48;
      navAny.paddingRight = 48;
      navAny.paddingTop = 12;
      navAny.paddingBottom = 12;
      navAny.itemSpacing = 12;
    }
    // Enable wrap so search/icons can overflow to a second row if needed
    if ("layoutWrap" in bestNode) {
      navAny.layoutWrap = "WRAP";
      // Set counter-axis spacing for the wrap gap (row 2 spacing)
      if ("counterAxisSpacing" in bestNode) {
        navAny.counterAxisSpacing = 8;
      }
    }

    // Center items vertically, distribute with space-between
    if ("counterAxisAlignItems" in bestNode) {
      navAny.counterAxisAlignItems = "CENTER";
    }
    if ("primaryAxisAlignItems" in bestNode) {
      navAny.primaryAxisAlignItems = "SPACE_BETWEEN";
    }

    // ── Convert each nav item for desktop ────────────────────
    // Mobile nav items are typically VERTICAL stacks (icon on top, text below).
    // Desktop nav: hide icons, keep text, lay out horizontally.
    // The nav may have a wrapper child: nav → wrapper → [HOME, EXPLORE, ...]
    if ("children" in bestNode) {
      // Find the actual nav items — drill through single-child wrapper if present
      let navItems: readonly SceneNode[] = navFrame.children;
      if (navItems.length === 1 && "children" in navItems[0] && navItems[0].type !== "TEXT") {
        const wrapper = navItems[0] as FrameNode;
        const wAny = wrapper as any;
        console.log(`[preProcess] Nav has single wrapper child "${wrapper.name}" (${wrapper.children.length} children) — drilling into it`);
        // Set wrapper to HORIZONTAL with FILL
        if ("layoutMode" in wrapper) {
          wAny.layoutMode = "HORIZONTAL";
          wAny.itemSpacing = 32;
          if ("counterAxisAlignItems" in wrapper) wAny.counterAxisAlignItems = "CENTER";
          if ("primaryAxisAlignItems" in wrapper) wAny.primaryAxisAlignItems = "SPACE_BETWEEN";
        }
        try {
          if ("layoutSizingHorizontal" in wrapper) wAny.layoutSizingHorizontal = "FILL";
        } catch (_e) { /* wrapper FILL failed */ }
        navItems = wrapper.children;
      }

      for (const navChild of navItems) {
        if (!("layoutMode" in navChild) && !("children" in navChild)) continue;

        const itemAny = navChild as any;
        const itemFrame = navChild as FrameNode;

        // Ensure each nav item has auto-layout so HUG works
        if ("layoutMode" in navChild && itemAny.layoutMode === "NONE") {
          itemAny.layoutMode = "HORIZONTAL";
          console.log(`[preProcess] Set nav item "${navChild.name}" to HORIZONTAL (was NONE)`);
        } else if ("layoutMode" in navChild && itemAny.layoutMode === "VERTICAL" && "children" in navChild && itemFrame.children.length >= 2) {
          itemAny.layoutMode = "HORIZONTAL";
          console.log(`[preProcess] Set nav item "${navChild.name}" to HORIZONTAL (was VERTICAL)`);
        }

        // Now safe to set sizing
        try {
          if ("layoutSizingHorizontal" in navChild) {
            itemAny.layoutSizingHorizontal = "HUG";
          }
          if ("layoutSizingVertical" in navChild) {
            itemAny.layoutSizingVertical = "HUG";
          }
        } catch (e) {
          console.warn(`[preProcess] Could not set HUG on "${navChild.name}": ${(e as Error).message}`);
        }

        // Pad and center
        if ("layoutMode" in navChild) {
          itemAny.itemSpacing = 8;
          itemAny.paddingTop = 0;
          itemAny.paddingBottom = 0;
          if ("counterAxisAlignItems" in navChild) {
            itemAny.counterAxisAlignItems = "CENTER";
          }
        }

        // Keep icons visible (desktop nav retains mobile icons).
        // Just bump text font size for desktop readability.
        if ("children" in navChild) {
          for (const item of itemFrame.children) {
            if (item.type === "TEXT") {
              try {
                const textNode = item as TextNode;
                const currentSize = typeof textNode.fontSize === "number" ? textNode.fontSize : 12;
                if (currentSize < 14) {
                  if (textNode.fontName && typeof textNode.fontName === "object" && "family" in textNode.fontName) {
                    await figma.loadFontAsync(textNode.fontName as FontName).catch(() => {});
                    textNode.fontSize = 14;
                  }
                }
              } catch (_e) { /* font loading can fail */ }
            }
          }
        }
      }
    }

    console.log(`[preProcess] Desktop nav styling applied to "${bestNode.name}"`);
  } catch (err) {
    console.warn(`[preProcess] Failed to process nav: ${(err as Error).message}`);
  }
}

/**
 * Merge header utility elements (cart, account, search bar) into the nav bar.
 * Called after moveBottomNavToTop places the nav at index 0.
 *
 * Scans the first few short sections after the nav for:
 * - Search bar (text containing "search") → moved into nav with FILL sizing
 * - Utility icons (cart, account avatar — small frames ≤48px) → appended to nav
 *
 * This creates a unified desktop header:
 *   [HOME] [EXPLORE] [ORDERS] ... [═══Search═══] [Cart] [Account]
 */
async function mergeHeaderIntoNav(rootFrame: FrameNode, prefs?: DesktopLayoutPrefs): Promise<void> {
  if (rootFrame.children.length < 3) return;

  // Nav should be at index 0 after moveBottomNavToTop
  const navSection = rootFrame.children[0] as FrameNode;
  if (!("children" in navSection)) return;

  // Find the nav items container (might be wrapped: nav → wrapper → items)
  let navContainer = navSection;
  if (navContainer.children.length === 1 && "children" in navContainer.children[0] &&
      navContainer.children[0].type !== "TEXT") {
    navContainer = navContainer.children[0] as FrameNode;
  }

  console.log(`[headerMerge] Nav container: "${navContainer.name}" with ${navContainer.children.length} children`);

  // --- Helper: recursively find small non-text frames (icons/avatars) ---
  function findIconNodes(parent: FrameNode, depth: number, maxDepth: number): SceneNode[] {
    const icons: SceneNode[] = [];
    if (depth >= maxDepth) return icons;
    for (const child of parent.children) {
      if (child.type === "TEXT") continue;
      // Small non-text element → likely an icon or avatar
      if (child.width <= 48 && child.height <= 48) {
        icons.push(child);
        continue;
      }
      // Recurse into larger containers
      if ("children" in child) {
        icons.push(...findIconNodes(child as FrameNode, depth + 1, maxDepth));
      }
    }
    return icons;
  }

  // --- Helper: detect companion elements near search (filter, sort, etc.) ---
  function isCompanionSection(section: FrameNode): boolean {
    // Check for filter/sort/settings text
    const allText = section.findAll(n => n.type === "TEXT") as TextNode[];
    const hasCompanionText = allText.some(t =>
      /filter|sort|setting|refine|adjust|tune/i.test(t.characters)
    );
    if (hasCompanionText) return true;

    // Very small section with few children — likely an icon button
    if (section.height <= 60 && section.width <= 80 && section.children.length <= 3) {
      return true;
    }

    // Section that is just a single icon-like child
    if (section.children.length === 1) {
      const only = section.children[0];
      if (only.width <= 48 && only.height <= 48) return true;
    }

    return false;
  }

  // Collect items to move into nav
  const searchSections: FrameNode[] = [];
  const companionSections: FrameNode[] = []; // filter/sort buttons near search
  const iconNodes: SceneNode[] = [];

  // Scan short sections after nav (indices 1–4 max)
  for (let i = 1; i < Math.min(5, rootFrame.children.length); i++) {
    const section = rootFrame.children[i];
    if (!("children" in section)) continue;
    const sFrame = section as FrameNode;

    console.log(`[headerMerge] Scanning section i=${i} "${sFrame.name}" h=${Math.round(sFrame.height)} w=${Math.round(sFrame.width)} children=${sFrame.children.length}`);

    if (sFrame.height > 200) {
      console.log(`[headerMerge] Section too tall (${Math.round(sFrame.height)}px) — stopping scan`);
      break; // Reached content section → stop
    }

    // Check if section contains a search input
    const allText = sFrame.findAll(n => n.type === "TEXT") as TextNode[];
    const isSearch = allText.some(t => /search/i.test(t.characters));

    if (isSearch) {
      searchSections.push(sFrame);
      // Log children of the search section for debugging
      if ("children" in sFrame) {
        console.log(`[headerMerge] → Identified as SEARCH section with children: ${sFrame.children.map(c => `"${c.name}" ${c.type} ${Math.round(c.width)}×${Math.round(c.height)}`).join(", ")}`);
      }

      // Check the NEXT sibling — it may be a companion element (filter icon, sort button)
      const nextIdx = i + 1;
      if (nextIdx < rootFrame.children.length) {
        const nextSection = rootFrame.children[nextIdx];
        if ("children" in nextSection) {
          const nextFrame = nextSection as FrameNode;
          if (nextFrame.height <= 200 && isCompanionSection(nextFrame)) {
            companionSections.push(nextFrame);
            console.log(`[headerMerge] → Found COMPANION section "${nextFrame.name}" (${Math.round(nextFrame.width)}×${Math.round(nextFrame.height)}) next to search — will move together`);
            // Skip this index in the main loop since we've handled it
            i++;
          }
        }
      }
      continue;
    }

    // Check if this section is a standalone companion (filter/sort near search)
    // Only mark as companion if we already found a search section
    if (searchSections.length > 0 && isCompanionSection(sFrame)) {
      companionSections.push(sFrame);
      console.log(`[headerMerge] → Identified as COMPANION section (filter/sort near search)`);
      continue;
    }

    // Find all icon-like nodes within this section (recursively, up to 3 levels)
    const foundIcons = findIconNodes(sFrame, 0, 3);
    if (foundIcons.length > 0) {
      iconNodes.push(...foundIcons);
      console.log(`[headerMerge] → Found ${foundIcons.length} icons: ${foundIcons.map(ic => `"${ic.name}" ${Math.round(ic.width)}×${Math.round(ic.height)}`).join(", ")}`);
    } else {
      console.log(`[headerMerge] → No icons found in this section`);
    }
  }

  if (searchSections.length === 0 && iconNodes.length === 0 && companionSections.length === 0) {
    console.log(`[headerMerge] No header elements found to merge`);
    return;
  }

  // Determine search placement strategy
  const searchPref = prefs?.searchPlacement || "auto";
  console.log(`[headerMerge] Search placement preference: "${searchPref}"`);

  // Move search sections (strategy depends on preference)
  let searchAdded = false;
  for (const searchSection of searchSections) {
    if (searchPref === "below-header") {
      // User explicitly wants search on a separate row — leave it in place
      // but ensure it has FILL sizing and auto-layout
      try {
        const sAny = searchSection as any;
        if (sAny.layoutMode === "NONE") {
          sAny.layoutMode = "HORIZONTAL";
        }
        sAny.layoutSizingHorizontal = "FILL";
        sAny.layoutSizingVertical = "HUG";
        console.log(`[headerMerge] Search stays below header (user preference) — set FILL`);
      } catch (e) {
        console.warn(`[headerMerge] Could not style search: ${(e as Error).message}`);
      }
      continue;
    }

    // "auto" or "header" — move search into nav bar
    // With wrap enabled on nav, it will overflow to row 2 if it doesn't fit
    try {
      const sAny = searchSection as any;
      // MUST set auto-layout BEFORE attempting HUG sizing
      if (sAny.layoutMode === "NONE") {
        sAny.layoutMode = "HORIZONTAL";
        console.log(`[headerMerge] Set search section layoutMode to HORIZONTAL`);
      }
      navContainer.appendChild(searchSection);
      sAny.layoutSizingHorizontal = "FILL";
      sAny.layoutSizingVertical = "HUG";

      // Extract filter/sort companion elements from INSIDE the search section
      // and place them directly in the nav bar so they stay visible.
      // The search section gets FILL which can clip non-search children.
      if ("children" in searchSection) {
        const childrenToExtract: SceneNode[] = [];
        for (const child of searchSection.children) {
          if (child.type === "TEXT") continue;
          // Detect filter/sort-like children:
          // - Small icon buttons (≤48px)
          // - Elements whose name or nested text suggests filter/sort
          const isSmall = child.width <= 56 && child.height <= 56;
          let hasFilterText = false;
          if ("findAll" in child) {
            const texts = (child as FrameNode).findAll(n => n.type === "TEXT") as TextNode[];
            hasFilterText = texts.some(t => /filter|sort|tune|adjust|setting/i.test(t.characters));
          }
          const nameIsFilter = /filter|sort|tune|slider|adjust/i.test(child.name);
          
          if (isSmall || hasFilterText || nameIsFilter) {
            // Check this isn't the main search input (has search text)
            let isSearchInput = false;
            if ("findAll" in child) {
              const texts = (child as FrameNode).findAll(n => n.type === "TEXT") as TextNode[];
              isSearchInput = texts.some(t => /search/i.test(t.characters));
            }
            if (!isSearchInput) {
              childrenToExtract.push(child);
            }
          }
        }

        for (const extractChild of childrenToExtract) {
          try {
            // Move right after the search section in the nav bar
            const searchIdx = [...navContainer.children].indexOf(searchSection);
            navContainer.insertChild(searchIdx + 1, extractChild);
            const ecAny = extractChild as any;
            if ("layoutSizingHorizontal" in extractChild) ecAny.layoutSizingHorizontal = "FIXED";
            if ("layoutSizingVertical" in extractChild) ecAny.layoutSizingVertical = "FIXED";
            console.log(`[headerMerge] Extracted filter element "${extractChild.name}" (${Math.round(extractChild.width)}×${Math.round(extractChild.height)}) from search → nav bar`);
          } catch (e) {
            console.warn(`[headerMerge] Could not extract "${extractChild.name}": ${(e as Error).message}`);
          }
        }
      }

      // Set a min-width on the search so it wraps to row 2 rather than shrinking
      // This prevents truncated placeholder text
      if ("minWidth" in searchSection) {
        sAny.minWidth = 280;
        console.log(`[headerMerge] Set search minWidth=280px`);
      }

      console.log(`[headerMerge] Moved search "${searchSection.name}" into nav (FILL, will wrap if needed)`);
      searchAdded = true;
    } catch (e) {
      console.warn(`[headerMerge] Could not move search: ${(e as Error).message}`);
    }
  }

  // Move icon nodes to nav bar — pin their sizing so they don't stretch
  for (const icon of iconNodes) {
    try {
      navContainer.appendChild(icon);
      // Pin sizing to FIXED so the icon keeps its original dimensions
      const iconAny = icon as any;
      if ("layoutSizingHorizontal" in icon) iconAny.layoutSizingHorizontal = "FIXED";
      if ("layoutSizingVertical" in icon) iconAny.layoutSizingVertical = "FIXED";
      console.log(`[headerMerge] Moved icon "${icon.name}" (${Math.round(icon.width)}×${Math.round(icon.height)}) to nav — pinned FIXED`);
    } catch (e) {
      console.warn(`[headerMerge] Could not move icon "${icon.name}": ${(e as Error).message}`);
    }
  }

  // Move companion sections (filter/sort buttons) into the nav bar
  // These are kept alongside the search for visual pairing
  for (const companion of companionSections) {
    if (searchPref === "below-header") {
      // If search stays below header, leave companion in place too
      try {
        const cAny = companion as any;
        if (cAny.layoutMode === "NONE") {
          cAny.layoutMode = "HORIZONTAL";
        }
        cAny.layoutSizingHorizontal = "HUG";
        cAny.layoutSizingVertical = "HUG";
        console.log(`[headerMerge] Companion "${companion.name}" stays with search below header`);
      } catch (e) {
        console.warn(`[headerMerge] Could not style companion: ${(e as Error).message}`);
      }
      continue;
    }

    // Move companion into nav bar
    try {
      navContainer.appendChild(companion);
      const cAny = companion as any;
      // Pin companion to FIXED/HUG so it doesn't stretch
      if ("layoutSizingHorizontal" in companion) cAny.layoutSizingHorizontal = "HUG";
      if ("layoutSizingVertical" in companion) cAny.layoutSizingVertical = "HUG";
      console.log(`[headerMerge] Moved companion "${companion.name}" (${Math.round(companion.width)}×${Math.round(companion.height)}) into nav`);
    } catch (e) {
      console.warn(`[headerMerge] Could not move companion "${companion.name}": ${(e as Error).message}`);
    }
  }

  // If search was added, switch from SPACE_BETWEEN to MIN alignment
  // so the FILL search bar absorbs remaining space properly
  if (searchAdded) {
    const ncAny = navContainer as any;
    if ("primaryAxisAlignItems" in navContainer) {
      ncAny.primaryAxisAlignItems = "MIN";
      console.log(`[headerMerge] Changed nav alignment to MIN (for FILL search)`);
    }
    if (navContainer !== navSection) {
      const nsAny = navSection as any;
      if ("primaryAxisAlignItems" in navSection) {
        nsAny.primaryAxisAlignItems = "MIN";
      }
    }
  }

  console.log(`[headerMerge] Done. Nav now has ${navContainer.children.length} children`);

  // ── Cleanup: remove/collapse sections left behind after merging ──
  // After moving icons/search/companions into nav, their parent sections
  // may be empty shells that create unwanted vertical gaps.
  const sectionsToRemove: SceneNode[] = [];
  for (let i = 1; i < rootFrame.children.length; i++) {
    const section = rootFrame.children[i];
    if (!("children" in section)) continue;
    const sFrame = section as FrameNode;

    // Only clean up short sections (header-height), not content sections
    if (sFrame.height > 200) continue;

    // Recursively prune empty child frames within this section
    pruneEmptyFrames(sFrame);

    // After pruning, check if the section itself is now empty
    if (sFrame.children.length === 0) {
      sectionsToRemove.push(sFrame);
      console.log(`[headerMerge] Marking fully empty section "${sFrame.name}" for removal`);
      continue;
    }

    // Check if only non-meaningful content remains (e.g. empty wrappers)
    const hasVisibleContent = sFrame.children.some(child => {
      if (child.type === "TEXT") {
        const text = (child as TextNode).characters.trim();
        return text.length > 0;
      }
      if ("children" in child) {
        const cf = child as FrameNode;
        return cf.children.length > 0;
      }
      return child.visible !== false;
    });

    if (!hasVisibleContent) {
      sectionsToRemove.push(sFrame);
      console.log(`[headerMerge] Marking empty section "${sFrame.name}" for removal (${sFrame.children.length} non-meaningful children)`);
      continue;
    }

    // For sections that still have content, compact them:
    // Switch to HUG vertical so they shrink to fit remaining content
    try {
      const sAny = sFrame as any;
      if ("layoutMode" in sFrame && sAny.layoutMode !== "NONE") {
        if ("layoutSizingVertical" in sFrame) {
          sAny.layoutSizingVertical = "HUG";
          console.log(`[headerMerge] Compacted section "${sFrame.name}" — set vertical to HUG`);
        }
      }
    } catch (e) {
      console.warn(`[headerMerge] Could not compact section: ${(e as Error).message}`);
    }
  }

  for (const section of sectionsToRemove) {
    try {
      section.remove();
      console.log(`[headerMerge] Removed empty section "${section.name}"`);
    } catch (e) {
      console.warn(`[headerMerge] Could not remove section: ${(e as Error).message}`);
    }
  }
}

/**
 * Recursively remove empty frames (frames with no children) from a parent.
 * This cleans up wrapper frames left behind after moving their children elsewhere.
 */
function pruneEmptyFrames(parent: FrameNode): void {
  // Work backwards to avoid index shifting issues
  for (let i = parent.children.length - 1; i >= 0; i--) {
    const child = parent.children[i];
    if (!("children" in child)) continue;
    if (child.type === "TEXT") continue;

    const cf = child as FrameNode;
    // Recurse first to prune deeper levels
    pruneEmptyFrames(cf);

    // After pruning children, if this frame is now empty, remove it
    if (cf.children.length === 0) {
      console.log(`[headerMerge] Pruning empty frame "${cf.name}" from "${parent.name}"`);
      try {
        cf.remove();
      } catch (e) {
        // Ignore removal errors
      }
    }
  }
}

/**
 * Apply desktop-proportioned padding to all auto-layout sections.
 * Scales padding from mobile (~16px) to desktop (~40-48px).
 */
function applyDesktopPadding(rootFrame: FrameNode): void {
  for (const child of rootFrame.children) {
    if (!("layoutMode" in child)) continue;
    const childAny = child as any;
    const lm = childAny.layoutMode;
    if (lm !== "VERTICAL" && lm !== "HORIZONTAL") continue;

    // Scale horizontal padding to desktop proportions
    const currentPadLR = Math.max(childAny.paddingLeft || 0, childAny.paddingRight || 0);
    if (currentPadLR < 32) {
      const desktopPad = 40;
      console.log(`[preProcess] Desktop padding on "${child.name}": LR ${currentPadLR}→${desktopPad}px`);
      childAny.paddingLeft = desktopPad;
      childAny.paddingRight = desktopPad;
    }

    // Slightly increase vertical padding
    const currentPadTB = Math.max(childAny.paddingTop || 0, childAny.paddingBottom || 0);
    if (currentPadTB < 20 && currentPadTB > 0) {
      const desktopPadV = Math.round(currentPadTB * 1.5);
      childAny.paddingTop = desktopPadV;
      childAny.paddingBottom = desktopPadV;
    }

    // Increase item spacing for desktop
    const currentSpacing = childAny.itemSpacing || 0;
    if (currentSpacing > 0 && currentSpacing < 16) {
      const desktopSpacing = Math.round(currentSpacing * 1.5);
      console.log(`[preProcess] Desktop spacing on "${child.name}": ${currentSpacing}→${desktopSpacing}px`);
      childAny.itemSpacing = desktopSpacing;
    }

    // Recursively apply to inner sections too
    if ("children" in child) {
      applyDesktopPaddingRecursive(child as FrameNode, 0);
    }
  }
}

function applyDesktopPaddingRecursive(frame: FrameNode, depth: number): void {
  if (depth > 2) return; // Don't go too deep
  for (const child of frame.children) {
    if (!("layoutMode" in child)) continue;
    const childAny = child as any;
    const lm = childAny.layoutMode;
    if (lm !== "VERTICAL" && lm !== "HORIZONTAL") continue;

    // Scale spacing
    const spacing = childAny.itemSpacing || 0;
    if (spacing > 0 && spacing < 16) {
      childAny.itemSpacing = Math.round(spacing * 1.5);
    }

    if ("children" in child) {
      applyDesktopPaddingRecursive(child as FrameNode, depth + 1);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Hero / Banner section detection and desktop transformation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a node has a non-white/non-transparent background fill.
 * Hero/banner sections typically have a colored, gradient, or image background.
 */
function hasColoredBackground(node: SceneNode): boolean {
  if (!("fills" in node)) return false;
  try {
    const fills = (node as GeometryMixin).fills;
    if (!Array.isArray(fills)) return false;
    return fills.some((f: Paint) => {
      if (!f.visible) return false;
      if (f.type === "IMAGE") return true;
      if (f.type === "GRADIENT_LINEAR" || f.type === "GRADIENT_RADIAL" ||
          f.type === "GRADIENT_ANGULAR" || f.type === "GRADIENT_DIAMOND") return true;
      if (f.type === "SOLID") {
        const c = f.color;
        // Not white, not transparent, and not very light gray
        const isWhite = c.r > 0.95 && c.g > 0.95 && c.b > 0.95;
        const isTransparent = (f.opacity !== undefined && f.opacity < 0.1);
        return !isWhite && !isTransparent;
      }
      return false;
    });
  } catch (_e) {
    return false;
  }
}

/**
 * Score a section to determine how "hero-like" it is.
 * Higher score = more likely to be a hero/banner section.
 */
function scoreHeroSection(section: FrameNode): number {
  let score = 0;
  const name = section.name.toLowerCase();

  // ── Name-based signals ──
  if (/hero|banner|promo|special|featured|spotlight|offer|deal|highlight/i.test(name)) {
    score += 10;
  }
  if (/header|carousel|slide/i.test(name)) {
    score += 4;
  }

  // ── Negative name signals ── product lists, navs, footers are NOT heroes
  if (/popular|trending|category|categories|products|items|menu|nav|tab|footer|bottom/i.test(name)) {
    score -= 8;
  }

  // ── Background signal ── colored/image background is strong indicator
  if (hasColoredBackground(section)) {
    score += 8;
  }

  // ── Size signals ── hero sections are typically tall-ish and wide
  if (section.height >= 200 && section.height <= 500) {
    score += 3;
  }
  if (section.width > 300) {
    score += 1;
  }

  // ── Content signals ── look for mix of text + images/shapes
  if (!("children" in section)) return score;
  const allNodes = section.findAll(() => true);
  const textNodes = allNodes.filter(n => n.type === "TEXT") as TextNode[];
  const imageNodes = allNodes.filter(n => {
    if (n.type === "ELLIPSE" || n.type === "RECTANGLE") {
      if ("fills" in n) {
        try {
          const fills = (n as GeometryMixin).fills;
          return Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE");
        } catch (_e) { /* skip */ }
      }
    }
    // Also check for frames that look like image containers
    if (n.type === "FRAME" && "fills" in n) {
      try {
        const fills = (n as GeometryMixin).fills;
        return Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE");
      } catch (_e) { /* skip */ }
    }
    return false;
  });

  // Has both text and images → likely a hero
  if (textNodes.length >= 1 && imageNodes.length >= 1) {
    score += 6;
  }

  // CTA button text (specific hero CTA phrases, not generic nav words)
  const hasCTA = textNodes.some(t =>
    /order now|shop now|buy now|get started|try now|learn more|sign up|discover/i.test(t.characters)
  );
  if (hasCTA) {
    score += 3;
  }

  // ── Negative content signals ── multiple prices → product list, not hero
  const priceNodes = textNodes.filter(t => /\$|€|£|\d+\.\d{2}/.test(t.characters));
  if (priceNodes.length >= 3) {
    score -= 6; // Product list with multiple prices
  } else if (priceNodes.length === 1) {
    score += 2; // Single price is OK for a hero promo
  }

  // "See All" / "View All" text → definitely a list section, not hero
  const hasSeeAll = textNodes.some(t => /see all|view all|show more/i.test(t.characters));
  if (hasSeeAll) {
    score -= 5;
  }

  // Too many direct children → probably a list/grid, not a hero
  if (section.children.length > 8) {
    score -= 5;
  }

  // Many similarly-sized direct children → likely a card grid, not hero
  if (section.children.length >= 3) {
    const childHeights = section.children
      .filter(c => "height" in c)
      .map(c => c.height);
    if (childHeights.length >= 3) {
      const avgH = childHeights.reduce((a, b) => a + b, 0) / childHeights.length;
      const allSimilar = childHeights.every(h => Math.abs(h - avgH) / avgH < 0.2);
      if (allSimilar) {
        score -= 4; // Uniform children = grid, not hero
      }
    }
  }

  // Very short section (< 100px) → too short to be a hero
  if (section.height < 100) {
    score -= 5;
  }

  return score;
}

/**
 * Classify children of a hero section into text-group vs image-group.
 * Returns { textChildren, imageChildren } where each is an array of child nodes.
 */
function classifyHeroChildren(section: FrameNode): {
  textChildren: SceneNode[];
  imageChildren: SceneNode[];
} {
  const textChildren: SceneNode[] = [];
  const imageChildren: SceneNode[] = [];

  // If section has a single container child, drill into it
  let classifyTarget: readonly SceneNode[] = section.children;
  if (section.children.length === 1 && "children" in section.children[0]) {
    const inner = section.children[0] as FrameNode;
    // If the single child also has children, classify those instead
    if (inner.children && inner.children.length > 1) {
      classifyTarget = inner.children;
      console.log(`[hero] Drilling into wrapper "${inner.name}" for classification (${inner.children.length} children)`);
    }
  }

  for (const child of classifyTarget) {
    if (child.type === "TEXT") {
      textChildren.push(child);
      continue;
    }

    // Check if this child is or contains an image
    let isImage = false;
    if ("fills" in child) {
      try {
        const fills = (child as GeometryMixin).fills;
        if (Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE")) {
          isImage = true;
        }
      } catch (_e) { /* skip */ }
    }
    // Check for image fills on child shapes (ELLIPSE, RECTANGLE with image)
    if (!isImage && child.type === "ELLIPSE") {
      isImage = true; // Circular images (like the coffee latte photo)
    }
    if (!isImage && "children" in child) {
      const cf = child as FrameNode;
      const hasImgChild = cf.findOne(n => {
        if (n.type === "ELLIPSE") return true;
        if ("fills" in n) {
          try {
            const fills = (n as GeometryMixin).fills;
            return Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE");
          } catch (_e) { /* skip */ }
        }
        return false;
      });
      if (hasImgChild) isImage = true;
    }

    if (isImage) {
      imageChildren.push(child);
    } else {
      // Check if it's a button (short frame with text like "Order Now")
      let isButton = false;
      if ("children" in child) {
        const cf = child as FrameNode;
        const texts = cf.findAll(n => n.type === "TEXT") as TextNode[];
        if (texts.length <= 2 && child.height <= 60) {
          isButton = texts.some(t =>
            /order|shop|buy|get|try|learn|start|sign|view|explore|discover|check/i.test(t.characters)
          );
        }
      }
      // Buttons and other text-like elements go with the text group
      textChildren.push(child);
    }
  }

  return { textChildren, imageChildren };
}

/**
 * Scale up text nodes within a hero section for desktop viewing.
 * Applies proportional scaling based on the desktop-to-mobile width ratio.
 * Must load fonts before setting fontSize (Figma API requirement).
 */
async function scaleHeroText(section: FrameNode, scaleFactor: number): Promise<void> {
  const textNodes = section.findAll(n => n.type === "TEXT") as TextNode[];

  for (const textNode of textNodes) {
    try {
      const currentSize = textNode.fontSize;
      if (typeof currentSize !== "number") continue; // Skip mixed font sizes

      let newSize: number;
      if (currentSize >= 24) {
        // Large text (titles/headlines) — scale up more aggressively
        newSize = Math.round(currentSize * Math.min(scaleFactor, 2.0));
      } else if (currentSize >= 14) {
        // Medium text (subtitles, prices) — moderate scale
        newSize = Math.round(currentSize * Math.min(scaleFactor, 1.5));
      } else {
        // Small text (labels, captions) — gentle scale
        newSize = Math.round(currentSize * Math.min(scaleFactor, 1.25));
      }

      // Cap font sizes to reasonable desktop maximums
      newSize = Math.min(newSize, 72);

      if (newSize !== currentSize) {
        // Load the font before modifying fontSize (Figma API requirement)
        const fontName = textNode.fontName;
        if (fontName && typeof fontName === "object" && "family" in fontName) {
          await figma.loadFontAsync(fontName as FontName);
        }
        (textNode as any).fontSize = newSize;
        console.log(`[hero] Scaled text "${textNode.characters.substring(0, 20)}" ${currentSize}→${newSize}px`);
      }
    } catch (e) {
      // Skip text nodes with mixed styles or font loading failures
      console.warn(`[hero] Could not scale text "${textNode.name}": ${(e as Error).message}`);
    }
  }
}

/**
 * Transform hero/banner sections for desktop layout.
 * Detects hero-like sections and converts them from vertical mobile layout
 * to horizontal desktop layout with scaled text and side-by-side image.
 */
async function transformHeroSections(rootFrame: FrameNode, targetWidth: number): Promise<void> {
  const HERO_SCORE_THRESHOLD = 16;
  let heroFound = false;

  for (let idx = 0; idx < rootFrame.children.length; idx++) {
    const section = rootFrame.children[idx];
    if (!("children" in section)) continue;
    if (section.type !== "FRAME" && section.type !== "COMPONENT" && section.type !== "INSTANCE") continue;
    const sFrame = section as FrameNode;

    // Skip index 0 — that's always the nav bar after moveBottomNavToTop
    if (idx === 0) {
      console.log(`[hero] Skipping index 0 "${sFrame.name}" (nav bar)`);
      continue;
    }

    // Only transform the FIRST hero section found
    if (heroFound) {
      console.log(`[hero] Skipping "${sFrame.name}" — already transformed a hero`);
      continue;
    }

    const heroScore = scoreHeroSection(sFrame);
    console.log(`[hero] Section "${sFrame.name}" score=${heroScore} (threshold=${HERO_SCORE_THRESHOLD})`);

    if (heroScore < HERO_SCORE_THRESHOLD) continue;

    heroFound = true;
    console.log(`[hero] Transforming hero section "${sFrame.name}" for desktop`);

    const sAny = sFrame as any;

    // ── 1. Scale up text for desktop ──
    const mobileWidth = 390; // typical mobile width
    const scaleFactor = Math.min(targetWidth / mobileWidth, 2.0);
    await scaleHeroText(sFrame, scaleFactor);

    // ── 2. Classify children into text vs image groups ──
    const { textChildren, imageChildren } = classifyHeroChildren(sFrame);
    console.log(`[hero] Children: ${textChildren.length} text-group, ${imageChildren.length} image-group`);

    // ── 3. Set minimum height for desktop prominence ──
    // Cap at 480px to avoid excessively tall hero sections
    const desktopMinHeight = Math.min(480, Math.max(300, Math.round(sFrame.height * 1.2)));
    if ("minHeight" in sFrame) {
      sAny.minHeight = desktopMinHeight;
      console.log(`[hero] Set minHeight=${desktopMinHeight}px`);
    }

    // ── 4. If we have both text and images, convert to horizontal layout ──
    if (textChildren.length > 0 && imageChildren.length > 0) {
      // Only restructure if currently vertical
      const currentLayout = sAny.layoutMode;
      if (currentLayout === "VERTICAL" || currentLayout === "NONE") {
        // Set to HORIZONTAL layout
        sAny.layoutMode = "HORIZONTAL";
        sAny.primaryAxisAlignItems = "SPACE_BETWEEN";
        sAny.counterAxisAlignItems = "CENTER";
        sAny.itemSpacing = 40;
        console.log(`[hero] Switched to HORIZONTAL layout with center alignment`);

        // Wrap text children in a container frame if there are multiple
        if (textChildren.length > 1) {
          const textWrapper = figma.createFrame();
          textWrapper.name = "hero-text-group";
          const twAny = textWrapper as any;
          twAny.layoutMode = "VERTICAL";
          twAny.primaryAxisAlignItems = "CENTER";
          twAny.counterAxisAlignItems = "MIN";
          twAny.itemSpacing = 12;
          twAny.layoutSizingHorizontal = "FILL";
          twAny.layoutSizingVertical = "HUG";
          // Make transparent background (inherit parent)
          textWrapper.fills = [];

          // Move text children into wrapper (in original order)
          // We need to insert the wrapper at the position of the first text child
          let firstTextIdx = 0;
          for (let i = 0; i < sFrame.children.length; i++) {
            if (textChildren.includes(sFrame.children[i])) {
              firstTextIdx = i;
              break;
            }
          }

          sFrame.insertChild(firstTextIdx, textWrapper);
          for (const tc of textChildren) {
            textWrapper.appendChild(tc);
          }
          console.log(`[hero] Wrapped ${textChildren.length} text elements in group`);

          // Set text wrapper to FILL so it takes ~60% of space
          twAny.layoutSizingHorizontal = "FILL";
        } else {
          // Single text child — set to FILL
          const tc = textChildren[0];
          if ("layoutSizingHorizontal" in tc) {
            (tc as any).layoutSizingHorizontal = "FILL";
          }
        }

        // Set image children sizing
        for (const img of imageChildren) {
          const imgAny = img as any;
          if ("layoutSizingHorizontal" in img) {
            imgAny.layoutSizingHorizontal = "FIXED";
          }
          if ("layoutSizingVertical" in img) {
            imgAny.layoutSizingVertical = "FIXED";
          }
          // Scale up the image for desktop
          if ("resize" in img) {
            const imgScale = Math.min(scaleFactor, 1.8);
            const newW = Math.round(img.width * imgScale);
            const newH = Math.round(img.height * imgScale);
            // Cap at 40% of target width to leave room for text
            const maxImgW = Math.round(targetWidth * 0.4);
            const finalW = Math.min(newW, maxImgW);
            const finalH = Math.round(finalW * (img.height / img.width));
            (img as FrameNode).resize(finalW, finalH);
            console.log(`[hero] Scaled image "${img.name}" to ${finalW}×${finalH}px`);
          }
        }

        // Ensure images are on the right side (after text)
        // Move all image children to end
        for (const img of imageChildren) {
          try {
            sFrame.appendChild(img);
          } catch (_e) { /* already at end */ }
        }
      }
    } else {
      // No clear text+image split — just ensure decent vertical sizing
      // and center the content
      if (sAny.layoutMode === "VERTICAL" || sAny.layoutMode === "NONE") {
        if (sAny.layoutMode === "NONE") {
          sAny.layoutMode = "VERTICAL";
        }
        sAny.counterAxisAlignItems = "CENTER";
      }
    }

    // ── 5. Increase padding for desktop ──
    const currentPadLR = Math.max(sAny.paddingLeft || 0, sAny.paddingRight || 0);
    if (currentPadLR < 48) {
      sAny.paddingLeft = 60;
      sAny.paddingRight = 60;
      console.log(`[hero] Desktop padding: LR → 60px`);
    }
    const currentPadTB = Math.max(sAny.paddingTop || 0, sAny.paddingBottom || 0);
    if (currentPadTB < 32) {
      sAny.paddingTop = 40;
      sAny.paddingBottom = 40;
      console.log(`[hero] Desktop padding: TB → 40px`);
    }

    // ── 6. Ensure HUG vertical sizing so it grows with content ──
    try {
      if ("layoutSizingVertical" in sFrame) {
        sAny.layoutSizingVertical = "HUG";
      }
    } catch (_e) { /* ignore */ }

    console.log(`[hero] Finished transforming "${sFrame.name}"`);
  }
}

/**
 * Find vertical lists of similarly-structured children (card grids)
 * and convert them to HORIZONTAL + WRAP layout with appropriate card sizing.
 */
function convertCardListsToGrid(rootFrame: FrameNode, targetWidth: number): void {
  // Look through all direct children of root for sections containing card lists
  for (const section of rootFrame.children) {
    if (!("children" in section)) continue;
    findAndConvertCardLists(section as FrameNode, targetWidth, 0);
  }
}

function findAndConvertCardLists(frame: FrameNode, targetWidth: number, depth: number): void {
  if (depth > 4) return;
  const frameAny = frame as any;
  const lm = frameAny.layoutMode;

  // A card list is a VERTICAL auto-layout frame with 3+ children that are all
  // frames/instances of similar structure and height
  if (lm === "VERTICAL" && "children" in frame && frame.children.length >= 3) {
    const kids = frame.children;
    const frameKids = kids.filter(k => k.type === "FRAME" || k.type === "INSTANCE" || k.type === "COMPONENT");

    if (frameKids.length >= 3) {
      // Check if they're similar height (indicating repeated card components)
      const heights = frameKids.map(k => k.height);
      const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
      const allSimilar = heights.every(h => Math.abs(h - avgH) < avgH * 0.4);

      if (allSimilar) {
        console.log(`[preProcess] Converting card list "${frame.name}" (${frameKids.length} cards) to HORIZONTAL WRAP`);

        // Convert to HORIZONTAL + WRAP
        frameAny.layoutMode = "HORIZONTAL";
        frameAny.layoutWrap = "WRAP";
        frameAny.itemSpacing = 20;
        if ("counterAxisSpacing" in frame) {
          frameAny.counterAxisSpacing = 20;
        }

        // Size cards to fit ~3 per row (accounting for padding and gaps)
        const padL = frameAny.paddingLeft || 0;
        const padR = frameAny.paddingRight || 0;
        const availableWidth = targetWidth - padL - padR;
        const gapCount = 2; // gaps between 3 cards
        const cardWidth = Math.floor((availableWidth - (gapCount * 20)) / 3);

        for (const card of frameKids) {
          if ("resize" in card) {
            const cardAny = card as any;
            // Set to FIXED width so we can control size in wrap layout
            if ("layoutSizingHorizontal" in card) {
              cardAny.layoutSizingHorizontal = "FIXED";
            }
            (card as FrameNode).resize(cardWidth, card.height);
            console.log(`[preProcess] Sized card "${card.name}" to ${cardWidth}px wide`);
          }
        }

        return; // Don't recurse into this frame, we've handled it
      }
    }
  }

  // Recurse into children to find card lists deeper
  if ("children" in frame) {
    for (const child of frame.children) {
      if ("children" in child && ("layoutMode" in child)) {
        findAndConvertCardLists(child as FrameNode, targetWidth, depth + 1);
      }
    }
  }
}

/**
 * Check if a frame is an image wrapper (contains a RECTANGLE with IMAGE fill).
 * These should NOT be stretched with FILL because images overflow.
 */
function isImageWrapper(node: SceneNode): boolean {
  if (!("children" in node)) return false;
  const children = (node as FrameNode).children;
  for (const child of children) {
    if (child.type === "RECTANGLE" && "fills" in child) {
      try {
        const fills = (child as GeometryMixin).fills;
        if (Array.isArray(fills) && fills.some((f: Paint) => f.type === "IMAGE")) {
          return true;
        }
      } catch (_e) { /* skip mixed fills */ }
    }
  }
  return false;
}

/**
 * Walk the tree and set FILL on frame children of auto-layout parents.
 * Depth-limited to 3 levels to avoid stretching individual cards/images.
 * Skips image wrapper frames to prevent image overflow.
 * Sets clipsContent=true on all frames for safety.
 */
const MAX_FILL_DEPTH = 3;
function recursivelySetFill(parent: FrameNode | GroupNode, depth: number): void {
  const parentAny = parent as any;
  const parentHasAutoLayout = "layoutMode" in parent && 
    (parentAny.layoutMode === "VERTICAL" || parentAny.layoutMode === "HORIZONTAL");

  if (!("children" in parent)) return;

  for (const child of parent.children) {
    // Clip all frames to prevent any image/content overflow
    if ("clipsContent" in child) {
      (child as FrameNode).clipsContent = true;
    }

    // Only set FILL within depth limit and on auto-layout children
    if (depth < MAX_FILL_DEPTH && parentHasAutoLayout && "layoutSizingHorizontal" in child) {
      const childAny = child as any;
      const isLeaf = child.type === "TEXT" || child.type === "ELLIPSE" || child.type === "VECTOR" 
        || child.type === "LINE" || child.type === "STAR" || child.type === "POLYGON" 
        || child.type === "RECTANGLE";
      const isImgWrapper = !isLeaf && isImageWrapper(child);
      // Skip small icon-sized frames (≤48px) — they should keep their shape
      const isSmallIcon = !isLeaf && child.width <= 48 && child.height <= 48;
      
      if (!isLeaf && !isImgWrapper && !isSmallIcon && childAny.layoutSizingHorizontal !== "FILL") {
        console.log(`[preProcess] Setting "${child.name}" (${child.type}, depth=${depth}) horizontal sizing to FILL`);
        childAny.layoutSizingHorizontal = "FILL";
      } else if (isImgWrapper) {
        console.log(`[preProcess] Skipping image wrapper "${child.name}" — not setting FILL`);
      }
    }

    // Recurse into children
    if ("children" in child) {
      recursivelySetFill(child as FrameNode, depth + 1);
    }
  }
}

async function applyDuplicateFrame(op: Extract<Operation, { type: "DUPLICATE_FRAME" }>) {
  const sourceNode = figma.getNodeById(op.nodeId);
  if (!sourceNode) {
    throw new Error(`Node ${op.nodeId} not found`);
  }

  const source = sourceNode as SceneNode;

  // Clone the frame
  const clone = source.clone();

  // Place it to the right of the source with a gap
  const CANVAS_GAP = 100;
  clone.x = source.x + source.width + CANVAS_GAP;
  clone.y = source.y;

  // Rename the clone to indicate it's a variant
  if (op.variantIntent) {
    clone.name = `${source.name} — ${op.variantIntent}`;
  } else {
    clone.name = `${source.name} (copy)`;
  }

  console.log(`[duplicateFrame] Cloned "${source.name}" → "${clone.name}" at x=${clone.x}`);

  // If there's a variant intent, run a second LLM pass to transform the clone
  if (op.variantIntent) {
    sendToUI({ type: "status", message: `Applying variant: ${op.variantIntent}…` });

    const responsiveType = detectResponsiveType(op.variantIntent);

    try {
      // ── Responsive pre-processing ───────────────────────────
      // Programmatically resize the root frame BEFORE the LLM pass
      let targetWidth = source.width;
      if (responsiveType === "mobile-to-desktop" && "resize" in clone) {
        targetWidth = 1440;
        const cloneFrame = clone as FrameNode;
        const cloneAny = cloneFrame as any;

        // Force root to FIXED sizing so resize works
        if ("layoutSizingHorizontal" in cloneFrame) {
          cloneAny.layoutSizingHorizontal = "FIXED";
        }
        cloneFrame.resize(targetWidth, cloneFrame.height);
        console.log(`[duplicateFrame] Pre-resized clone to ${targetWidth}px wide`);

        // Pre-process: stretch sections, cap images
        const layoutPrefs = parseLayoutPrefs(op.variantIntent || "");
        await preProcessDesktopLayout(clone, targetWidth, layoutPrefs);

        // Reposition to account for new width
        clone.x = source.x + source.width + CANVAS_GAP;
      } else if (responsiveType === "desktop-to-mobile" && "resize" in clone) {
        targetWidth = 375;
        const cloneFrame = clone as FrameNode;
        const cloneAny = cloneFrame as any;
        if ("layoutSizingHorizontal" in cloneFrame) {
          cloneAny.layoutSizingHorizontal = "FIXED";
        }
        cloneFrame.resize(targetWidth, cloneFrame.height);
        console.log(`[duplicateFrame] Pre-resized clone to ${targetWidth}px wide`);
      }

      // Snapshot the clone (with its new IDs and post-resize dimensions)
      const cloneSnapshot = snapshotNode(clone, 0);
      const cloneSelection: SelectionSnapshot = { nodes: [cloneSnapshot] };
      const designSystem = await extractDesignSystemSnapshot();

      // Build the variant prompt
      let variantPrompt: string;

      if (responsiveType) {
        // ── Responsive-specific prompt ──────────────────────────
        variantPrompt = buildResponsivePrompt(op.variantIntent, responsiveType, targetWidth, source.width);
      } else {
        // ── Non-layout variant prompt (dark mode, translation, etc.)
        variantPrompt = buildColorVariantPrompt(op.variantIntent);
      }

      const payload = {
        intent: variantPrompt,
        selection: cloneSelection,
        designSystem,
        apiKey: _userApiKey,
        provider: _selectedProvider,
        model: _selectedModel,
      };

      const variantBatch = await fetchViaUI("/plan?lenient=true", payload) as OperationBatch;

      if (variantBatch.operations && variantBatch.operations.length > 0) {
        // Filter out DUPLICATE_FRAME ops to prevent runaway duplication loops
        const safeOps = variantBatch.operations.filter(o => o.type !== "DUPLICATE_FRAME");
        console.log(`[duplicateFrame] Applying ${safeOps.length} variant transformations (filtered ${variantBatch.operations.length - safeOps.length} DUPLICATE_FRAME ops)`);
        for (const varOp of safeOps) {
          try {
            await applyOperation(varOp);
          } catch (err: any) {
            console.warn(`[duplicateFrame] Variant op failed: ${err.message}`);
          }
        }
      }

      // ── Responsive post-processing ──────────────────────────
      // Re-enforce root width — RESIZE_NODE propagation may have expanded it
      if (responsiveType && "resize" in clone) {
        const cloneFrame = clone as FrameNode;
        const cloneAny = cloneFrame as any;
        if (cloneFrame.width !== targetWidth) {
          console.log(`[duplicateFrame] Re-clamping root width from ${Math.round(cloneFrame.width)}px back to ${targetWidth}px`);
          cloneAny.layoutSizingHorizontal = "FIXED";
          cloneFrame.resize(targetWidth, cloneFrame.height);
        }
      }
    } catch (err: any) {
      console.warn(`[duplicateFrame] Variant transformation failed: ${err.message}`);
      // The clone is still created even if transformation fails
    }

    // ── Contrast safety net ──────────────────────────────────────
    // After the LLM pass, programmatically fix any remaining low-contrast text
    sendToUI({ type: "status", message: "Checking contrast…" });
    const contrastFixes = fixContrastRecursive(clone);
    if (contrastFixes > 0) {
      console.log(`[duplicateFrame] Auto-fixed ${contrastFixes} low-contrast text node(s)`);
    }
  }
}

// ── Variant Prompt Builders ─────────────────────────────────────────

function buildResponsivePrompt(
  variantIntent: string,
  responsiveType: "mobile-to-desktop" | "desktop-to-mobile",
  targetWidth: number,
  sourceWidth: number,
): string {
  const isToDesktop = responsiveType === "mobile-to-desktop";

  return (
    `Transform this frame to be a "${variantIntent}" variant.\n\n` +

    `IMPORTANT: The root frame has ALREADY been resized to ${targetWidth}px wide (from ${sourceWidth}px). ` +
    `Do NOT use RESIZE_NODE on the root frame.\n\n` +

    `CRITICAL RULES:\n` +
    `1. The ROOT frame MUST remain VERTICAL — NEVER change its layout mode.\n` +
    `2. Do NOT change text content or colors.\n` +
    `3. Only reference node IDs from the snapshot.\n\n` +

    (isToDesktop ? (
      `MOBILE → DESKTOP (${targetWidth}px):\n` +
      `Pre-processing has already done most of the work:\n` +
      `• Sections stretched to full width via FILL\n` +
      `• Bottom nav moved to top\n` +
      `• Card lists converted to horizontal wrap grids\n` +
      `• Desktop padding applied to all sections\n\n` +

      `YOUR REMAINING TASKS (lightweight fine-tuning only):\n` +
      `1. If you see any inner container that should also be HORIZONTAL for desktop, use SET_LAYOUT_MODE.\n` +
      `2. If any text nodes or small elements need FILL sizing to spread across the width, use SET_SIZE_MODE horizontal=FILL (only if parent has auto-layout).\n` +
      `3. Fine-tune any spacing that still looks mobile-sized with SET_LAYOUT_PROPS.\n` +
      `4. Do NOT resize images or the root frame.\n` +
      `5. If the layout already looks good from pre-processing, generate an EMPTY operations array — that's perfectly fine.\n\n`
    ) : (
      `DESKTOP → MOBILE (${targetWidth}px):\n` +
      `• Switch HORIZONTAL sections to VERTICAL so items stack.\n` +
      `• Reduce padding to mobile proportions: paddingLeft/Right 16-20px, paddingTop/Bottom 12-16px.\n` +
      `• Reduce itemSpacing to 8-12px.\n` +
      `• Set cards to FILL width.\n\n`
    )) +

    `AVAILABLE OPERATIONS:\n` +
    `• SET_LAYOUT_MODE — change direction (HORIZONTAL/VERTICAL), enable wrap\n` +
    `• SET_LAYOUT_PROPS — adjust padding and spacing\n` +
    `• SET_SIZE_MODE — FILL/HUG (only when parent has auto-layout)\n\n` +

    `IMPORTANT: Do NOT use RESIZE_NODE — sizing is handled by FILL/HUG via auto-layout.\n` +
    `IMPORTANT: Only reference node IDs from the snapshot. Be minimal — pre-processing has done the heavy lifting.`
  );
}

function buildColorVariantPrompt(variantIntent: string): string {
  return (
    `Transform this frame to be a "${variantIntent}" variant.\n\n` +

    `CRITICAL — CONTRAST & READABILITY RULES (apply to EVERY variant):\n` +
    `1. EVERY text node must have strong contrast against its immediate background.\n` +
    `2. After changing any background, you MUST also change the text on top of it so the pair remains readable.\n` +
    `3. After changing any text color, verify it contrasts with the background behind it.\n` +
    `4. Light text (#FFFFFF, #E0E0E0, #F5F5F5) must ONLY appear on dark backgrounds (#333 or darker). ` +
    `Dark text (#000000, #1A1A1A, #333333) must ONLY appear on light backgrounds (#CCC or lighter).\n` +
    `5. Selected / active / highlighted states (e.g., a selected tab, active category, toggled button) must remain visually distinct from their unselected siblings. ` +
    `If you change the selected item's background, also update its text/icon color AND make sure unselected siblings use a clearly different style.\n` +
    `6. Hero sections, banners, and promotional cards: if the background changes, ALL overlay text (title, subtitle, price, CTA) must be updated to contrast.\n` +
    `7. Icons and small UI elements (badges, "+" buttons, dots) should also be checked — ensure they remain visible.\n\n` +

    `COLOR PALETTE GUIDANCE:\n` +
    `• Dark mode backgrounds: #121212 (surface), #1E1E1E (card), #1A1A2E (hero), #2D2D3F (elevated), #0F0F1A (deepest).\n` +
    `• Dark mode text: #FFFFFF (primary), #E0E0E0 (secondary), #B0B0B0 (tertiary/muted).\n` +
    `• Light mode backgrounds: #FFFFFF (surface), #F5F5F5 (card), #FFF8F0 (warm hero), #F0F0F0 (elevated).\n` +
    `• Light mode text: #000000 or #1A1A1A (primary), #333333 (secondary), #666666 (tertiary/muted).\n` +
    `• Accent / brand colors (buttons, links, highlights) can usually stay the same across modes, ` +
    `but verify their text labels still contrast.\n\n` +

    `TASK: Walk through EVERY node in the snapshot and emit SET_FILL_COLOR for:\n` +
    `  – Every background frame/rectangle that needs to change.\n` +
    `  – Every TEXT node whose color must flip to maintain contrast.\n` +
    `  – Every icon or decorative element that would disappear against the new background.\n` +
    `Do NOT skip nodes. Be thorough — it is better to emit too many color changes than to leave unreadable text.\n\n` +

    `For translations: change all text content to the target language using SET_TEXT.\n` +
    `Use SET_FILL_COLOR to change background colors and text colors.\n` +
    `Use SET_TEXT to change text content.\n` +
    `Use RESIZE_NODE to change sizes.\n` +
    `IMPORTANT: Only reference node IDs from the snapshot provided.\n` +
    `IMPORTANT: To change text color, use SET_FILL_COLOR on the TEXT node with the desired color.`
  );
}

async function applyOperation(op: Operation): Promise<void> {
  switch (op.type) {
    case "INSERT_COMPONENT":
      await applyInsertComponent(op);
      break;
    case "CREATE_FRAME":
      applyCreateFrame(op);
      break;
    case "SET_TEXT":
      await applySetText(op);
      break;
    case "APPLY_TEXT_STYLE":
      await applyTextStyle(op);
      break;
    case "APPLY_FILL_STYLE":
      applyFillStyle(op);
      break;
    case "RENAME_NODE":
      applyRenameNode(op);
      break;
    case "SET_IMAGE":
      await applySetImage(op);
      break;
    case "RESIZE_NODE":
      applyResizeNode(op);
      break;
    case "MOVE_NODE":
      applyMoveNode(op);
      break;
    case "CLONE_NODE":
      applyCloneNode(op);
      break;
    case "DELETE_NODE":
      applyDeleteNode(op);
      break;
    case "SET_FILL_COLOR":
      applySetFillColor(op);
      break;
    case "SET_LAYOUT_MODE":
      applySetLayoutMode(op);
      break;
    case "SET_LAYOUT_PROPS":
      applySetLayoutProps(op);
      break;
    case "SET_SIZE_MODE":
      applySetSizeMode(op);
      break;
    case "DUPLICATE_FRAME":
      await applyDuplicateFrame(op);
      break;
    default:
      throw new Error(`Unknown operation type: ${(op as any).type}`);
  }
}

// ── 5. Pre-apply: capture previous state for revert ─────────────────

/**
 * Capture the restorable state of a single node (dimensions, position,
 * layout sizing, corner radius, fills, text, etc.).
 */
function captureNodeState(node: BaseNode): Record<string, any> {
  const state: Record<string, any> = { name: node.name };

  if (node.type === "TEXT") {
    const tn = node as TextNode;
    state.characters = tn.characters;
    state.textStyleId = typeof tn.textStyleId === "string" ? tn.textStyleId : "";
  }
  if ("fillStyleId" in node) {
    state.fillStyleId = typeof (node as any).fillStyleId === "string"
      ? (node as any).fillStyleId : "";
  }
  if ("fills" in node) {
    try { state.fills = JSON.stringify((node as GeometryMixin).fills); } catch (_e) { /* mixed */ }
  }
  if ("width" in node && "height" in node) {
    state.width = (node as SceneNode).width;
    state.height = (node as SceneNode).height;
    state.x = (node as SceneNode).x;
    state.y = (node as SceneNode).y;
  }
  if ("cornerRadius" in node) {
    state.cornerRadius = (node as any).cornerRadius;
  }
  if ("layoutSizingHorizontal" in node) {
    state.layoutSizingHorizontal = (node as any).layoutSizingHorizontal;
    state.layoutSizingVertical = (node as any).layoutSizingVertical;
  }
  if ("primaryAxisSizingMode" in node) {
    state.primaryAxisSizingMode = (node as any).primaryAxisSizingMode;
    state.counterAxisSizingMode = (node as any).counterAxisSizingMode;
  }
  if ("minHeight" in node) {
    state.minHeight = (node as any).minHeight;
    state.minWidth = (node as any).minWidth;
  }
  return state;
}

/**
 * Recursively capture state of a node and all its descendants
 * (so multi-step resize + refinement can be fully reverted).
 */
function captureDeepState(node: BaseNode, out: Record<string, string>): void {
  if ("id" in node && !out[node.id]) {
    out[node.id] = JSON.stringify(captureNodeState(node));
  }
  if ("children" in node) {
    for (const child of (node as any).children as BaseNode[]) {
      captureDeepState(child, out);
    }
  }
}

/**
 * Walk up from a node and capture each ancestor + its siblings
 * (siblings get shifted during resize propagation).
 */
function captureAncestorChain(node: SceneNode, out: Record<string, string>): void {
  let current: BaseNode = node;
  for (let depth = 0; depth < 10; depth++) {
    const par = (current as SceneNode).parent;
    if (!par || par.type === "PAGE" || par.type === "DOCUMENT") break;
    if (!out[par.id]) out[par.id] = JSON.stringify(captureNodeState(par));
    // Capture all siblings (they may be shifted)
    if ("children" in par) {
      for (const sib of (par as any).children as SceneNode[]) {
        if (!out[sib.id]) out[sib.id] = JSON.stringify(captureNodeState(sib));
      }
    }
    current = par as SceneNode;
  }
}

function captureRevertState(batch: OperationBatch): RevertState {
  const previousStates: Record<string, string> = {};

  for (const op of batch.operations) {
    const nodeId = "nodeId" in op ? (op as any).nodeId as string : undefined;
    if (!nodeId) continue;
    const node = figma.getNodeById(nodeId);
    if (!node) continue;

    // Deep-capture the target node and all descendants (covers refinement targets)
    captureDeepState(node, previousStates);

    // Capture ancestors + their siblings (covers sibling shifts & ancestor growth)
    if ("parent" in node) {
      captureAncestorChain(node as SceneNode, previousStates);
    }
  }

  return { previousStates, batch };
}

// ── 6. Revert ───────────────────────────────────────────────────────

async function revertLast(): Promise<void> {
  if (!lastRevertState) {
    throw new Error("Nothing to revert");
  }

  for (const [nodeId, stateJSON] of Object.entries(
    lastRevertState.previousStates
  )) {
    const node = figma.getNodeById(nodeId);
    if (!node) continue;

    const state = JSON.parse(stateJSON);

    // Restore name
    if (state.name !== undefined) {
      node.name = state.name;
    }

    // Restore text
    if (node.type === "TEXT" && state.characters !== undefined) {
      const textNode = node as TextNode;
      const len = textNode.characters.length || 1;
      const fonts = new Set<string>();
      for (let i = 0; i < len; i++) {
        const font = textNode.getRangeFontName(i, i + 1) as FontName;
        fonts.add(`${font.family}::${font.style}`);
      }
      for (const f of fonts) {
        const [family, style] = f.split("::");
        await figma.loadFontAsync({ family, style });
      }
      textNode.characters = state.characters;
    }

    // Restore text style
    if (node.type === "TEXT" && state.textStyleId !== undefined) {
      (node as any).textStyleId = state.textStyleId;
    }

    // Restore fill style
    if ("fillStyleId" in node && state.fillStyleId !== undefined) {
      (node as any).fillStyleId = state.fillStyleId;
    }

    // Restore fills (for SET_IMAGE revert)
    if ("fills" in node && state.fills !== undefined) {
      try {
        (node as GeometryMixin & SceneNode).fills = JSON.parse(state.fills);
      } catch (_e) {
        // skip if unable to parse
      }
    }

    // Restore dimensions (for RESIZE_NODE revert)
    if ("resize" in node && state.width !== undefined && state.height !== undefined) {
      // Restore layout sizing mode first so resize sticks
      if ("layoutSizingHorizontal" in node && state.layoutSizingHorizontal !== undefined) {
        (node as any).layoutSizingHorizontal = state.layoutSizingHorizontal;
        (node as any).layoutSizingVertical = state.layoutSizingVertical;
      }
      if ("primaryAxisSizingMode" in node && state.primaryAxisSizingMode !== undefined) {
        (node as any).primaryAxisSizingMode = state.primaryAxisSizingMode;
        (node as any).counterAxisSizingMode = state.counterAxisSizingMode;
      }
      (node as SceneNode & { resize(w: number, h: number): void }).resizeWithoutConstraints(state.width, state.height);
      if ("minHeight" in node && state.minHeight !== undefined) {
        (node as any).minHeight = state.minHeight;
        (node as any).minWidth = state.minWidth;
      }
      if (state.x !== undefined) (node as SceneNode).x = state.x;
      if (state.y !== undefined) (node as SceneNode).y = state.y;
    }
    if ("cornerRadius" in node && state.cornerRadius !== undefined) {
      (node as any).cornerRadius = state.cornerRadius;
    }
  }

  // Remove any frames/instances that were created by INSERT_COMPONENT or CREATE_FRAME
  // We track newly created nodes via the batch — but they don't have nodeIds in revert state.
  // For V1, revert only restores property changes. Created nodes remain (safe — no deletion policy).

  lastRevertState = null;
}

// ── 7. Audit Logging ────────────────────────────────────────────────

function writeAuditLog(intent: string, batch: OperationBatch): void {
  // Find or create the log frame
  let logFrame = figma.currentPage.findOne(
    (n) => n.type === "FRAME" && n.name === CHANGE_LOG_FRAME_NAME
  ) as FrameNode | null;

  if (!logFrame) {
    logFrame = figma.createFrame();
    logFrame.name = CHANGE_LOG_FRAME_NAME;
    logFrame.visible = false;
    logFrame.layoutMode = "VERTICAL";
    logFrame.primaryAxisSizingMode = "AUTO";
    logFrame.counterAxisSizingMode = "AUTO";
    logFrame.itemSpacing = 8;
    logFrame.paddingTop = 16;
    logFrame.paddingRight = 16;
    logFrame.paddingBottom = 16;
    logFrame.paddingLeft = 16;
  }

  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    intent,
    operationSummary: batch.operations
      .map((op) => op.type)
      .join(", "),
  };

  // Create a text node with the log entry
  const textNode = figma.createText();
  figma.loadFontAsync({ family: "Inter", style: "Regular" }).then(() => {
    textNode.characters = JSON.stringify(entry, null, 2);
    textNode.fontSize = 10;
    logFrame!.appendChild(textNode);
  });
}

// ── 8. Save / Load revert state via clientStorage ───────────────────

async function saveRevertState(state: RevertState): Promise<void> {
  await figma.clientStorage.setAsync("lastRevertState", JSON.stringify(state));
}

async function loadRevertState(): Promise<RevertState | null> {
  const raw = await figma.clientStorage.getAsync("lastRevertState");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RevertState;
  } catch (_e) {
    return null;
  }
}

// ── 9. Full apply flow ──────────────────────────────────────────────

async function applyBatch(
  batch: OperationBatch,
  intent: string
): Promise<string> {
  // Capture revert state
  const revertState = captureRevertState(batch);
  lastRevertState = revertState;
  await saveRevertState(revertState);

  const results: string[] = [];

  const friendlyName: Record<string, string> = {
    INSERT_COMPONENT: "Insert component",
    CREATE_FRAME: "Create frame",
    SET_TEXT: "Set text",
    APPLY_TEXT_STYLE: "Apply text style",
    APPLY_FILL_STYLE: "Apply fill style",
    RENAME_NODE: "Rename",
    SET_IMAGE: "Set image",
    RESIZE_NODE: "Resize",
    MOVE_NODE: "Move",
    CLONE_NODE: "Duplicate",
    DELETE_NODE: "Delete",
    SET_FILL_COLOR: "Set color",
    SET_LAYOUT_MODE: "Set layout mode",
    SET_LAYOUT_PROPS: "Set layout props",
    SET_SIZE_MODE: "Set size mode",
    DUPLICATE_FRAME: "Duplicate frame",
  };

  for (const op of batch.operations) {
    const label = friendlyName[op.type] || op.type;
    try {
      await applyOperation(op);
      results.push(`\u2713 ${label}`);
    } catch (err: any) {
      results.push(`\u2717 ${label}: ${err.message}`);
    }
  }

  // Write audit log
  writeAuditLog(intent, batch);

  return results.join("\n");
}

// ── 10. Post-resize AI refinement ───────────────────────────────────

/**
 * Walk all descendants of a resized section. If any ELLIPSE or
 * originally-square node ended up with width ≠ height, fix it to
 * the larger dimension so circles stay circles.
 */
function enforceCircles(root: SceneNode): void {
  function walk(node: SceneNode): void {
    const isCircular = node.type === "ELLIPSE" || (
      "width" in node && "height" in node &&
      Math.abs(node.width - node.height) > 0 &&
      Math.abs(node.width - node.height) <= 15 &&
      node.width > 20 // skip tiny decorative elements
    );

    if (isCircular && "resize" in node) {
      const maxDim = Math.max(node.width, node.height);
      if (node.width !== node.height) {
        console.log(`[resize] Circle fix: "${node.name}" ${Math.round(node.width)}x${Math.round(node.height)} → ${Math.round(maxDim)}x${Math.round(maxDim)}`);
        (node as FrameNode).resize(maxDim, maxDim);
        // Fix corner radius to make it fully rounded
        if ("cornerRadius" in node) {
          (node as any).cornerRadius = Math.round(maxDim / 2);
        }
      }
    }

    // For ELLIPSE nodes that are already equal or way off — just ensure they're square
    if (node.type === "ELLIPSE" && "resize" in node && node.width !== node.height) {
      const maxDim = Math.max(node.width, node.height);
      console.log(`[resize] Ellipse fix: "${node.name}" → ${Math.round(maxDim)}x${Math.round(maxDim)}`);
      (node as FrameNode).resize(maxDim, maxDim);
    }

    if ("children" in node) {
      for (const child of (node as any).children as SceneNode[]) {
        walk(child);
      }
    }
  }
  if ("children" in root) {
    for (const child of (root as any).children as SceneNode[]) {
      walk(child);
    }
  }
}

/**
 * Walk the subtree rooted at `node` and record the IDs of all nodes
 * that are currently circular (ELLIPSE or roughly square with size > 20px).
 * Called BEFORE any resize so we have a reliable set.
 */
function recordCircularNodes(node: SceneNode, out: Set<string>): void {
  const isCircular =
    node.type === "ELLIPSE" ||
    ("width" in node &&
      "height" in node &&
      Math.abs(node.width - node.height) <= 5 &&
      node.width > 20);
  if (isCircular) {
    out.add(node.id);
  }
  if ("children" in node) {
    for (const child of (node as any).children as SceneNode[]) {
      recordCircularNodes(child, out);
    }
  }
}

/**
 * For every node whose ID is in `circularIds`, force it back to a square
 * (using the larger dimension) and set corner radius to half that.
 */
function enforceCirclesFromSet(circularIds: Set<string>): void {
  for (const id of circularIds) {
    const node = figma.getNodeById(id) as SceneNode | null;
    if (!node || !("resize" in node)) continue;
    const w = (node as any).width as number;
    const h = (node as any).height as number;
    if (w === h) continue; // already square
    const maxDim = Math.max(w, h);
    console.log(
      `[resize] Circle enforce: "${node.name}" ${Math.round(w)}x${Math.round(h)} → ${Math.round(maxDim)}x${Math.round(maxDim)}`
    );
    (node as FrameNode).resize(maxDim, maxDim);
    if ("cornerRadius" in node) {
      (node as any).cornerRadius = Math.round(maxDim / 2);
    }
  }
}

function buildRefinementIntent(
  sectionName: string,
  snapshot: NodeSnapshot,
  oldW: number,
  oldH: number,
  siblingContext: string
): string {
  const newW = snapshot.width ?? oldW;
  const newH = snapshot.height ?? oldH;
  const extraW = newW - oldW;
  const extraH = newH - oldH;
  return (
    `The section "${sectionName}" (id: ${snapshot.id}) was just resized from ` +
    `${oldW}x${oldH} → ${newW}x${newH} (+${extraW}px wide, +${extraH}px tall).\n` +
    `ALL descendants have been proportionally scaled as a baseline.\n\n` +

    `YOUR TASK: Fine-tune the layout so it looks polished at the new size.\n` +
    `The mechanical scaling is done — focus on design quality:\n\n` +

    `DESIGN GUIDELINES:\n` +
    `1. IMAGES: If circular (width ≈ height or ELLIPSE), ALWAYS set width === height.\n` +
    `2. SPACING: Fine-tune positions so elements are balanced within their parents.\n` +
    `3. TEXT NODES: Do NOT resize, but DO reposition with MOVE_NODE if needed.\n` +
    `4. BUTTONS: Keep buttons similar size, reposition as needed.\n` +
    `5. If everything looks good after scaling, return an EMPTY operations array.\n\n` +

    `RULES:\n` +
    `- ONLY target node IDs from the snapshot — do NOT invent IDs\n` +
    `- Do NOT resize the root section itself (id: ${snapshot.id}) — already done\n` +
    `- ELLIPSE nodes: ALWAYS set width === height\n` +
    `- Nodes where current width ≈ height (±5px) and size > 20px: keep width === height (circles)\n` +
    `- TEXT nodes: do NOT resize, only MOVE_NODE if needed\n` +
    `- Use MOVE_NODE only for nodes whose parent has layoutMode=NONE\n` +
    `- MOVE_NODE must always include BOTH x and y fields\n` +
    `- For auto-layout children (parent layoutMode=VERTICAL|HORIZONTAL), only use RESIZE_NODE\n` +
    `- Keep all repositioned content within bounds (0,0 to ${newW},${newH})\n` +
    `- Output a batch of RESIZE_NODE and MOVE_NODE operations (or empty if no changes needed)`
  );
}

// ── 11. Message Handler ─────────────────────────────────────────────

// ── Selection change → update UI status ─────────────────────────────
function describeSelection(): string {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) return "Nothing selected — will generate new frame";
  if (sel.length === 1) return `Selected: ${sel[0].name}`;
  return `Selected: ${sel.length} layers`;
}

figma.on("selectionchange", () => {
  sendToUI({ type: "selection-change", label: describeSelection() } as any);
});

// Send initial selection status on load
setTimeout(() => {
  sendToUI({ type: "selection-change", label: describeSelection() } as any);
}, 100);

// ── Pre-cache: DISABLED ─────────────────────────────────────────────
// Previously walked the entire node tree at startup to pre-warm caches.
// This blocked Figma's UI thread for large files. Caches now populate
// lazily on the first generate/edit job instead.
// Signal UI that startup is ready immediately.
setTimeout(() => {
  sendToUI({ type: "startup-ready" } as any);
}, 50);

// ── Load saved phase timings from clientStorage ─────────────────────
// Sends persisted timing estimates to UI so the progress bar can use
// actual historical durations for more accurate fill predictions.
setTimeout(async () => {
  try {
    const raw = await figma.clientStorage.getAsync("phaseTimings");
    if (raw) {
      const timings = JSON.parse(raw);
      sendToUI({ type: "load-timings", timings } as any);
      console.log("[startup] Loaded saved phase timings:", timings);
    }
  } catch (e) {
    console.warn("[startup] Failed to load phase timings:", e);
  }
  try {
    const rawAudit = await figma.clientStorage.getAsync("auditTimings");
    if (rawAudit) {
      const auditTimings = JSON.parse(rawAudit);
      sendToUI({ type: "load-audit-timings", timings: auditTimings } as any);
      console.log("[startup] Loaded saved audit timings:", auditTimings);
    }
  } catch (e) {
    console.warn("[startup] Failed to load audit timings:", e);
  }
  try {
    const rawStateAudit = await figma.clientStorage.getAsync("stateAuditTimings");
    if (rawStateAudit) {
      const stateAuditTimings = JSON.parse(rawStateAudit);
      sendToUI({ type: "load-state-audit-timings", timings: stateAuditTimings } as any);
      console.log("[startup] Loaded saved state audit timings:", stateAuditTimings);
    }
  } catch (e) {
    console.warn("[startup] Failed to load state audit timings:", e);
  }
}, 150);

// ── Load saved API keys and provider/model selection ────────────────
setTimeout(async () => {
  try {
    // Load provider selection
    const savedProvider = await figma.clientStorage.getAsync("selectedProvider");
    const savedModel = await figma.clientStorage.getAsync("selectedModel");
    if (savedProvider) _selectedProvider = savedProvider;
    if (savedModel) _selectedModel = savedModel;

    // Load all per-provider keys
    const allKeys: Record<string, string> = {};
    for (const p of ["anthropic", "openai", "gemini"]) {
      const k = await figma.clientStorage.getAsync(`apiKey_${p}`);
      if (k) allKeys[p] = k;
    }

    // Set active key
    _userApiKey = allKeys[_selectedProvider] || "";

    // Send everything to UI
    sendToUI({
      type: "load-api-key",
      key: _userApiKey,
      provider: _selectedProvider,
      model: _selectedModel,
      allKeys,
    } as any);
    console.log(`[startup] Loaded provider=${_selectedProvider}, model=${_selectedModel}, key=${_userApiKey ? "set" : "empty"}`);
  } catch (e) {
    console.warn("[startup] Failed to load API key/provider:", e);
  }
}, 120);

// ── Parallel Generate Job Runner ────────────────────────────────────
// Runs a single generate job. Multiple can run concurrently. Each has
// its own cancellation state and fetch tracking.

async function runEditJob(job: GenerateJobState, intent: string, selectionSnapshot: SelectionSnapshot): Promise<void> {
  try {
    sendToUI({ type: "job-progress", jobId: job.id, phase: "analyze" } as any);

    console.log(`[edit-job ${job.id}] Extracting design system...`);
    const designSystem = await extractDesignSystemSnapshot();
    await yieldToUI();
    if (job.cancelled) { sendToUI({ type: "job-cancelled", jobId: job.id } as any); return; }

    sendToUI({ type: "job-progress", jobId: job.id, phase: "generate" } as any);

    const payload: BackendPayload = {
      intent,
      selection: selectionSnapshot,
      designSystem,
    };

    console.log(`[edit-job ${job.id}] Calling backend /plan...`);
    let batch: OperationBatch;
    try {
      batch = await fetchViaUIForJob("/plan", { ...payload, apiKey: _userApiKey, provider: _selectedProvider, model: _selectedModel }, job.id);
    } catch (err: any) {
      if (job.cancelled) {
        console.log(`[edit-job ${job.id}] Cancelled during fetch.`);
        sendToUI({ type: "job-cancelled", jobId: job.id } as any);
        return;
      }
      sendToUI({ type: "job-error", jobId: job.id, error: `Backend error: ${err.message}` } as any);
      return;
    }

    if (!batch.operations || batch.operations.length === 0) {
      sendToUI({ type: "job-error", jobId: job.id, error: "Could not determine what to change. Try being more specific." } as any);
      return;
    }

    if (job.cancelled) { sendToUI({ type: "job-cancelled", jobId: job.id } as any); return; }

    sendToUI({ type: "job-progress", jobId: job.id, phase: "create" } as any);

    // ── Capture pre-resize dimensions, circular nodes, and sibling positions ──
    const resizeOps = batch.operations.filter(
      (op) => op.type === "RESIZE_NODE"
    );
    const preResizeDims: Record<string, { w: number; h: number }> = {};
    const preResizeCircles: Record<string, Set<string>> = {};
    const preResizeSiblingPositions: Record<string, { id: string; y: number; height: number }[]> = {};
    for (const rop of resizeOps) {
      if (rop.type !== "RESIZE_NODE") continue;
      const n = figma.getNodeById(rop.nodeId) as SceneNode | null;
      if (n) {
        preResizeDims[rop.nodeId] = { w: n.width, h: n.height };
        const circles = new Set<string>();
        recordCircularNodes(n, circles);
        preResizeCircles[rop.nodeId] = circles;
        const par = n.parent;
        if (par && "children" in par) {
          const sibs = ((par as any).children as SceneNode[])
            .filter((s: SceneNode) => s.id !== n.id)
            .sort((a: SceneNode, b: SceneNode) => a.y - b.y);
          const sectionBottom = n.y + n.height;
          preResizeSiblingPositions[rop.nodeId] = sibs
            .filter((s: SceneNode) => s.y >= sectionBottom - 5)
            .map((s: SceneNode) => ({ id: s.id, y: s.y, height: s.height }));
        }
      }
    }

    const summary = await applyBatch(batch, intent);

    // ── Post-resize AI refinement pass ──────────────────
    if (resizeOps.length > 0) {
      for (const rop of resizeOps) {
        if (rop.type !== "RESIZE_NODE") continue;
        const targetNode = figma.getNodeById(rop.nodeId);
        if (!targetNode || !("children" in targetNode)) continue;
        const kids = (targetNode as any).children as SceneNode[];
        if (kids.length === 0) continue;

        const pre = preResizeDims[rop.nodeId] ?? {
          w: (targetNode as SceneNode).width,
          h: (targetNode as SceneNode).height,
        };

        const deepSnapshot = snapshotNode(targetNode as SceneNode, 0);

        const refinementPayload = {
          intent: buildRefinementIntent(
            targetNode.name,
            deepSnapshot,
            pre.w,
            pre.h,
            ""
          ),
          selection: { nodes: [deepSnapshot] },
          designSystem: {
            textStyles: [],
            fillStyles: [],
            components: [],
            variables: [],
          },
          apiKey: _userApiKey,
          provider: _selectedProvider,
          model: _selectedModel,
        };

        try {
          const refineBatch = await fetchViaUIForJob("/plan?lenient=true", refinementPayload, job.id) as OperationBatch;
          if (refineBatch.operations && refineBatch.operations.length > 0) {
            _skipResizePropagation = true;
            try {
              for (const refOp of refineBatch.operations) {
                await applyOperation(refOp);
              }
            } finally {
              _skipResizePropagation = false;
            }
          }
        } catch (err: any) {
          console.warn(
            `[edit-job ${job.id}] Content refinement skipped: ${err.message}`
          );
        }

        // Enforce circle preservation
        const circles = preResizeCircles[rop.nodeId];
        if (circles && circles.size > 0) {
          enforceCirclesFromSet(circles);
        }

        // Restore original sibling gaps
        const sectionNode = targetNode as SceneNode;
        const origSiblings = preResizeSiblingPositions[rop.nodeId] || [];
        if (origSiblings.length > 0) {
          const sectionBottom = sectionNode.y + sectionNode.height;
          const preDims = preResizeDims[rop.nodeId];
          const preSectionBottom = sectionNode.y + (preDims ? preDims.h : sectionNode.height);
          let cursor = sectionBottom;
          for (let si = 0; si < origSiblings.length; si++) {
            const origSib = origSiblings[si];
            const currentSib = figma.getNodeById(origSib.id) as SceneNode | null;
            if (!currentSib) continue;
            const origGap = si === 0
              ? origSib.y - preSectionBottom
              : origSib.y - (origSiblings[si - 1].y + origSiblings[si - 1].height);
            const gap = Math.max(origGap, 0);
            const desiredY = cursor + gap;
            if (Math.abs(currentSib.y - desiredY) > 1) {
              currentSib.y = desiredY;
            }
            cursor = currentSib.y + currentSib.height;
          }
        }
      }
    }

    figma.notify(summary, { timeout: 4000 });
    sendToUI({ type: "job-complete", jobId: job.id, summary } as any);

  } catch (err: any) {
    console.error(`[edit-job ${job.id}] Error:`, err.message, err.stack);
    if (job.cancelled) {
      sendToUI({ type: "job-cancelled", jobId: job.id } as any);
      return;
    }
    sendToUI({ type: "job-error", jobId: job.id, error: `Edit failed: ${err.message}` } as any);
  } finally {
    _activeJobs.delete(job.id);
  }
}

async function runGenerateJob(job: GenerateJobState, prompt: string): Promise<void> {
  try {
    sendToUI({ type: "job-progress", jobId: job.id, phase: "analyze" } as any);

    // Extract design system (cached for 60s)
    console.log(`[job ${job.id}] Extracting design system...`);
    const designSystem = await extractDesignSystemSnapshot();
    console.log(`[job ${job.id}] Design system extracted.`);

    await yieldToUI();
    if (job.cancelled) { sendToUI({ type: "job-cancelled", jobId: job.id } as any); return; }

    // Extract style tokens
    const styleTokens = extractStyleTokens(prompt);
    console.log(`[job ${job.id}] Style tokens extracted.`);

    await yieldToUI();
    if (job.cancelled) { sendToUI({ type: "job-cancelled", jobId: job.id } as any); return; }

    sendToUI({ type: "job-progress", jobId: job.id, phase: "generate" } as any);

    // Extract selection so the LLM knows what "this frame" means
    const selectionSnapshot = extractSelectionSnapshot();
    console.log(`[job ${job.id}] Selection: ${selectionSnapshot.nodes.length} node(s)`);

    // Call backend via UI iframe (parallel-safe)
    console.log(`[job ${job.id}] Calling backend /generate...`);
    let result: { snapshot: any };
    try {
      result = await fetchViaUIForJob("/generate", {
        prompt,
        styleTokens,
        designSystem,
        selection: selectionSnapshot,
        apiKey: _userApiKey,
        provider: _selectedProvider,
        model: _selectedModel,
      }, job.id);
    } catch (err: any) {
      if (job.cancelled) {
        console.log(`[job ${job.id}] Fetch cancelled by user.`);
        sendToUI({ type: "job-cancelled", jobId: job.id } as any);
        return;
      }
      console.error(`[job ${job.id}] Fetch error:`, err.message);
      sendToUI({ type: "job-error", jobId: job.id, error: `Backend error: ${err.message}` } as any);
      return;
    }

    const snapshot = result.snapshot;
    if (!snapshot || !snapshot.type) {
      console.error(`[job ${job.id}] Invalid snapshot:`, JSON.stringify(result).slice(0, 200));
      sendToUI({ type: "job-error", jobId: job.id, error: "Backend returned invalid frame data." } as any);
      return;
    }

    console.log(`[job ${job.id}] Snapshot received:`, snapshot.name, snapshot.type);

    if (job.cancelled) { sendToUI({ type: "job-cancelled", jobId: job.id } as any); return; }

    sendToUI({ type: "job-progress", jobId: job.id, phase: "create" } as any);

    // Assign unique IDs
    assignTempIds(snapshot);

    // Reset import stats (safe because frame creation is CPU-bound / synchronous between yields)
    _importStats = { texts: 0, frames: 0, images: 0, failed: 0, errors: [] as string[] };

    // Reserve placement position to avoid overlaps between parallel jobs
    let placeX: number;
    if (_nextPlaceX !== null) {
      placeX = _nextPlaceX;
    } else {
      placeX = 0;
      const existingChildren = figma.currentPage.children;
      if (existingChildren.length > 0) {
        let maxRight = -Infinity;
        for (const child of existingChildren) {
          const right = child.x + child.width;
          if (right > maxRight) maxRight = right;
        }
        placeX = maxRight + 200;
      }
    }
    // Reserve space for this frame (estimate from snapshot width)
    _nextPlaceX = placeX + (snapshot.width || 1440) + 200;

    // Create the frame
    console.log(`[job ${job.id}] Creating frame on canvas at x:${placeX}...`);
    const node = await createNodeFromSnapshot(snapshot, figma.currentPage);
    if (node) {
      node.x = placeX;
      node.y = 0;
      if ("setPluginData" in node) {
        (node as SceneNode).setPluginData("generated", "true");
      }
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      // Update _nextPlaceX with actual width (may differ from estimate)
      const actualRight = placeX + node.width + 200;
      if (actualRight > (_nextPlaceX || 0)) _nextPlaceX = actualRight;
      console.log(`[job ${job.id}] Frame created.`);
    } else {
      console.warn(`[job ${job.id}] createNodeFromSnapshot returned null`);
    }

    const genStats = `Generated "${snapshot.name || "Frame"}": ${_importStats.frames} frames, ${_importStats.texts} texts`;
    figma.notify(genStats, { timeout: 4000 });
    sendToUI({ type: "job-complete", jobId: job.id, summary: genStats } as any);

  } catch (err: any) {
    console.error(`[job ${job.id}] Error:`, err.message, err.stack);
    if (job.cancelled) {
      sendToUI({ type: "job-cancelled", jobId: job.id } as any);
      return;
    }
    sendToUI({ type: "job-error", jobId: job.id, error: `Generation failed: ${err.message}` } as any);
  } finally {
    _activeJobs.delete(job.id);
    // Reset _nextPlaceX if no more active jobs
    if (_activeJobs.size === 0) _nextPlaceX = null;
  }
}

figma.ui.onmessage = async (msg: UIToPluginMessage) => {
  try {
    switch (msg.type) {
      // ── Cancel in-flight request (serial plan+apply) ─────
      case "cancel" as any: {
        _cancelled = true;
        _working = false;
        // Reject any pending fetch promise (UI already aborted the HTTP call)
        if (_pendingFetch) {
          _pendingFetch.reject(new Error("Cancelled"));
          _pendingFetch = null;
        }
        return;
      }

      // ── Cancel a specific generate job ────────────────────
      case "cancel-job" as any: {
        const jobId = (msg as any).jobId as number;
        const job = _activeJobs.get(jobId);
        if (job) {
          job.cancelled = true;
          // Find and reject any pending fetch for this job
          for (const [seq, pf] of _pendingFetches) {
            if (pf.jobId === jobId) {
              pf.reject(new Error("Cancelled"));
              _pendingFetches.delete(seq);
              break;
            }
          }
        }
        return;
      }

      // ── Fetch proxy responses from UI iframe ──────────────
      case "fetch-result" as any: {
        const seq = (msg as any).seq;
        // Check parallel job fetches first
        const pf = _pendingFetches.get(seq);
        if (pf) {
          pf.resolve((msg as any).data);
          _pendingFetches.delete(seq);
          return;
        }
        // Fall back to serial fetch
        if (_pendingFetch && _pendingFetch.seq === seq) {
          _pendingFetch.resolve((msg as any).data);
          _pendingFetch = null;
        }
        return;
      }
      case "fetch-error" as any: {
        const seq = (msg as any).seq;
        const pf2 = _pendingFetches.get(seq);
        if (pf2) {
          pf2.reject(new Error((msg as any).error || "Fetch failed"));
          _pendingFetches.delete(seq);
          return;
        }
        if (_pendingFetch && _pendingFetch.seq === seq) {
          _pendingFetch.reject(new Error((msg as any).error || "Fetch failed"));
          _pendingFetch = null;
        }
        return;
      }
      case "fetch-aborted" as any: {
        const seq = (msg as any).seq;
        const pf3 = _pendingFetches.get(seq);
        if (pf3) {
          pf3.reject(new Error("Cancelled"));
          _pendingFetches.delete(seq);
          return;
        }
        if (_pendingFetch && _pendingFetch.seq === seq) {
          _pendingFetch.reject(new Error("Cancelled"));
          _pendingFetch = null;
        }
        return;
      }

      // ── Persist audit timings from UI ─────────────────────
      case "save-audit-timings" as any: {
        try {
          const timings = (msg as any).timings;
          await figma.clientStorage.setAsync("auditTimings", JSON.stringify(timings));
          console.log("[a11y] Saved audit timings");
        } catch (e) {
          console.warn("[a11y] Failed to save audit timings:", e);
        }
        return;
      }

      // ── Persist state audit timings from UI ───────────────
      case "save-state-audit-timings" as any: {
        try {
          const timings = (msg as any).timings;
          await figma.clientStorage.setAsync("stateAuditTimings", JSON.stringify(timings));
          console.log("[state-audit] Saved state audit timings");
        } catch (e) {
          console.warn("[state-audit] Failed to save state audit timings:", e);
        }
        return;
      }

      // ── Persist phase timings from UI ─────────────────────
      case "save-timings" as any: {
        try {
          const timings = (msg as any).timings;
          await figma.clientStorage.setAsync("phaseTimings", JSON.stringify(timings));
          console.log("[timings] Saved phase timings:", timings);
        } catch (e) {
          console.warn("[timings] Failed to save:", e);
        }
        return;
      }

      // ── Persist API key from UI ───────────────────────────
      case "save-api-key" as any: {
        try {
          const key = (msg as any).key || "";
          const provider = (msg as any).provider || _selectedProvider;
          _userApiKey = key;
          await figma.clientStorage.setAsync(`apiKey_${provider}`, key);
          console.log(`[api-key] API key saved for provider=${provider}.`);
        } catch (e) {
          console.warn("[api-key] Failed to save API key:", e);
        }
        return;
      }

      // ── Persist provider/model selection ───────────────────
      case "save-provider-selection" as any: {
        try {
          const provider = (msg as any).provider || "anthropic";
          const model = (msg as any).model || "";
          _selectedProvider = provider;
          _selectedModel = model;
          await figma.clientStorage.setAsync("selectedProvider", provider);
          await figma.clientStorage.setAsync("selectedModel", model);
          // Switch to the saved key for this provider
          const savedKey = await figma.clientStorage.getAsync(`apiKey_${provider}`);
          _userApiKey = savedKey || "";
          console.log(`[settings] Provider=${provider}, model=${model}, key=${_userApiKey ? "set" : "empty"}`);
        } catch (e) {
          console.warn("[settings] Failed to save provider selection:", e);
        }
        return;
      }

      // ── Accessibility Audit ───────────────────────────────
      case "audit-a11y" as any: {
        try {
          sendToUI({ type: "status", message: "Running accessibility audit…" });

          // Determine scope: selection if available, otherwise all design frames
          let nodesToAudit: SceneNode[] = [];
          let auditScope = "all";
          if (figma.currentPage.selection.length > 0) {
            nodesToAudit = [...figma.currentPage.selection];
            // Determine scope granularity
            if (nodesToAudit.length === 1 && nodesToAudit[0].type === "FRAME") {
              auditScope = "frame";
            } else {
              auditScope = "component";
            }
          } else {
            // All top-level frames (skip Change Log and Audit Badge frames)
            nodesToAudit = figma.currentPage.children.filter(
              (n) =>
                n.type === "FRAME" &&
                n.name !== CHANGE_LOG_FRAME_NAME &&
                n.name !== AUDIT_BADGE_FRAME_NAME &&
                !n.name.startsWith("a11y-badge:")
            ) as SceneNode[];
            auditScope = "all";
          }

          if (nodesToAudit.length === 0) {
            sendToUI({ type: "audit-error", error: "No frames found to audit." } as any);
            break;
          }

          // Tell UI which scope so progress estimates are accurate
          sendToUI({ type: "audit-phase", phase: "scanning", scope: auditScope } as any);

          console.log(`[a11y] Auditing ${nodesToAudit.length} node(s) [scope=${auditScope}]…`);
          const findings = runAccessibilityAudit(nodesToAudit);
          console.log(`[a11y] Found ${findings.length} issue(s).`);

          // Send to LLM for enrichment with suggestions
          if (findings.length > 0 && _userApiKey) {
            try {
              sendToUI({ type: "audit-phase", phase: "enhancing" } as any);
              sendToUI({ type: "status", message: `Found ${findings.length} issue(s) — getting AI suggestions…` });

              const auditBody = {
                findings: findings.slice(0, 30), // cap for token limits
                apiKey: _userApiKey,
                provider: _selectedProvider,
                model: _selectedModel,
              };

              const enriched = await fetchViaUI("/audit", auditBody);
              if (enriched && enriched.findings) {
                // Merge suggestions back into findings
                for (const ef of enriched.findings) {
                  const match = findings.find((f: AuditFinding) => f.nodeId === ef.nodeId && f.checkType === ef.checkType);
                  if (match && ef.suggestion) {
                    match.suggestion = ef.suggestion;
                  }
                }
              }
            } catch (llmErr: any) {
              console.warn("[a11y] LLM enrichment failed, returning raw findings:", llmErr.message);
            }
          }

          // Create canvas badges
          createAuditBadges(findings);

          // Send results to UI
          sendToUI({ type: "audit-results", findings } as any);
          figma.notify(`Accessibility audit: ${findings.length} issue(s) found.`, { timeout: 4000 });
        } catch (err: any) {
          console.error("[a11y] Audit error:", err);
          sendToUI({ type: "audit-error", error: err.message || "Audit failed." } as any);
        }
        break;
      }

      // ── Clear Audit Badges ────────────────────────────────
      case "clear-audit" as any: {
        clearAuditBadges();
        figma.notify("Audit badges cleared.", { timeout: 2000 });
        break;
      }

      // ── UI State Audit ────────────────────────────────────
      case "audit-states" as any: {
        try {
          sendToUI({ type: "status", message: "Scanning for components and screens…" });

          // Determine scope
          let scope = "all";
          const sel = figma.currentPage.selection;
          if (sel.length > 0) {
            if (sel.length === 1 && sel[0].type === "FRAME") scope = "frame";
            else scope = "component";
          }
          sendToUI({ type: "state-audit-phase", phase: "scanning", scope } as any);

          // Collect items to audit
          interface StateAuditInput {
            nodeId: string;
            name: string;
            itemType: "component" | "screen";
            variants?: string[];
            childNames?: string[];
          }
          const items: StateAuditInput[] = [];
          const MAX_ITEMS = 20;

          const roots: readonly SceneNode[] = sel.length > 0
            ? sel
            : figma.currentPage.children.filter(
                (n) => n.type === "FRAME" && n.name !== CHANGE_LOG_FRAME_NAME &&
                  n.name !== AUDIT_BADGE_FRAME_NAME && !n.name.startsWith("a11y-badge:")
              ) as SceneNode[];

          function walkForStateAudit(node: SceneNode) {
            if (items.length >= MAX_ITEMS) return;

            if (node.type === "COMPONENT_SET") {
              // Collect variant names
              const variantNames = (node as ComponentSetNode).children.map(c => c.name);
              items.push({
                nodeId: node.id,
                name: node.name,
                itemType: "component",
                variants: variantNames.slice(0, 30),
              });
              return; // Don't recurse into variant children
            }

            if (node.type === "COMPONENT") {
              // Standalone component (not inside a COMPONENT_SET)
              if (node.parent?.type !== "COMPONENT_SET") {
                items.push({
                  nodeId: node.id,
                  name: node.name,
                  itemType: "component",
                  childNames: ("children" in node) ? (node as any).children.map((c: any) => c.name).slice(0, 20) : [],
                });
              }
              return;
            }

            // Top-level frames are treated as screens
            if (node.type === "FRAME" && (node.parent === figma.currentPage || sel.includes(node))) {
              // Check if this looks like a screen (has children, reasonable size)
              if ("children" in node && (node as FrameNode).children.length > 0) {
                const childNames = (node as FrameNode).children.map(c => c.name).slice(0, 30);
                items.push({
                  nodeId: node.id,
                  name: node.name,
                  itemType: "screen",
                  childNames,
                });
              }
            }

            // Recurse into children to find components
            if ("children" in node) {
              for (const child of (node as any).children) {
                if (items.length >= MAX_ITEMS) break;
                walkForStateAudit(child as SceneNode);
              }
            }
          }

          for (const root of roots) {
            if (items.length >= MAX_ITEMS) break;
            walkForStateAudit(root);
          }

          if (items.length === 0) {
            sendToUI({ type: "state-audit-error", error: "No components or screens found to audit." } as any);
            break;
          }

          console.log(`[state-audit] Found ${items.length} item(s) to audit [scope=${scope}]`);

          // Send to LLM for analysis
          sendToUI({ type: "state-audit-phase", phase: "analyzing" } as any);
          sendToUI({ type: "status", message: `Analyzing ${items.length} item(s) for UI states…` });

          const stateBody = {
            items,
            apiKey: _userApiKey,
            provider: _selectedProvider,
            model: _selectedModel,
          };

          const result = await fetchViaUI("/audit-states", stateBody);
          if (result && result.items) {
            sendToUI({ type: "state-audit-results", items: result.items } as any);
            const missingCount = result.items.reduce((sum: number, it: any) => sum + (it.missingStates?.length || 0), 0);
            figma.notify(`State audit: ${missingCount} missing state(s) found across ${result.items.length} item(s).`, { timeout: 4000 });
          } else {
            sendToUI({ type: "state-audit-error", error: "No results returned from analysis." } as any);
          }
        } catch (err: any) {
          console.error("[state-audit] Error:", err);
          sendToUI({ type: "state-audit-error", error: err.message || "State audit failed." } as any);
        }
        break;
      }

      // ── Select a node by ID (from audit results panel) ────
      case "select-node" as any: {
        const nodeId = (msg as any).nodeId;
        if (nodeId) {
          const targetNode = figma.getNodeById(nodeId) as SceneNode;
          if (targetNode) {
            figma.currentPage.selection = [targetNode];
            figma.viewport.scrollAndZoomIntoView([targetNode]);
          }
        }
        break;
      }

      // ── Run (plan + apply in one step) ─────────────────────
      case "run": {
        const intentText = ((msg as any).intent || "");
        const isGenerateIntent = figma.currentPage.selection.length === 0 ||
          /\b(add|create|generate|make|build|design)\b.+\b(frame|screen|page|view|layout|mobile|desktop)\b/i.test(intentText) ||
          /\b(new|mobile|desktop)\b.+\b(frame|screen|page|view|layout)\b/i.test(intentText) ||
          /\b(frame|screen|page)\b.+\bfor\b/i.test(intentText);

        // Create a job for either flow
        const jobId = ++_nextJobId;
        const job: GenerateJobState = { id: jobId, cancelled: false };
        _activeJobs.set(jobId, job);

        if (isGenerateIntent) {
          const prompt = intentText;
          console.log(`[run] Starting generate job ${jobId}: "${prompt.slice(0, 60)}"`);
          sendToUI({ type: "job-started", jobId, prompt } as any);
          runGenerateJob(job, prompt).catch((err: any) => {
            console.error(`[run] Unhandled error in generate job ${jobId}:`, err);
            if (!job.cancelled) {
              sendToUI({ type: "job-error", jobId, error: `Generation failed: ${err.message}` } as any);
            }
            _activeJobs.delete(jobId);
          });
        } else {
          // Edit existing selection — capture snapshot now before user changes selection
          const selectionSnapshot = extractSelectionSnapshot();
          console.log(`[run] Starting edit job ${jobId}: "${intentText.slice(0, 60)}" (${selectionSnapshot.nodes.length} nodes)`);
          sendToUI({ type: "job-started", jobId, prompt: intentText } as any);
          runEditJob(job, intentText, selectionSnapshot).catch((err: any) => {
            console.error(`[run] Unhandled error in edit job ${jobId}:`, err);
            if (!job.cancelled) {
              sendToUI({ type: "job-error", jobId, error: `Edit failed: ${err.message}` } as any);
            }
            _activeJobs.delete(jobId);
          });
        }
        break;
      }

      // ── Export design to JSON ──────────────────────────────────
      case "export-json": {
        const hasSelection = figma.currentPage.selection.length > 0;

        sendToUI({
          type: "status",
          message: hasSelection
            ? "Extracting selected nodes…"
            : "Extracting entire page…",
        });

        // If nothing is selected, snapshot every top-level node on the page
        // Always exclude the AI Change Log frame
        const rawNodes = hasSelection
          ? [...figma.currentPage.selection]
          : [...figma.currentPage.children];
        const sourceNodes = rawNodes.filter(
          (n) => !(n.type === "FRAME" && n.name === CHANGE_LOG_FRAME_NAME)
        );

        const exportSelection: SelectionSnapshot = {
          nodes: sourceNodes.map((node) => snapshotNode(node, 0)),
        };

        // Embed image data as base64 into snapshot nodes
        sendToUI({ type: "status", message: "Encoding images…" });
        for (let i = 0; i < exportSelection.nodes.length; i++) {
          await embedImagesInSnapshot(exportSelection.nodes[i], sourceNodes[i]);
        }

        const exportDesignSystem = await extractDesignSystemSnapshot();

        const exportData = {
          exportedAt: new Date().toISOString(),
          pageName: figma.currentPage.name,
          selection: exportSelection,
          designSystem: exportDesignSystem,
        };

        const safeName = figma.currentPage.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `design-export-${safeName}.json`;

        sendToUI({ type: "export-json-result", data: exportData, filename });
        break;
      }

      // ── Generate Design Docs (markdown) ────────────────────────
      case "generate-docs": {
        try {
          sendToUI({ type: "status", message: "Extracting design tokens…" });
          const result = await generateDesignDocs();
          sendToUI({ type: "docs-result", markdown: result.markdown, filename: result.filename });
        } catch (err: any) {
          sendToUI({ type: "docs-error", error: err.message || "Failed to generate docs." });
        }
        break;
      }

      // ── Import design from JSON ───────────────────────────────
      case "import-json": {
        try {
          const rawImportNodes = msg.data.selection.nodes;
          if (!Array.isArray(rawImportNodes) || rawImportNodes.length === 0) {
            sendToUI({ type: "import-json-error", error: "No nodes found in the JSON." });
            return;
          }
          // Filter out any AI Change Log frames
          const nodes = rawImportNodes.filter(
            (n: any) => n.name !== CHANGE_LOG_FRAME_NAME
          );

          sendToUI({ type: "status", message: `Creating ${nodes.length} node(s)…` });

          // Reset import stats
          _importStats = { texts: 0, frames: 0, images: 0, failed: 0, errors: [] };

          // Calculate placement: right next to the original frames (or existing content)
          // Try to find the original frames by matching names from the export
          const exportedNames = new Set(nodes.map((n: any) => n.name));
          const pageChildren = figma.currentPage.children;

          // Find original frames that match exported names
          const matchingOriginals = pageChildren.filter(
            (c) => exportedNames.has(c.name)
          );

          let offsetX = 0;
          let anchorY: number | null = null;
          const IMPORT_GAP = 200; // visible gap to distinguish imported frames

          if (matchingOriginals.length > 0) {
            // Desired: right after the matching originals
            let maxRight = -Infinity;
            let minY = Infinity;
            let maxBottom = -Infinity;
            for (const orig of matchingOriginals) {
              const right = orig.x + orig.width;
              if (right > maxRight) maxRight = right;
              if (orig.y < minY) minY = orig.y;
              const bottom = orig.y + orig.height;
              if (bottom > maxBottom) maxBottom = bottom;
            }
            const desiredX = maxRight + IMPORT_GAP;
            anchorY = minY;

            // Calculate total width/height the import will occupy
            let totalImportW = 0;
            let totalImportH = maxBottom - minY;
            for (const snap of nodes) {
              const w = snap.width || 0;
              const relX = (snap.x || 0) - (nodes.reduce((m: number, n: any) => Math.min(m, n.x || 0), Infinity));
              if (relX + w > totalImportW) totalImportW = relX + w;
            }

            // Check if any other frames on the page would overlap the desired region
            const importLeft = desiredX;
            const importRight = desiredX + totalImportW;
            const importTop = minY;
            const importBottom = minY + totalImportH;

            let blocked = false;
            for (const child of pageChildren) {
              if (exportedNames.has(child.name)) continue; // skip originals
              const cLeft = child.x;
              const cRight = child.x + child.width;
              const cTop = child.y;
              const cBottom = child.y + child.height;
              // Check overlap
              if (cLeft < importRight && cRight > importLeft &&
                  cTop < importBottom && cBottom > importTop) {
                blocked = true;
                // Push offsetX past this blocker
                if (cRight + IMPORT_GAP > desiredX) {
                  offsetX = cRight + IMPORT_GAP;
                }
              }
            }
            if (!blocked) {
              offsetX = desiredX;
            }
          } else if (pageChildren.length > 0) {
            // Fallback: place right of all content
            let maxRight = -Infinity;
            for (const child of pageChildren) {
              const right = child.x + child.width;
              if (right > maxRight) maxRight = right;
            }
            offsetX = maxRight + IMPORT_GAP;
          }
          // else: empty page — offsetX stays 0, anchorY stays null → places at origin

          // Find the leftmost x in the exported nodes to normalize positions
          let minSnapX = Infinity;
          let minSnapY = Infinity;
          for (const snap of nodes) {
            if (snap.x != null && snap.x < minSnapX) minSnapX = snap.x;
            if (snap.y != null && snap.y < minSnapY) minSnapY = snap.y;
          }
          if (!isFinite(minSnapX)) minSnapX = 0;
          if (!isFinite(minSnapY)) minSnapY = 0;

          const created: SceneNode[] = [];
          for (const snap of nodes) {
            try {
              const node = await createNodeFromSnapshot(snap, figma.currentPage);
              if (node) {
                // Position relative to offsetX, preserving original layout between frames
                node.x = offsetX + ((snap.x || 0) - minSnapX);
                node.y = (anchorY != null ? anchorY : 0) + ((snap.y || 0) - minSnapY);
                created.push(node);
              }
            } catch (nodeErr) {
              _importStats.failed++;
              _importStats.errors.push(`Root "${snap.name}": ${(nodeErr as Error).message}`);
            }
          }

          // Select the imported nodes and zoom to them
          if (created.length > 0) {
            figma.currentPage.selection = created;
            figma.viewport.scrollAndZoomIntoView(created);
          }

          // Show diagnostic notification
          const statsMsg = `Import: ${_importStats.frames} frames, ${_importStats.texts} texts, ${_importStats.images} images`;
          const failMsg = _importStats.failed > 0 ? `, ${_importStats.failed} failed` : "";
          figma.notify(statsMsg + failMsg, { timeout: 6000 });

          if (_importStats.errors.length > 0) {
            console.warn("Import errors:", _importStats.errors.slice(0, 10));
          }

          sendToUI({
            type: "import-json-success",
            summary: `Imported ${created.length} node(s). ${_importStats.texts} text, ${_importStats.frames} frames, ${_importStats.images} images.${failMsg}`,
          });
        } catch (err: any) {
          sendToUI({ type: "import-json-error", error: `Import failed: ${err.message}` });
        }
        break;
      }

      // ── Generate Frame (parallel job-based) ────────────────────
      case "generate": {
        // Create a new job for this generate request
        const jobId = ++_nextJobId;
        const job: GenerateJobState = { id: jobId, cancelled: false };
        _activeJobs.set(jobId, job);

        const prompt = (msg as any).prompt || "";
        console.log(`[generate] Starting job ${jobId}: "${prompt.slice(0, 60)}"`);

        // Notify UI that a parallel job has started
        sendToUI({ type: "job-started", jobId, prompt } as any);

        // Fire and forget — don't await, allowing parallel jobs
        runGenerateJob(job, prompt).catch((err: any) => {
          console.error(`[generate] Unhandled error in job ${jobId}:`, err);
          if (!job.cancelled) {
            sendToUI({ type: "job-error", jobId, error: `Generation failed: ${err.message}` } as any);
          }
          _activeJobs.delete(jobId);
        });
        break;
      }

      // ── Revert ────────────────────────────────────────────────
      case "revert-last": {
        // Try loading from storage if not in memory
        if (!lastRevertState) {
          lastRevertState = await loadRevertState();
        }

        if (!lastRevertState) {
          sendToUI({ type: "revert-error", error: "Nothing to revert." });
          return;
        }

        sendToUI({ type: "status", message: "Reverting…" });
        await revertLast();
        await figma.clientStorage.deleteAsync("lastRevertState");
        sendToUI({ type: "revert-success" });
        break;
      }
    }
  } catch (err: any) {
    const errMsg = err.message || String(err);
    const isRateLimit = errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit");
    const displayMsg = isRateLimit
      ? "Rate limited — wait ~60 seconds and try again."
      : errMsg;
    sendToUI({ type: "apply-error", error: displayMsg });
    figma.notify(displayMsg, { timeout: 6000, error: true });
  }
};
