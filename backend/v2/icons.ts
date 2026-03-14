/**
 * V2 Icon Detection — Find and crop icon regions
 *
 * Detects small, roughly square regions that aren't text,
 * crops them from the reference image as raster fallbacks.
 * Uses a single raw buffer extraction for all analysis (fast).
 */

import sharp from "sharp";
import type { IconRegion, TextRegion, ContainerRegion, Bbox } from "./types";

/**
 * Detect icon regions from the image, excluding known text areas.
 *
 * Strategy:
 * 1. Extract raw pixel buffer once
 * 2. Scan in grid cells, compute variance from raw pixels
 * 3. Filter non-text, roughly-square regions
 * 4. Crop icons from the original image
 */
export async function detectIcons(
  imgBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  textRegions: TextRegion[],
  _containers: ContainerRegion[],
): Promise<IconRegion[]> {
  console.log(`[v2/icons] Detecting icons in ${imgWidth}x${imgHeight} image...`);

  // Extract raw RGB pixels once — all analysis uses this buffer
  const rawInfo = await sharp(imgBuffer)
    .ensureAlpha(0)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rawBuf = rawInfo.data;
  const channels = 3; // RGB after removeAlpha

  // Step 1: Grid-scan for high-variance non-text cells using raw pixels
  const cellSize = 40;
  const step = Math.floor(cellSize / 2);
  const candidates: Bbox[] = [];

  for (let cy = 0; cy < imgHeight - cellSize; cy += step) {
    for (let cx = 0; cx < imgWidth - cellSize; cx += step) {
      const bbox: Bbox = { x: cx, y: cy, w: cellSize, h: cellSize };

      // Skip if this region overlaps with text
      if (overlapsWithText(bbox, textRegions)) continue;

      // Compute variance from raw pixels (fast — no sharp calls)
      const variance = computeCellVariance(rawBuf, cx, cy, cellSize, cellSize, imgWidth, channels);

      // High variance = potential icon (not flat background)
      if (variance > 20 && variance < 100) {
        candidates.push(bbox);
      }
    }
  }

  console.log(`[v2/icons] Found ${candidates.length} icon candidates from grid scan`);

  // Step 2: Merge overlapping candidates
  const merged = mergeCandidates(candidates);
  console.log(`[v2/icons] After merging: ${merged.length} icon regions`);

  // Step 3: Filter by aspect ratio and size
  const filtered = merged.filter(bbox => {
    const aspect = bbox.w / bbox.h;
    return aspect >= 0.5 && aspect <= 2.0
      && bbox.w <= 80 && bbox.h <= 80
      && bbox.w >= 12 && bbox.h >= 12;
  });
  console.log(`[v2/icons] After aspect/size filter: ${filtered.length} icons`);

  // Step 4: Crop each icon from the original image
  const icons: IconRegion[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const bbox = filtered[i];
    const padding = 4;
    const ex = Math.max(0, bbox.x - padding);
    const ey = Math.max(0, bbox.y - padding);
    const ew = Math.min(bbox.w + padding * 2, imgWidth - ex);
    const eh = Math.min(bbox.h + padding * 2, imgHeight - ey);
    const expandedBbox: Bbox = { x: ex, y: ey, w: ew, h: eh };

    try {
      const cropped = await sharp(imgBuffer)
        .extract({ left: ex, top: ey, width: ew, height: eh })
        .png()
        .toBuffer();

      const imageData = cropped.toString("base64");

      // Detect background color from raw pixels (4 corners)
      const bgColor = detectBgColorFromRaw(rawBuf, expandedBbox, imgWidth, channels);

      // Detect border radius from raw pixels
      const borderRadius = detectBorderRadiusFromRaw(rawBuf, expandedBbox, imgWidth, channels);

      icons.push({
        id: `icon-${i}`,
        bbox: expandedBbox,
        imageData,
        bgColor,
        borderRadius,
        confidence: 60,
      });
    } catch {
      // skip failed crops
    }
  }

  console.log(`[v2/icons] Final: ${icons.length} icons cropped`);
  return icons;
}

/**
 * Compute average channel standard deviation for a cell from raw pixels.
 */
