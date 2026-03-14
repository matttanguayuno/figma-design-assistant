/**
 * V2 Icon Detection — Find and crop icon regions
 *
 * Detects small, roughly square regions that aren't text,
 * crops them from the reference image as raster fallbacks.
 */

import sharp from "sharp";
import type { IconRegion, TextRegion, ContainerRegion, Bbox } from "./types";

/**
 * Detect icon regions from the image, excluding known text areas.
 *
 * Strategy:
 * 1. Find small, high-contrast regions that don't overlap with text
 * 2. Check for colored background circles/squares behind icons
 * 3. Crop each icon from the reference image
 */
export async function detectIcons(
  imgBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
  textRegions: TextRegion[],
  containers: ContainerRegion[],
): Promise<IconRegion[]> {
  console.log(`[v2/icons] Detecting icons in ${imgWidth}x${imgHeight} image...`);

  // Step 1: Find small distinct regions using variance analysis
  // Scan the image in a grid of small cells and find high-variance non-text cells
  const cellSize = 40; // scan in 40x40px cells
  const candidates: Bbox[] = [];

  for (let y = 0; y < imgHeight - cellSize; y += Math.floor(cellSize / 2)) {
    for (let x = 0; x < imgWidth - cellSize; x += Math.floor(cellSize / 2)) {
      const bbox: Bbox = { x, y, w: cellSize, h: cellSize };

      // Skip if this region overlaps with text
      if (overlapsWithText(bbox, textRegions)) continue;

      // Check if this region has high variance (non-uniform = potential icon)
      try {
        const stats = await sharp(imgBuffer)
          .extract({ left: x, top: y, width: cellSize, height: cellSize })
          .stats();

        const avgVariance = stats.channels.reduce((s, c) => s + (c.stdev || 0), 0) / stats.channels.length;

        // High variance = potential icon region (not flat background)
        if (avgVariance > 20 && avgVariance < 100) {
          candidates.push(bbox);
        }
      } catch {
        continue;
      }
    }
  }

  console.log(`[v2/icons] Found ${candidates.length} icon candidates from grid scan`);

  // Step 2: Merge overlapping candidates into unified icon regions
  const merged = mergeCandidates(candidates);
  console.log(`[v2/icons] After merging: ${merged.length} icon regions`);

  // Step 3: Filter by aspect ratio (icons are roughly square) and size
  const filtered = merged.filter(bbox => {
    const aspect = bbox.w / bbox.h;
    return aspect >= 0.5 && aspect <= 2.0 && bbox.w <= 80 && bbox.h <= 80 && bbox.w >= 12 && bbox.h >= 12;
  });
  console.log(`[v2/icons] After aspect/size filter: ${filtered.length} icons`);

  // Step 4: Crop each icon and detect background color
  const icons: IconRegion[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const bbox = filtered[i];

    // Expand bbox slightly to capture the full icon with its background
    const padding = 4;
    const expandedBbox: Bbox = {
      x: Math.max(0, bbox.x - padding),
      y: Math.max(0, bbox.y - padding),
      w: Math.min(bbox.w + padding * 2, imgWidth - Math.max(0, bbox.x - padding)),
      h: Math.min(bbox.h + padding * 2, imgHeight - Math.max(0, bbox.y - padding)),
    };

    try {
      // Crop the icon from the reference image
      const cropped = await sharp(imgBuffer)
        .extract({
          left: Math.round(expandedBbox.x),
          top: Math.round(expandedBbox.y),
          width: Math.round(expandedBbox.w),
          height: Math.round(expandedBbox.h),
        })
        .png()
        .toBuffer();

      const imageData = cropped.toString("base64");

      // Detect background color by sampling corner pixels
      const bgColor = await detectBgColor(imgBuffer, expandedBbox, imgWidth, imgHeight);

      // Detect border radius by checking if the icon background is circular
      const borderRadius = await detectIconBorderRadius(imgBuffer, expandedBbox, imgWidth, imgHeight);

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
 * Check if a bbox overlaps with any text region.
 */
function overlapsWithText(bbox: Bbox, textRegions: TextRegion[]): boolean {
  for (const tr of textRegions) {
    const ox = Math.max(0, Math.min(bbox.x + bbox.w, tr.bbox.x + tr.bbox.w) - Math.max(bbox.x, tr.bbox.x));
    const oy = Math.max(0, Math.min(bbox.y + bbox.h, tr.bbox.y + tr.bbox.h) - Math.max(bbox.y, tr.bbox.y));
    const overlapArea = ox * oy;
    const bboxArea = bbox.w * bbox.h;
    if (overlapArea > bboxArea * 0.3) return true; // >30% overlap with text
  }
  return false;
}

/**
 * Merge overlapping candidate bboxes.
 */
function mergeCandidates(candidates: Bbox[]): Bbox[] {
  if (candidates.length === 0) return [];

  const merged: Bbox[] = [];
  const used = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue;

    let current = { ...candidates[i] };
    used.add(i);

    // Find all candidates that overlap with current
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < candidates.length; j++) {
        if (used.has(j)) continue;
        if (bboxTouches(current, candidates[j])) {
          // Merge
          const minX = Math.min(current.x, candidates[j].x);
          const minY = Math.min(current.y, candidates[j].y);
          const maxX = Math.max(current.x + current.w, candidates[j].x + candidates[j].w);
          const maxY = Math.max(current.y + current.h, candidates[j].y + candidates[j].h);
          current = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
          used.add(j);
          changed = true;
        }
      }
    }

    merged.push(current);
  }

  return merged;
}

