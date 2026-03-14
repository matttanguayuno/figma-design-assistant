/**
 * V2 Pipeline Orchestrator — Main entry point
 *
 * Decodes base64 screenshot → runs OCR, edge detection, icon detection
 * in parallel → merges into scene graph → builds Figma snapshot.
 */

import sharp from "sharp";
import { extractText } from "./ocr";
import { parseContainers } from "./parseScreenshot";
import { detectIcons } from "./icons";
import { buildSnapshot } from "./buildSnapshot";
import type { SceneGraph, SnapshotNode } from "./types";

export interface ReconstructResult {
  snapshot: SnapshotNode;
  stats: {
    textRegions: number;
    containers: number;
    icons: number;
    durationMs: number;
  };
}

/**
 * Run the full V2 reconstruction pipeline.
 *
 * @param referenceImageBase64 - The screenshot as a base64-encoded PNG/JPEG
 * @returns The Figma-compatible snapshot and diagnostic stats
 */
export async function reconstruct(
  referenceImageBase64: string,
): Promise<ReconstructResult> {
  const start = Date.now();

  console.log("[v2] Starting reconstruction pipeline...");

  // Step 1: Decode image and get metadata
  const imgBuffer = Buffer.from(referenceImageBase64, "base64");
  const metadata = await sharp(imgBuffer).metadata();
  const imgWidth = metadata.width!;
  const imgHeight = metadata.height!;

  console.log(`[v2] Image: ${imgWidth}x${imgHeight}`);

  // Step 2: Run OCR and edge detection in parallel
  // sharp handles PNG/JPEG/WebP natively — no conversion needed
  const [texts, containers] = await Promise.all([
    extractText(imgBuffer, imgWidth, imgHeight),
    parseContainers(imgBuffer, imgWidth, imgHeight),
  ]);

  console.log(`[v2] OCR found ${texts.length} text regions`);
  console.log(`[v2] Parser found ${containers.length} top-level containers`);

  // Step 3: Detect icons (needs text regions to avoid overlap)
  const icons = await detectIcons(imgBuffer, imgWidth, imgHeight, texts, containers);
  console.log(`[v2] Detected ${icons.length} icons`);

  // Step 4: Assemble scene graph
  const scene: SceneGraph = {
    viewport: { width: imgWidth, height: imgHeight },
    texts,
    containers,
    icons,
  };

  // Step 5: Build the Figma snapshot tree
  const snapshot = buildSnapshot(scene);

  const durationMs = Date.now() - start;
  console.log(`[v2] Pipeline complete in ${durationMs}ms`);

  return {
    snapshot,
    stats: {
      textRegions: texts.length,
      containers: containers.length,
      icons: icons.length,
      durationMs,
    },
  };
}
