/**
 * V2 Pipeline Orchestrator — LLM Vision-based screenshot reconstruction
 *
 * Sends the screenshot to an LLM vision model, asks it to describe the UI
 * as a structured JSON scene graph (containers, text, icons), then builds
 * a Figma snapshot from the result.
 *
 * This replaces the pure-CV approach (edge detection + Tesseract OCR) which
 * produced near-zero useful output on real UI screenshots.
 */

import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildSnapshot } from "./buildSnapshot";
import type { SceneGraph, SnapshotNode, TextRegion, ContainerRegion, IconRegion } from "./types";

export type Provider = "anthropic" | "openai" | "gemini";

export interface ReconstructResult {
  snapshot: SnapshotNode;
  stats: {
    textRegions: number;
    containers: number;
    icons: number;
    durationMs: number;
  };
}

// ── LLM Vision Prompt ───────────────────────────────────────────────

const VISION_SYSTEM_PROMPT = `You are a UI layout analysis expert. Given a screenshot of a user interface, you must describe EVERY visible element as structured JSON.

Your output must be a single JSON object with this exact schema:

{
  "containers": [
    {
      "id": "unique-id",
      "x": <number>,
      "y": <number>,
      "w": <number>,
      "h": <number>,
      "fillColor": "#hexcolor",
      "cornerRadius": <number 0-20>,
      "strokeColor": "#hexcolor or null",
      "strokeWeight": <number or null>,
      "hasShadow": <boolean>,
      "children": [ ...nested containers... ]
    }
  ],
  "texts": [
    {
      "text": "exact visible text",
      "x": <number>,
      "y": <number>,
      "w": <number>,
      "h": <number>,
      "fontSize": <number>,
      "fontWeight": <100|200|300|400|500|600|700|800|900>,
      "fillColor": "#hexcolor",
      "textAlign": "LEFT" | "CENTER" | "RIGHT"
    }
  ],
  "icons": [
    {
      "id": "icon-descriptive-name",
      "x": <number>,
      "y": <number>,
      "w": <number>,
      "h": <number>,
      "description": "brief description of the icon"
    }
  ]
}

CRITICAL RULES:
1. ALL coordinates (x, y, w, h) are in PIXELS relative to the top-left corner of the image.
2. The image dimensions will be provided. Use the FULL coordinate space.
3. Be PRECISE with coordinates — estimate pixel positions as accurately as possible.
4. Extract EVERY piece of visible text, no matter how small. Include button labels, nav items, headings, body text, captions, etc.
5. Identify ALL rectangular regions: sidebars, headers, cards, panels, modals, buttons, input fields, navigation bars, footers.
6. Containers should be hierarchical — nest child containers inside parent containers.
7. For fillColor, sample the DOMINANT color of the region. Use exact hex values.
8. Identify icons, logos, avatars, and image placeholders. Give each a descriptive id.
9. Do NOT include containers for the overall page background unless it's a distinct color from white.
10. For text, estimate fontSize in pixels based on visual size. Common sizes: 12-14 for body, 16-20 for subheadings, 24-48 for headings.
11. Output ONLY the JSON object — no markdown fences, no explanation.`;

function buildUserPrompt(width: number, height: number): string {
  return `Analyze this UI screenshot. The image dimensions are ${width}x${height} pixels. Describe every visible UI element (containers, text, icons) with precise pixel coordinates. Output ONLY the JSON object.`;
}

// ── LLM Vision Call ─────────────────────────────────────────────────