function computeCellVariance(
  buf: Buffer, cx: number, cy: number,
  cw: number, ch: number,
  imgW: number, channels: number,
): number {
  // Sample every 4th pixel for speed
  const sums = [0, 0, 0];
  const sqSums = [0, 0, 0];
  let n = 0;

  for (let y = cy; y < cy + ch; y += 4) {
    for (let x = cx; x < cx + cw; x += 4) {
      const idx = (y * imgW + x) * channels;
      for (let c = 0; c < 3; c++) {
        const v = buf[idx + c];
        sums[c] += v;
        sqSums[c] += v * v;
      }
      n++;
    }
  }

  if (n === 0) return 0;
  let totalStdev = 0;
  for (let c = 0; c < 3; c++) {
    const mean = sums[c] / n;
    const variance = sqSums[c] / n - mean * mean;
    totalStdev += Math.sqrt(Math.max(0, variance));
  }
  return totalStdev / 3;
}

function overlapsWithText(bbox: Bbox, textRegions: TextRegion[]): boolean {
  for (const tr of textRegions) {
    const ox = Math.max(0, Math.min(bbox.x + bbox.w, tr.bbox.x + tr.bbox.w) - Math.max(bbox.x, tr.bbox.x));
    const oy = Math.max(0, Math.min(bbox.y + bbox.h, tr.bbox.y + tr.bbox.h) - Math.max(bbox.y, tr.bbox.y));
    if (ox * oy > bbox.w * bbox.h * 0.3) return true;
  }
  return false;
}

function mergeCandidates(candidates: Bbox[]): Bbox[] {
  if (candidates.length === 0) return [];
  const merged: Bbox[] = [];
  const used = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;
    let cur = { ...candidates[i] };
    used.add(i);
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < candidates.length; j++) {
        if (used.has(j)) continue;
        const b = candidates[j];
        if (!(cur.x + cur.w < b.x - 2 || b.x + b.w < cur.x - 2 ||
              cur.y + cur.h < b.y - 2 || b.y + b.h < cur.y - 2)) {
          const minX = Math.min(cur.x, b.x);
          const minY = Math.min(cur.y, b.y);
          cur = { x: minX, y: minY,
            w: Math.max(cur.x + cur.w, b.x + b.w) - minX,
            h: Math.max(cur.y + cur.h, b.y + b.h) - minY };
          used.add(j);
          changed = true;
        }
      }
    }
    merged.push(cur);
  }
  return merged;
}

function getPixelHex(buf: Buffer, x: number, y: number, w: number, ch: number): string {
  const idx = (y * w + x) * ch;
  if (idx + 2 >= buf.length) return "#000000";
  return `#${buf[idx].toString(16).padStart(2, "0")}${buf[idx + 1].toString(16).padStart(2, "0")}${buf[idx + 2].toString(16).padStart(2, "0")}`;
}

function detectBgColorFromRaw(buf: Buffer, bbox: Bbox, imgW: number, ch: number): string | undefined {
  const corners = [
    getPixelHex(buf, Math.round(bbox.x), Math.round(bbox.y), imgW, ch),
    getPixelHex(buf, Math.min(Math.round(bbox.x + bbox.w - 1), imgW - 1), Math.round(bbox.y), imgW, ch),
    getPixelHex(buf, Math.round(bbox.x), Math.min(Math.round(bbox.y + bbox.h - 1), imgW - 1), imgW, ch),
    getPixelHex(buf, Math.min(Math.round(bbox.x + bbox.w - 1), imgW - 1), Math.min(Math.round(bbox.y + bbox.h - 1), imgW - 1), imgW, ch),
  ];
  const counts = new Map<string, number>();
  for (const c of corners) counts.set(c, (counts.get(c) || 0) + 1);
  for (const [color, count] of counts) {
    if (count >= 3 && color !== "#ffffff" && color !== "#000000") return color;
  }
  return undefined;
}

function detectBorderRadiusFromRaw(buf: Buffer, bbox: Bbox, imgW: number, ch: number): number {
  if (Math.abs(bbox.w - bbox.h) > bbox.w * 0.2) return 0;
  const corner = getPixelHex(buf, Math.round(bbox.x), Math.round(bbox.y), imgW, ch);
  const center = getPixelHex(buf, Math.round(bbox.x + bbox.w / 2), Math.round(bbox.y + bbox.h / 2), imgW, ch);
  if (corner !== center) {
    if (Math.abs(bbox.w - bbox.h) < 4) return Math.round(bbox.w / 2);
    return 8;
  }
  return 0;
}
