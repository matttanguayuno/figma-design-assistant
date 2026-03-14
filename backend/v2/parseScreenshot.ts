/**
 * V2 Screenshot Parser — Region/container detection using sharp
 *
 * Detects rectangular UI regions (cards, sidebar, panels) from a screenshot
 * using edge detection and connected-component analysis with sharp.
 * Also samples fill colors for detected regions.
 */

import sharp from "sharp";
import type { ContainerRegion, Bbox } from "./types";

/**
 * Detect rectangular container regions from a screenshot.
 */
export async function parseContainers(
  imgBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
): Promise<ContainerRegion[]> {
  console.log(`[v2/parse] Detecting container regions in ${imgWidth}x${imgHeight} image...`);

  // Step 1: Detect edges using Laplacian-style convolution
  const edgeBuffer = await sharp(imgBuffer)
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1], // Laplacian
    })
    .threshold(30) // binary edge map
    .raw()
    .toBuffer();

  console.log(`[v2/parse] Edge detection complete: ${edgeBuffer.length} bytes`);

  // Step 2: Find horizontal and vertical line segments
  const hLines = findHorizontalLines(edgeBuffer, imgWidth, imgHeight);
  const vLines = findVerticalLines(edgeBuffer, imgWidth, imgHeight);
  console.log(`[v2/parse] Found ${hLines.length} horizontal lines, ${vLines.length} vertical lines`);

  // Step 3: Find rectangles from intersecting line segments
  const rawRects = findRectangles(hLines, vLines, imgWidth, imgHeight);
  console.log(`[v2/parse] Found ${rawRects.length} candidate rectangles`);

  // Step 4: Filter and deduplicate rectangles
  const filteredRects = filterRectangles(rawRects, imgWidth, imgHeight);
  console.log(`[v2/parse] After filtering: ${filteredRects.length} rectangles`);

  // Step 5: Sample colors and build container regions
  const containers = await buildContainerRegions(filteredRects, imgBuffer, imgWidth, imgHeight);

  // Step 6: Build parent/child hierarchy
  const hierarchy = buildHierarchy(containers);
  console.log(`[v2/parse] Final: ${hierarchy.length} top-level containers`);

  return hierarchy;
}

// ── Line detection helpers ──────────────────────────────────────────

interface LineSeg {
  start: number;  // x for horizontal, y for vertical
  end: number;
  pos: number;    // y for horizontal, x for vertical
}

/**
 * Find horizontal line segments (runs of edge pixels along rows).
 */
function findHorizontalLines(edgeBuf: Buffer, w: number, h: number): LineSeg[] {
  const lines: LineSeg[] = [];
  const minLength = Math.max(20, w * 0.03); // at least 3% of image width

  for (let y = 0; y < h; y++) {
    let runStart = -1;
    for (let x = 0; x < w; x++) {
      const val = edgeBuf[y * w + x];
      if (val > 128) {
        if (runStart < 0) runStart = x;
      } else {
        if (runStart >= 0) {
          const len = x - runStart;
          if (len >= minLength) {
            lines.push({ start: runStart, end: x, pos: y });
          }
          runStart = -1;
        }
      }
    }
    if (runStart >= 0 && w - runStart >= minLength) {
      lines.push({ start: runStart, end: w, pos: y });
    }
  }

  // Merge nearby horizontal lines at similar y positions
  return mergeLines(lines, "h");
}

/**
 * Find vertical line segments (runs of edge pixels along columns).
 */
function findVerticalLines(edgeBuf: Buffer, w: number, h: number): LineSeg[] {
  const lines: LineSeg[] = [];
  const minLength = Math.max(20, h * 0.03);

  for (let x = 0; x < w; x++) {
    let runStart = -1;
    for (let y = 0; y < h; y++) {
      const val = edgeBuf[y * w + x];
      if (val > 128) {
        if (runStart < 0) runStart = y;
      } else {
        if (runStart >= 0) {
          const len = y - runStart;
          if (len >= minLength) {
            lines.push({ start: runStart, end: y, pos: x });
          }
          runStart = -1;
        }
      }
    }
    if (runStart >= 0 && h - runStart >= minLength) {
      lines.push({ start: runStart, end: h, pos: x });
    }
  }

  return mergeLines(lines, "v");
}

/**
 * Merge nearby parallel lines at similar positions.
 */
