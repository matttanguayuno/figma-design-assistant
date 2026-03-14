/**
 * V2 OCR Module — Tesseract.js text extraction
 *
 * Extracts text regions with exact bounding boxes from a screenshot.
 * Groups words into lines, estimates font properties, samples colors.
 */

import Tesseract from "tesseract.js";
import sharp from "sharp";
import type { TextRegion, Bbox } from "./types";

interface WordInfo {
  text: string;
  bbox: Bbox;
  confidence: number;
  lineNum: number;    // Tesseract's line number
  blockNum: number;
  parNum: number;
}

/**
 * Run OCR on a screenshot buffer and return text regions.
 */
export async function extractText(
  imgBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
): Promise<TextRegion[]> {
  console.log(`[v2/ocr] Starting OCR on ${imgWidth}x${imgHeight} image...`);

  const result = await Tesseract.recognize(imgBuffer, "eng", {
    logger: (m: any) => {
      if (m.status === "recognizing text") {
        const pct = Math.round((m.progress || 0) * 100);
        if (pct % 25 === 0) console.log(`[v2/ocr] Progress: ${pct}%`);
      }
    },
  });

  const words: WordInfo[] = [];
  for (const block of result.data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (!word.text || word.text.trim().length === 0) continue;
          if (word.confidence < 30) continue; // skip very low confidence
          words.push({
            text: word.text,
            bbox: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              w: word.bbox.x1 - word.bbox.x0,
              h: word.bbox.y1 - word.bbox.y0,
            },
            confidence: word.confidence,
            lineNum: (line as any).line_num ?? 0,
            blockNum: (block as any).block_num ?? 0,
            parNum: (paragraph as any).par_num ?? 0,
          });
        }
      }
    }
  }

  console.log(`[v2/ocr] Found ${words.length} words`);

  // Group words into lines by vertical proximity
  const lines = groupWordsIntoLines(words);
  console.log(`[v2/ocr] Grouped into ${lines.length} text lines`);

  // Merge lines into text blocks by proximity
  const blocks = mergeLinesToBlocks(lines);
  console.log(`[v2/ocr] Merged into ${blocks.length} text blocks`);

  // Sample colors for each text region from the original image
  const regions = await addColorInfo(blocks, imgBuffer, imgWidth, imgHeight);

  console.log(`[v2/ocr] Final: ${regions.length} text regions`);
  return regions;
}

interface TextLine {
  text: string;
  bbox: Bbox;
  confidence: number;
  wordCount: number;
}

/**
 * Group words into lines based on vertical overlap.
 */
function groupWordsIntoLines(words: WordInfo[]): TextLine[] {
  if (words.length === 0) return [];

  // Sort words by y position, then x
  const sorted = [...words].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  const lines: TextLine[] = [];
  let currentLine: WordInfo[] = [sorted[0]];
  let currentY = sorted[0].bbox.y;
  let currentH = sorted[0].bbox.h;

  for (let i = 1; i < sorted.length; i++) {
    const word = sorted[i];
    // Words are on the same line if they vertically overlap significantly
    const overlapThreshold = currentH * 0.5;
    if (Math.abs(word.bbox.y - currentY) < overlapThreshold) {
      currentLine.push(word);
    } else {
      lines.push(buildLine(currentLine));
      currentLine = [word];
      currentY = word.bbox.y;
      currentH = word.bbox.h;
    }
  }
  if (currentLine.length > 0) {
    lines.push(buildLine(currentLine));
  }

  return lines;
}

function buildLine(words: WordInfo[]): TextLine {
  // Sort left to right
  words.sort((a, b) => a.bbox.x - b.bbox.x);

  const minX = Math.min(...words.map(w => w.bbox.x));
  const minY = Math.min(...words.map(w => w.bbox.y));
  const maxX = Math.max(...words.map(w => w.bbox.x + w.bbox.w));
  const maxY = Math.max(...words.map(w => w.bbox.y + w.bbox.h));
  const avgConf = words.reduce((s, w) => s + w.confidence, 0) / words.length;

  return {
    text: words.map(w => w.text).join(" "),
    bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    confidence: avgConf,
    wordCount: words.length,
  };
}

/**
 * Merge adjacent lines into multi-line text blocks if they're close vertically
 * and have similar x alignment.
 */
function mergeLinesToBlocks(lines: TextLine[]): TextLine[] {
  if (lines.length === 0) return [];

  // Sort by y position
  const sorted = [...lines].sort((a, b) => a.bbox.y - b.bbox.y);
  const blocks: TextLine[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const vertGap = next.bbox.y - (current.bbox.y + current.bbox.h);
    const lineHeight = current.bbox.h;

    // Merge if: lines are close (gap < 0.8 * lineHeight) AND horizontally aligned
    const xOverlap = Math.abs(next.bbox.x - current.bbox.x) < current.bbox.w * 0.3;
    const closeVertically = vertGap >= 0 && vertGap < lineHeight * 0.8;

    if (closeVertically && xOverlap) {
      // Merge into current block
      const minX = Math.min(current.bbox.x, next.bbox.x);
      const minY = current.bbox.y;
      const maxX = Math.max(current.bbox.x + current.bbox.w, next.bbox.x + next.bbox.w);
      const maxY = next.bbox.y + next.bbox.h;
      current = {
        text: current.text + "\n" + next.text,
        bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
        confidence: (current.confidence + next.confidence) / 2,
        wordCount: current.wordCount + next.wordCount,
      };
    } else {
      blocks.push(current);
      current = next;
    }
  }
  blocks.push(current);

  return blocks;
}

/**
 * Sample text color from the image at each text region's center.
 */
async function addColorInfo(
  blocks: TextLine[],
  imgBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
): Promise<TextRegion[]> {
  const regions: TextRegion[] = [];

  // Extract raw RGB once for color sampling
  let rawBuf: Buffer;
  let channels = 3;
  try {
    const raw = await sharp(imgBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    rawBuf = raw.data;
    channels = raw.info.channels;
  } catch {
    // Fallback: return all black text colors
    rawBuf = Buffer.alloc(0);
  }

  for (const block of blocks) {
    const cx = Math.min(Math.max(Math.round(block.bbox.x + block.bbox.w / 2), 0), imgWidth - 1);
    const cy = Math.min(Math.max(Math.round(block.bbox.y + block.bbox.h / 2), 0), imgHeight - 1);

    let fillColor = "#000000";
    if (rawBuf.length > 0) {
      const idx = (cy * imgWidth + cx) * channels;
      if (idx + 2 < rawBuf.length) {
        fillColor = `#${rawBuf[idx].toString(16).padStart(2, "0")}${rawBuf[idx + 1].toString(16).padStart(2, "0")}${rawBuf[idx + 2].toString(16).padStart(2, "0")}`;
      }
    }

    // Estimate font size from line height
    const lineCount = block.text.split("\n").length;
    const fontSize = Math.round(block.bbox.h / lineCount * 0.75); // approximate px-to-pt

    // Estimate font weight from text characteristics
    // (simple heuristic: larger text or bold-looking text gets higher weight)
    const fontWeight = fontSize >= 24 ? 700 : fontSize >= 18 ? 600 : 400;

    regions.push({
      text: block.text,
      bbox: block.bbox,
      fontSize: Math.max(fontSize, 8), // minimum 8px
      fontWeight,
      fillColor,
      confidence: block.confidence,
      lineHeight: block.bbox.h / lineCount,
    });
  }

  return regions;
}
