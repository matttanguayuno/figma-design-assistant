/**
 * V2 Screenshot-to-Figma Pipeline — Shared Types
 *
 * These types describe the intermediate scene graph produced by
 * CV/OCR parsing stages, before conversion to Figma NodeSnapshot.
 */

// ── Bounding box (all coordinates in image pixels) ──────────────────

export interface Bbox {
  x: number;  // left edge
  y: number;  // top edge
  w: number;  // width
  h: number;  // height
}

// ── Text region (from OCR) ──────────────────────────────────────────

export interface TextRegion {
  text: string;
  bbox: Bbox;
  fontSize: number;
  fontWeight: number;       // 400, 500, 600, 700, 800
  fillColor: string;        // hex color
  confidence: number;       // 0–100 from Tesseract
  lineHeight?: number;
  textAlign?: "LEFT" | "CENTER" | "RIGHT";
}

// ── Container region (from edge detection) ──────────────────────────

export interface ContainerRegion {
  id: string;
  bbox: Bbox;
  fillColor: string;        // hex, sampled from center
  cornerRadius: number;
  strokeColor?: string;
  strokeWeight?: number;
  shadow?: ShadowInfo;
  confidence: number;
  children: ContainerRegion[];
}

export interface ShadowInfo {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;            // hex with alpha
}

// ── Icon region ─────────────────────────────────────────────────────

export interface IconRegion {
  id: string;
  bbox: Bbox;
  imageData: string;         // base64 PNG cropped from reference
  bgColor?: string;          // background circle/square color
  borderRadius: number;
  confidence: number;
}

// ── Full scene graph (combined output of all parsing stages) ────────

export interface SceneGraph {
  viewport: { width: number; height: number };
  texts: TextRegion[];
  containers: ContainerRegion[];
  icons: IconRegion[];
}

// ── Figma-compatible snapshot node ──────────────────────────────────

export interface SnapshotNode {
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
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
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
  textAutoResize?: string;
  lineHeight?: number;

  // RECTANGLE / image
  imageData?: string;
  imagePrompt?: string;

  // SVG
  svgMarkup?: string;
}