async function callVisionLLM(
  imageBase64: string,
  width: number,
  height: number,
  apiKey: string,
  provider: Provider,
  model?: string,
): Promise<string> {
  const userPrompt = buildUserPrompt(width, height);

  switch (provider) {
    case "anthropic": {
      const resolvedModel = model || "claude-sonnet-4-20250514";
      const client = new Anthropic({ apiKey });
      const message = await client.messages.create({
        model: resolvedModel,
        max_tokens: 16384,
        system: VISION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: imageBase64,
                },
              },
              { type: "text", text: userPrompt },
            ],
          },
        ],
      });
      const textBlock = message.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") throw new Error("No text in response");
      return textBlock.text.trim();
    }

    case "openai": {
      const resolvedModel = model || "gpt-4o";
      const client = new OpenAI({ apiKey });
      const resp = await client.chat.completions.create({
        model: resolvedModel,
        max_tokens: 16384,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${imageBase64}`,
                  detail: "high",
                },
              },
              { type: "text", text: userPrompt },
            ],
          },
        ],
      });
      return resp.choices[0]?.message?.content?.trim() || "";
    }

    case "gemini": {
      const resolvedModel = model || "gemini-2.5-flash";
      const client = new GoogleGenerativeAI(apiKey);
      const genModel = client.getGenerativeModel({ model: resolvedModel });
      const result = await genModel.generateContent([
        { text: VISION_SYSTEM_PROMPT + "\n\n" + userPrompt },
        {
          inlineData: {
            mimeType: "image/png",
            data: imageBase64,
          },
        },
      ]);
      return result.response.text().trim();
    }

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── JSON Parsing ────────────────────────────────────────────────────

interface RawContainer {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fillColor?: string;
  cornerRadius?: number;
  strokeColor?: string | null;
  strokeWeight?: number | null;
  hasShadow?: boolean;
  children?: RawContainer[];
}

interface RawText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize?: number;
  fontWeight?: number;
  fillColor?: string;
  textAlign?: string;
}

interface RawIcon {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  description?: string;
}

interface RawSceneGraph {
  containers?: RawContainer[];
  texts?: RawText[];
  icons?: RawIcon[];
}

function extractJSON(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  else if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

function repairTruncatedJSON(input: string): any {
  let s = input.trim();
  try { return JSON.parse(s); } catch {}

  s = s.replace(/,\s*$/, "");

  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  if (inString) s += '"';
  s = s.replace(/,\s*"[^"]*"?\s*:?\s*$/, "");
  s = s.replace(/,\s*$/, "");
  while (stack.length > 0) s += stack.pop();

  try {
    return JSON.parse(s);
  } catch (err: any) {
    throw new Error(`Failed to parse LLM vision output as JSON: ${err.message}`);
  }
}

// ── Scene Graph Conversion ──────────────────────────────────────────

function convertContainer(raw: RawContainer): ContainerRegion {
  return {
    id: raw.id || `container-${Math.random().toString(36).slice(2, 8)}`,
    bbox: { x: raw.x, y: raw.y, w: raw.w, h: raw.h },
    fillColor: raw.fillColor || "#ffffff",
    cornerRadius: raw.cornerRadius || 0,
    strokeColor: raw.strokeColor || undefined,
    strokeWeight: raw.strokeWeight || undefined,
    shadow: raw.hasShadow ? { offsetX: 0, offsetY: 2, blur: 8, color: "#00000026" } : undefined,
    confidence: 90,
    children: (raw.children || []).map(convertContainer),
  };
}

function convertText(raw: RawText): TextRegion {
  return {
    text: raw.text,
    bbox: { x: raw.x, y: raw.y, w: raw.w, h: raw.h },
    fontSize: raw.fontSize || 14,
    fontWeight: raw.fontWeight || 400,
    fillColor: raw.fillColor || "#000000",
    confidence: 90,
    textAlign: (raw.textAlign as TextRegion["textAlign"]) || "LEFT",
  };
}

// ── Icon Cropping ───────────────────────────────────────────────────

async function cropIcons(
  rawIcons: RawIcon[],
  imgBuffer: Buffer,
  imgWidth: number,
  imgHeight: number,
): Promise<IconRegion[]> {
  const icons: IconRegion[] = [];

  for (const raw of rawIcons) {
    const x = Math.max(0, Math.min(Math.round(raw.x), imgWidth - 1));
    const y = Math.max(0, Math.min(Math.round(raw.y), imgHeight - 1));
    const w = Math.min(Math.max(Math.round(raw.w), 4), imgWidth - x);
    const h = Math.min(Math.max(Math.round(raw.h), 4), imgHeight - y);

    try {
      const cropped = await sharp(imgBuffer)
        .extract({ left: x, top: y, width: w, height: h })
        .png()
        .toBuffer();

      icons.push({
        id: raw.id || `icon-${icons.length}`,
        bbox: { x, y, w, h },
        imageData: cropped.toString("base64"),
        borderRadius: 0,
        confidence: 85,
      });
    } catch {
      // Skip failed crops
    }
  }

  return icons;
}

// ── Main Entry Point ────────────────────────────────────────────────

/**
 * Run the full V2 reconstruction pipeline using LLM vision.
 */
export async function reconstruct(
  referenceImageBase64: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
): Promise<ReconstructResult> {
  const start = Date.now();

  console.log("[v2] Starting LLM vision reconstruction pipeline...");

  // Step 1: Decode image and get metadata
  const imgBuffer = Buffer.from(referenceImageBase64, "base64");

  // Ensure PNG format for consistent LLM input
  const pngBuffer = await sharp(imgBuffer).png().toBuffer();
  const pngBase64 = pngBuffer.toString("base64");

  const metadata = await sharp(imgBuffer).metadata();
  const imgWidth = metadata.width!;
  const imgHeight = metadata.height!;

  console.log(`[v2] Image: ${imgWidth}x${imgHeight}, provider: ${provider}, model: ${model || "default"}`);

  // Step 2: Call LLM vision to analyze the screenshot
  console.log("[v2] Calling LLM vision...");
  const rawResponse = await callVisionLLM(pngBase64, imgWidth, imgHeight, apiKey, provider, model);
  console.log(`[v2] LLM response: ${rawResponse.length} chars`);

  // Step 3: Parse the JSON response
  const jsonStr = extractJSON(rawResponse);
  let parsed: RawSceneGraph;
  try {
    parsed = repairTruncatedJSON(jsonStr);
  } catch (err: any) {
    console.error("[v2] Failed to parse LLM response:", err.message);
    console.error("[v2] Raw response (first 500 chars):", rawResponse.substring(0, 500));
    throw new Error(`LLM returned unparseable response: ${err.message}`);
  }

  const rawContainers = parsed.containers || [];
  const rawTexts = parsed.texts || [];
  const rawIcons = parsed.icons || [];

  console.log(`[v2] Parsed: ${rawContainers.length} containers, ${rawTexts.length} texts, ${rawIcons.length} icons`);

  // Step 4: Convert to typed scene graph
  const containers = rawContainers.map(convertContainer);
  const texts = rawTexts.map(convertText);

  // Step 5: Crop icons from the original image at LLM-identified locations
  const icons = await cropIcons(rawIcons, imgBuffer, imgWidth, imgHeight);
  console.log(`[v2] Cropped ${icons.length} icons from original image`);

  // Step 6: Assemble scene graph
  const scene: SceneGraph = {
    viewport: { width: imgWidth, height: imgHeight },
    texts,
    containers,
    icons,
  };

  // Step 7: Build the Figma snapshot tree
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