function mergeLines(lines: LineSeg[], dir: "h" | "v"): LineSeg[] {
  if (lines.length === 0) return [];

  // Sort by position
  const sorted = [...lines].sort((a, b) => a.pos - b.pos || a.start - b.start);
  const merged: LineSeg[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // Merge if within 3px position and overlapping/adjacent extent
    if (Math.abs(next.pos - current.pos) <= 3 &&
        next.start <= current.end + 5) {
      current = {
        start: Math.min(current.start, next.start),
        end: Math.max(current.end, next.end),
        pos: Math.round((current.pos + next.pos) / 2),
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

// ── Rectangle detection ─────────────────────────────────────────────

/**
 * Find rectangles from intersecting horizontal and vertical lines.
 */
function findRectangles(
  hLines: LineSeg[],
  vLines: LineSeg[],
  imgW: number,
  imgH: number,
): Bbox[] {
  const rects: Bbox[] = [];
  const tolerance = 8; // px tolerance for line matching

  // For each pair of horizontal lines (top + bottom edges)
  for (let i = 0; i < hLines.length; i++) {
    for (let j = i + 1; j < hLines.length; j++) {
      const top = hLines[i];
      const bottom = hLines[j];

      const height = bottom.pos - top.pos;
      if (height < 20 || height > imgH * 0.95) continue;

      // Check if they overlap horizontally
      const overlapStart = Math.max(top.start, bottom.start);
      const overlapEnd = Math.min(top.end, bottom.end);
      if (overlapEnd - overlapStart < 20) continue;

      // Look for vertical lines connecting them
      const leftEdges = vLines.filter(v =>
        Math.abs(v.pos - overlapStart) < tolerance &&
        v.start <= top.pos + tolerance &&
        v.end >= bottom.pos - tolerance
      );
      const rightEdges = vLines.filter(v =>
        Math.abs(v.pos - overlapEnd) < tolerance &&
        v.start <= top.pos + tolerance &&
        v.end >= bottom.pos - tolerance
      );

      if (leftEdges.length > 0 && rightEdges.length > 0) {
        rects.push({
          x: overlapStart,
          y: top.pos,
          w: overlapEnd - overlapStart,
          h: height,
        });
      }
    }
  }

  // Also detect rectangles from just vertical line pairs
  // (some UI elements have strong vertical edges but subtle horizontal ones)
  for (let i = 0; i < vLines.length; i++) {
    for (let j = i + 1; j < vLines.length; j++) {
      const left = vLines[i];
      const right = vLines[j];

      const width = right.pos - left.pos;
      if (width < 30 || width > imgW * 0.98) continue;

      const overlapStart = Math.max(left.start, right.start);
      const overlapEnd = Math.min(left.end, right.end);
      const height = overlapEnd - overlapStart;
      if (height < 20) continue;

      // Check for matching horizontal lines
      const topEdges = hLines.filter(h =>
        Math.abs(h.pos - overlapStart) < tolerance &&
        h.start <= left.pos + tolerance &&
        h.end >= right.pos - tolerance
      );

      if (topEdges.length > 0) {
        rects.push({
          x: left.pos,
          y: overlapStart,
          w: width,
          h: height,
        });
      }
    }
  }

  return rects;
}

/**
 * Filter rectangles: remove too small, too large, and deduplicate overlapping.
 */
function filterRectangles(rects: Bbox[], imgW: number, imgH: number): Bbox[] {
  const minArea = 400;  // minimum 20x20
  const maxAreaRatio = 0.95; // max 95% of image

  // Filter by size
  let filtered = rects.filter(r => {
    const area = r.w * r.h;
    return area >= minArea && area < imgW * imgH * maxAreaRatio;
  });

  // Deduplicate: merge rectangles that overlap >80%
  const deduped: Bbox[] = [];
  for (const rect of filtered) {
    let merged = false;
    for (let i = 0; i < deduped.length; i++) {
      const existing = deduped[i];
      const overlapRatio = bboxOverlapRatio(rect, existing);
      if (overlapRatio > 0.8) {
        // Merge by averaging
        deduped[i] = {
          x: Math.round((rect.x + existing.x) / 2),
          y: Math.round((rect.y + existing.y) / 2),
          w: Math.round((rect.w + existing.w) / 2),
          h: Math.round((rect.h + existing.h) / 2),
        };
        merged = true;
        break;
      }
    }
    if (!merged) deduped.push(rect);
  }

  return deduped;
}

function bboxOverlapRatio(a: Bbox, b: Bbox): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const overlapArea = ox * oy;
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  return minArea > 0 ? overlapArea / minArea : 0;
}

// ── Color sampling and region building ──────────────────────────────

async function buildContainerRegions(
  rects: Bbox[],
  imgBuffer: Buffer,
  imgW: number,
  imgH: number,
): Promise<ContainerRegion[]> {
  const regions: ContainerRegion[] = [];

  // Extract raw RGB once for color sampling + corner radius
  const rawInfo = await sharp(imgBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawBuf = rawInfo.data;
  const ch = rawInfo.info.channels;

  // Also get greyscale for corner radius estimation
  const greyBuf = await sharp(imgBuffer).greyscale().raw().toBuffer();

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];

    // Sample fill color from center of rectangle using raw pixels
    const cx = Math.min(Math.max(Math.round(rect.x + rect.w / 2), 0), imgW - 1);
    const cy = Math.min(Math.max(Math.round(rect.y + rect.h / 2), 0), imgH - 1);

    let fillColor = "#ffffff";
    const idx = (cy * imgW + cx) * ch;
    if (idx + 2 < rawBuf.length) {
      fillColor = `#${rawBuf[idx].toString(16).padStart(2, "0")}${rawBuf[idx + 1].toString(16).padStart(2, "0")}${rawBuf[idx + 2].toString(16).padStart(2, "0")}`;
    }

    // Estimate corner radius from greyscale buffer
    const cornerRadius = estimateCornerRadiusFromRaw(greyBuf, rect, imgW, imgH);

    regions.push({
      id: `container-${i}`,
      bbox: rect,
      fillColor,
      cornerRadius,
      confidence: 70,
      children: [],
    });
  }

  return regions;
}

/**
 * Estimate corner radius from pre-extracted greyscale buffer.
 */
function estimateCornerRadiusFromRaw(
  greyBuf: Buffer,
  rect: Bbox,
  imgW: number,
  imgH: number,
): number {
  const cornerSize = Math.min(20, Math.floor(rect.w / 4), Math.floor(rect.h / 4));
  if (cornerSize < 4) return 0;

  const left = Math.max(0, Math.round(rect.x));
  const top = Math.max(0, Math.round(rect.y));
  const w = Math.min(cornerSize, imgW - left);
  const h = Math.min(cornerSize, imgH - top);
  if (w < 4 || h < 4) return 0;

  // Read top-left pixel and center pixel from greyscale buffer
  const topLeftIdx = top * imgW + left;
  const centerIdx = (top + Math.floor(h / 2)) * imgW + (left + Math.floor(w / 2));
  if (topLeftIdx >= greyBuf.length || centerIdx >= greyBuf.length) return 0;

  const topLeftVal = greyBuf[topLeftIdx];
  const centerVal = greyBuf[centerIdx];

  if (Math.abs(topLeftVal - centerVal) > 30) {
    // Count diagonal distance to edge transition
    let radius = 0;
    for (let d = 0; d < Math.min(w, h); d++) {
      const dIdx = (top + d) * imgW + (left + d);
      if (dIdx >= greyBuf.length) break;
      if (Math.abs(greyBuf[dIdx] - centerVal) < 30) {
        radius = d;
        break;
      }
    }
    return Math.max(radius, 4);
  }

  return 0;
}

// ── Hierarchy building ──────────────────────────────────────────────

/**
 * Build parent-child hierarchy: rect A contains rect B if B is fully inside A.
 * Sorted so smallest (deepest) children are assigned first.
 */
function buildHierarchy(containers: ContainerRegion[]): ContainerRegion[] {
  // Sort by area (largest first)
  const sorted = [...containers].sort((a, b) =>
    (b.bbox.w * b.bbox.h) - (a.bbox.w * a.bbox.h)
  );

  const roots: ContainerRegion[] = [];
  const assigned = new Set<number>();

  for (let i = sorted.length - 1; i >= 0; i--) {
    if (assigned.has(i)) continue;

    const child = sorted[i];
    let placed = false;

    // Find the smallest container that fully contains this one
    for (let j = sorted.length - 1; j >= 0; j--) {
      if (i === j || assigned.has(j)) continue;
      const parent = sorted[j];
      if (parent.bbox.w * parent.bbox.h <= child.bbox.w * child.bbox.h) continue;

      if (contains(parent.bbox, child.bbox)) {
        parent.children.push(child);
        assigned.add(i);
        placed = true;
        break;
      }
    }

    if (!placed) {
      roots.push(child);
    }
  }

  return roots;
}

function contains(outer: Bbox, inner: Bbox): boolean {
  const margin = 5;
  return (
    inner.x >= outer.x - margin &&
    inner.y >= outer.y - margin &&
    inner.x + inner.w <= outer.x + outer.w + margin &&
    inner.y + inner.h <= outer.y + outer.h + margin
  );
}