function bboxTouches(a: Bbox, b: Bbox): boolean {
  return !(a.x + a.w < b.x - 2 || b.x + b.w < a.x - 2 ||
           a.y + a.h < b.y - 2 || b.y + b.h < a.y - 2);
}

/**
 * Detect background color around an icon by sampling corner pixels.
 */
async function detectBgColor(
  imgBuffer: Buffer,
  bbox: Bbox,
  imgW: number,
  imgH: number,
): Promise<string | undefined> {
  try {
    // Sample 4 corners + midpoints of each edge (8 points)
    const points = [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.w - 1, y: bbox.y },
      { x: bbox.x, y: bbox.y + bbox.h - 1 },
      { x: bbox.x + bbox.w - 1, y: bbox.y + bbox.h - 1 },
    ];

    const colors: string[] = [];
    for (const pt of points) {
      const px = Math.min(Math.max(Math.round(pt.x), 0), imgW - 1);
      const py = Math.min(Math.max(Math.round(pt.y), 0), imgH - 1);
      const pixel = await sharp(imgBuffer)
        .extract({ left: px, top: py, width: 1, height: 1 })
        .raw()
        .toBuffer();
      if (pixel.length >= 3) {
        colors.push(`#${pixel[0].toString(16).padStart(2, "0")}${pixel[1].toString(16).padStart(2, "0")}${pixel[2].toString(16).padStart(2, "0")}`);
      }
    }

    // If 3+ corners have the same color, that's the background
    const colorCounts = new Map<string, number>();
    for (const c of colors) {
      colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
    }
    for (const [color, count] of colorCounts) {
      if (count >= 3 && color !== "#ffffff" && color !== "#000000") {
        return color;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect if an icon has rounded corners (circle vs square background).
 */
async function detectIconBorderRadius(
  imgBuffer: Buffer,
  bbox: Bbox,
  imgW: number,
  imgH: number,
): Promise<number> {
  // Simple heuristic: if the icon is roughly square and has a uniform bg color,
  // check if the corner pixel differs from the center
  if (Math.abs(bbox.w - bbox.h) > bbox.w * 0.2) return 0;

  try {
    const cornerX = Math.min(Math.max(Math.round(bbox.x), 0), imgW - 1);
    const cornerY = Math.min(Math.max(Math.round(bbox.y), 0), imgH - 1);
    const centerX = Math.min(Math.max(Math.round(bbox.x + bbox.w / 2), 0), imgW - 1);
    const centerY = Math.min(Math.max(Math.round(bbox.y + bbox.h / 2), 0), imgH - 1);

    const cornerPx = await sharp(imgBuffer)
      .extract({ left: cornerX, top: cornerY, width: 1, height: 1 })
      .raw().toBuffer();
    const centerPx = await sharp(imgBuffer)
      .extract({ left: centerX, top: centerY, width: 1, height: 1 })
      .raw().toBuffer();

    if (cornerPx.length < 3 || centerPx.length < 3) return 0;

    const diff = Math.abs(cornerPx[0] - centerPx[0]) +
                 Math.abs(cornerPx[1] - centerPx[1]) +
                 Math.abs(cornerPx[2] - centerPx[2]);

    // If corner differs significantly from center, likely has rounded corners
    if (diff > 50) {
      // If roughly square, likely a circle (50% radius)
      if (Math.abs(bbox.w - bbox.h) < 4) {
        return Math.round(bbox.w / 2);
      }
      return 8; // default rounded square
    }

    return 0;
  } catch {
    return 0;
  }
}
