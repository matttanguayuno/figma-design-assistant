// backend/llm.ts
// Multi-provider LLM wrapper — supports Anthropic, OpenAI, and Google Gemini.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import sharp from "sharp";
import { SYSTEM_PROMPT, buildUserPrompt, GENERATE_SYSTEM_PROMPT, GENERATE_WITH_REFERENCE_SYSTEM_PROMPT, GENERATE_COMPONENT_SYSTEM_PROMPT, buildGeneratePrompt, buildReferenceImagePrompt, buildGenerateComponentPrompt, GENERATE_HTML_SYSTEM_PROMPT, ANALYZE_REFERENCE_IMAGE_SYSTEM_PROMPT, GENERATE_HTML_FROM_BLUEPRINT_SYSTEM_PROMPT, buildGenerateHTMLPrompt, BIND_DS_SYSTEM_PROMPT, buildDSBindingPrompt, PLAN_SYSTEM_PROMPT, buildPlanPrompt, REFINE_SYSTEM_PROMPT, buildRefinePrompt, IDENTIFY_REGIONS_SYSTEM_PROMPT, EXTRACT_REGION_DETAIL_SYSTEM_PROMPT, EXTRACT_TEXT_OVERLAY_SYSTEM_PROMPT, MULTIPASS_STRUCTURE_PROMPT, MULTIPASS_TEXT_PROMPT, MULTIPASS_VISUALS_PROMPT } from "./promptBuilder";

// ── Provider / Model Configuration ──────────────────────────────────

export type Provider = "anthropic" | "openai" | "gemini";

export interface ModelInfo {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<Provider, ModelInfo[]> = {
  anthropic: [
    { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { id: "claude-haiku-4-20250414", label: "Claude Haiku 4" },
  ],
  openai: [
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "o3-mini", label: "o3-mini" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

// Max output tokens per model (used to cap max_tokens requests)
const MODEL_MAX_OUTPUT: Record<string, number> = {
  "gpt-4o": 16384,
  "gpt-4o-mini": 16384,
  "gpt-4.1": 32768,
  "gpt-4.1-mini": 32768,
  "gpt-4.1-nano": 32768,
  "o3-mini": 65536,
};

/**
 * Attempt to repair truncated JSON from LLM output.
 * Closes open strings, arrays, and objects to produce valid JSON.
 */
function repairTruncatedJSON(input: string): any {
  let s = input.trim();
  // Try as-is first
  try { return JSON.parse(s); } catch {}

  // Remove trailing comma
  s = s.replace(/,\s*$/, '');

  // Track state to close open brackets
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // If we're inside a string, close it
  if (inString) s += '"';
  // Remove trailing partial key-value or comma
  s = s.replace(/,\s*"[^"]*"?\s*:?\s*$/, '');
  s = s.replace(/,\s*$/, '');
  // Close remaining open brackets in reverse order
  while (stack.length > 0) s += stack.pop();

  try {
    const result = JSON.parse(s);
    console.log(`[repairTruncatedJSON] Successfully repaired truncated JSON`);
    return result;
  } catch (repairErr: any) {
    throw new Error(`Layout tree JSON is truncated and could not be repaired. The LLM ran out of output tokens. Try a simpler screenshot or a model with higher output limits. (${repairErr.message})`);
  }
}

function capMaxTokens(provider: Provider, requested: number, model?: string): number {
  if (model && MODEL_MAX_OUTPUT[model]) {
    return Math.min(requested, MODEL_MAX_OUTPUT[model]);
  }
  // Conservative defaults per provider
  const providerDefaults: Record<Provider, number> = { anthropic: 32768, openai: 16384, gemini: 65536 };
  return Math.min(requested, providerDefaults[provider] || 16384);
}

// ── Client caches (keyed by "provider:apiKey") ──────────────────────

const _anthropicCache = new Map<string, Anthropic>();
const _openaiCache = new Map<string, OpenAI>();
const _geminiCache = new Map<string, GoogleGenerativeAI>();

function getAnthropicClient(apiKey: string): Anthropic {
  let client = _anthropicCache.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    _anthropicCache.set(apiKey, client);
  }
  return client;
}

function getOpenAIClient(apiKey: string): OpenAI {
  let client = _openaiCache.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey });
    _openaiCache.set(apiKey, client);
  }
  return client;
}

function getGeminiClient(apiKey: string): GoogleGenerativeAI {
  let client = _geminiCache.get(apiKey);
  if (!client) {
    client = new GoogleGenerativeAI(apiKey);
    _geminiCache.set(apiKey, client);
  }
  return client;
}

// ── Active request cancellation ─────────────────────────────────────

let _activeAbort: AbortController | null = null;

/** Abort the in-flight LLM request (if any). */
export function cancelCurrentRequest(): void {
  if (_activeAbort) {
    console.log("[llm] Aborting in-flight request");
    _activeAbort.abort();
    _activeAbort = null;
  }
}

// ── Types matching what the plugin sends ────────────────────────────

interface SelectionSnapshot {
  nodes: {
    id: string;
    name: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    layoutMode?: string;
    appliedTextStyleId?: string;
    appliedFillStyleId?: string;
    characters?: string;
    childrenCount: number;
    children?: SelectionSnapshot["nodes"];
  }[];
}

interface DesignSystemSnapshot {
  textStyles: { id: string; name: string }[];
  fillStyles: { id: string; name: string }[];
  components: { key: string; name: string }[];
  variables: { id: string; name: string }[];
}

// ── JSON response parser (shared across providers) ──────────────────

function parseJsonResponse(raw: string, label: string): unknown {
  console.log(`[${label}] Raw response: ${raw.slice(0, 500)}`);
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}…`);
  }
}

// ── Anthropic implementation ────────────────────────────────────────

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController,
  temperature?: number
): Promise<string> {
  const client = getAnthropicClient(apiKey);
  // Use streaming to avoid Anthropic's "Streaming is required for long requests" error
  const streamParams: any = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (typeof temperature === "number") streamParams.temperature = temperature;
  const stream = client.messages.stream(
    streamParams,
    { signal: abort.signal as any }
  );
  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic returned no text content");
  }
  return textBlock.text.trim();
}

// ── OpenAI implementation ───────────────────────────────────────────

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController,
  jsonMode: boolean = true,
  temperature?: number
): Promise<string> {
  const client = getOpenAIClient(apiKey);
  const params: any = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  if (typeof temperature === "number") params.temperature = temperature;
  if (jsonMode) {
    params.response_format = { type: "json_object" };
  }
  const completion = await client.chat.completions.create(
    params,
    { signal: abort.signal as any }
  );
  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI returned no text content");
  }
  return text.trim();
}

// ── Gemini implementation ───────────────────────────────────────────

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  _maxTokens: number,
  apiKey: string,
  abort: AbortController,
  jsonMode: boolean = true,
  temperature?: number
): Promise<string> {
  const client = getGeminiClient(apiKey);
  const genConfig: any = {};
  if (jsonMode) {
    genConfig.responseMimeType = "application/json";
  }
  if (typeof temperature === "number") genConfig.temperature = temperature;
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: genConfig,
  });
  const result = await genModel.generateContent(
    { contents: [{ role: "user", parts: [{ text: userPrompt }] }] },
    { signal: abort.signal as any }
  );
  const text = result.response.text();
  if (!text) {
    throw new Error("Gemini returned no text content");
  }
  return text.trim();
}

// ── Provider dispatcher ─────────────────────────────────────────────

async function callProvider(
  provider: Provider,
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController,
  jsonMode: boolean = true,
  temperature?: number
): Promise<string> {
  switch (provider) {
    case "anthropic":
      return callAnthropic(systemPrompt, userPrompt, model, maxTokens, apiKey, abort, temperature);
    case "openai":
      return callOpenAI(systemPrompt, userPrompt, model, maxTokens, apiKey, abort, jsonMode, temperature);
    case "gemini":
      return callGemini(systemPrompt, userPrompt, model, maxTokens, apiKey, abort, jsonMode, temperature);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Call LLM (plan / edit) ──────────────────────────────────────────

export async function callLLM(
  intent: string,
  selection: SelectionSnapshot,
  designSystem: DesignSystemSnapshot,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  fullDesignSystem?: any
): Promise<unknown> {
  const userPrompt = buildUserPrompt(intent, selection, designSystem, fullDesignSystem);
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, SYSTEM_PROMPT, userPrompt, resolvedModel, 8192, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm");
}

// ── Call LLM for free-form analysis (no operations system prompt) ───

export async function callLLMAnalyze(
  prompt: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  imageBase64?: string,
  mode: string = "fix"
): Promise<unknown> {
  let systemPrompt: string;
  let returnRaw = false;

  if (mode === "visualReview") {
    // Pure visual analysis — return plain text problem list, not JSON
    systemPrompt =
      "You are a senior UI/UX design reviewer. Examine the screenshot carefully and list every visual layout problem you can see. " +
      "Be specific and concrete — describe exactly what is wrong and where. Focus on: text cropping/clipping, excessive whitespace, " +
      "overflow/clipping, inconsistent spacing between similar items, inconsistent padding within similar items, misalignment, " +
      "content jammed against edges, and elements that are obviously the wrong size. " +
      "Return a numbered list. Be thorough — list EVERY problem, even minor ones. Do NOT suggest fixes, just describe what you see.";
    returnRaw = true;
  } else if (mode === "extract") {
    // Free-form extraction — system prompt just asks for valid JSON matching the user prompt's schema
    systemPrompt =
      "You are a precise data extraction assistant. You MUST return ONLY valid JSON — no markdown fences, no prose, no explanation. " +
      "Extract exactly the fields requested in the user's prompt and return them as a JSON object.";
  } else if (mode === "verify") {
    // Verification pass — skeptically check if problems remain, return fixes or empty
    systemPrompt =
      "You are a CRITICAL design QA inspector. You MUST return ONLY valid JSON — no markdown fences, no prose, no explanation. " +
      "IMPORTANT: Always return a JSON object with a single key \"frames\" whose value is an array: {\"frames\": [...]}. " +
      "A screenshot of the current state is provided. CAREFULLY examine every pixel of the screenshot. " +
      "Be SKEPTICAL — assume there ARE remaining problems until you have checked every item below. " +
      "Check ALL of the following systematically: " +
      "1) Text overlapping other text or elements. " +
      "2) Elements touching or jammed against container edges with no margin. " +
      "3) Excessive gaps (>40px) between sections that should be closer. " +
      "4) Content clipped, cropped, or overflowing its container. " +
      "5) Buttons that are too tall (>60px) or too wide (stretching full width when they shouldn't). " +
      "6) Inconsistent padding — similar containers should have similar padding. " +
      "7) Elements that are obviously misaligned with their siblings. " +
      "8) Sections with clearly wrong proportions. " +
      "Only return {\"frames\": []} if you have checked ALL 8 items above and found ZERO problems. " +
      "If you find ANY problem, return the specific fixes needed. Trust the screenshot over the frame data.";
  } else {
    // Default fix mode — return JSON fixes
    systemPrompt =
      "You are a design layout analyzer. You MUST return ONLY valid JSON — no markdown fences, no prose, no explanation. " +
      "IMPORTANT: Always return a JSON object with a single key \"frames\" whose value is an array: {\"frames\": [...]}. " +
      "Include ALL items that need changes in the array. Even if only one item needs changes, wrap it: {\"frames\": [{...}]}. " +
      "Never return a bare array or a single unwrapped object." +
      (imageBase64 ? " A screenshot of the frame is provided. Use it to identify visual layout problems like misaligned elements, inconsistent spacing, content flush against edges, or elements that look cramped." : "");
  }

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  const jsonMode = !returnRaw; // visualReview mode = no JSON format constraint
  let raw: string;
  try {
    if (imageBase64) {
      raw = await callProviderWithImage(provider, systemPrompt, prompt, imageBase64, resolvedModel, 8192, apiKey, abort, jsonMode);
    } else {
      raw = await callProvider(provider, systemPrompt, prompt, resolvedModel, 8192, apiKey, abort, jsonMode);
    }
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  // For visual review mode, return the raw text wrapped in an object
  if (returnRaw) {
    return { text: raw };
  }

  return parseJsonResponse(raw, "analyze");
}

// ── Vision-capable provider calls ───────────────────────────────────

async function callProviderWithImage(
  provider: Provider,
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController,
  jsonMode: boolean = true
): Promise<string> {
  switch (provider) {
    case "anthropic":
      return callAnthropicWithImage(systemPrompt, userPrompt, imageBase64, model, maxTokens, apiKey, abort);
    case "openai":
      return callOpenAIWithImage(systemPrompt, userPrompt, imageBase64, model, maxTokens, apiKey, abort, jsonMode);
    case "gemini":
      return callGeminiWithImage(systemPrompt, userPrompt, imageBase64, model, maxTokens, apiKey, abort, jsonMode);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function callAnthropicWithImage(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController
): Promise<string> {
  const client = getAnthropicClient(apiKey);
  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
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
            {
              type: "text",
              text: userPrompt,
            },
          ],
        },
      ],
    },
    { signal: abort.signal as any }
  );
  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Anthropic returned no text content");
  }
  return textBlock.text.trim();
}

async function callOpenAIWithImage(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController,
  jsonMode: boolean = true
): Promise<string> {
  const client = getOpenAIClient(apiKey);
  const params: any = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
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
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ],
  };
  if (jsonMode) {
    params.response_format = { type: "json_object" };
  }
  const completion = await client.chat.completions.create(
    params,
    { signal: abort.signal as any }
  );
  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI returned no text content");
  }
  return text.trim();
}

async function callGeminiWithImage(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  model: string,
  _maxTokens: number,
  apiKey: string,
  abort: AbortController,
  jsonMode: boolean = true
): Promise<string> {
  const client = getGeminiClient(apiKey);
  const genConfig: any = {};
  if (jsonMode) {
    genConfig.responseMimeType = "application/json";
  }
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: genConfig,
  });
  const result = await genModel.generateContent(
    {
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: imageBase64,
              },
            },
            { text: userPrompt },
          ],
        },
      ],
    },
    { signal: abort.signal as any }
  );
  const text = result.response.text();
  if (!text) {
    throw new Error("Gemini returned no text content");
  }
  return text.trim();
}

// ── Call LLM for Frame Generation ───────────────────────────────────

export async function callLLMGenerate(
  prompt: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  selection?: any,
  fullDesignSystem?: any,
  dsSummary?: any,
  layoutPlan?: any,
  isComponentGeneration?: boolean,
  referenceImageBase64?: string
): Promise<unknown> {
  // Use reference-image-specific prompt when a reference image is attached (removes competing generic templates).
  // Use component-specific prompt when generating component sets from scratch.
  // Otherwise use the standard generation prompt.
  const systemPrompt = referenceImageBase64
    ? GENERATE_WITH_REFERENCE_SYSTEM_PROMPT
    : (isComponentGeneration ? GENERATE_COMPONENT_SYSTEM_PROMPT : GENERATE_SYSTEM_PROMPT);

  // When a reference image is attached, use a LIGHTWEIGHT user prompt that contains only
  // the user request + DS colors/typography. This prevents the model from being overwhelmed
  // by 200K+ chars of selected frame tree, reference snapshots, and full design system JSON
  // which drown out the visual instruction to follow the reference image.
  let finalUserPrompt: string;
  if (referenceImageBase64) {
    finalUserPrompt = buildReferenceImagePrompt(prompt, dsSummary, designSystem);
  } else if (isComponentGeneration) {
    finalUserPrompt = buildGenerateComponentPrompt(prompt, designSystem, fullDesignSystem, dsSummary);
  } else {
    finalUserPrompt = buildGeneratePrompt(prompt, styleTokens, designSystem, selection, fullDesignSystem, dsSummary, layoutPlan);
  }

  console.log(`[callLLMGenerate] isComponent=${!!isComponentGeneration}, System prompt: ${systemPrompt.length} chars, User prompt: ${finalUserPrompt.length} chars, TOTAL: ${systemPrompt.length + finalUserPrompt.length} chars (~${Math.round((systemPrompt.length + finalUserPrompt.length)/4)} tokens)${referenceImageBase64 ? `, refImage: ${referenceImageBase64.length} chars` : ""}`);

  // Hard safety: if the user prompt exceeds ~500K chars (~125K tokens), truncate it
  const MAX_USER_PROMPT_CHARS = 500000;
  let safeUserPrompt = finalUserPrompt;
  if (finalUserPrompt.length > MAX_USER_PROMPT_CHARS) {
    console.warn(`[callLLMGenerate] User prompt too long (${finalUserPrompt.length} chars), truncating to ${MAX_USER_PROMPT_CHARS}`);
    safeUserPrompt = finalUserPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "\n\n[PROMPT TRUNCATED — generate based on the content above]";
  }

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    if (referenceImageBase64) {
      raw = await callProviderWithImage(provider, systemPrompt, safeUserPrompt, referenceImageBase64, resolvedModel, capMaxTokens(provider, 32768, resolvedModel), apiKey, abort, true);
    } else {
      raw = await callProvider(provider, systemPrompt, safeUserPrompt, resolvedModel, capMaxTokens(provider, 16384, resolvedModel), apiKey, abort, true, 0.5);
    }
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  const result = parseJsonResponse(raw, "llm-generate");

  // Strip the _referenceAnalysis chain-of-thought field before returning to the plugin
  if (result && typeof result === "object" && "_referenceAnalysis" in (result as any)) {
    const analysis = (result as any)._referenceAnalysis;
    console.log(`[callLLMGenerate] Reference analysis: ${typeof analysis === "string" ? analysis.slice(0, 500) : JSON.stringify(analysis).slice(0, 500)}`);
    delete (result as any)._referenceAnalysis;
  }

  return result;
}

// ── Call LLM for HTML Generation ────────────────────────────────────

export async function callLLMGenerateHTML(
  prompt: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  selection?: any,
  fullDesignSystem?: any,
  dsSummary?: any,
  sourceHtml?: string,
  referenceImageBase64?: string
): Promise<string> {
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  // ── TWO-STEP pipeline when a reference image is attached ──────────
  // Step 0: Analyze the image → hierarchical layout tree (vision-focused, no coding)
  // Step 1: Translate layout tree → HTML/CSS (mechanical reconstruction)
  if (referenceImageBase64) {
    // ── Step 0: Image → Layout Tree (multi-pass for better quality) ──
    console.log(`[callLLMGenerateHTML] Step 0: Multi-pass extraction from reference image...`);

    const layoutTree = await callLLMMultiPass(
      prompt,
      referenceImageBase64,
      apiKey,
      provider,
      model,
    );

    let blueprint = JSON.stringify(layoutTree, null, 2);

    console.log(`[callLLMGenerateHTML] Step 0 complete: layout tree ${blueprint.length} chars`);
    console.log(`[callLLMGenerateHTML] Layout tree preview: ${blueprint.slice(0, 500)}...`);

    // ── Step 0.5: Crop icon regions from reference image ──
    let iconImagesSection = "";
    try {
      const blueprintObj = JSON.parse(blueprint);
      interface IconInfo { id: string; bbox: { x: number; y: number; w: number; h: number } }
      const icons: IconInfo[] = [];
      function findIcons(node: any): void {
        if (node && typeof node === "object") {
          if (node.type === "icon" && node.id && node.bbox) {
            icons.push({ id: node.id, bbox: node.bbox });
          }
          if (Array.isArray(node.children)) {
            for (const child of node.children) findIcons(child);
          }
        }
      }
      findIcons(blueprintObj.tree || blueprintObj);
      console.log(`[callLLMGenerateHTML] Found ${icons.length} icon nodes with bbox`);

      if (icons.length > 0) {
        const refBuf = Buffer.from(referenceImageBase64, "base64");
        const metadata = await sharp(refBuf).metadata();
        const imgW = metadata.width || 1;
        const imgH = metadata.height || 1;
        // Scale bbox from viewport coords to actual image pixel coords
        const vp = blueprintObj.viewport || { width: 1440, height: 900 };
        const scaleX = imgW / vp.width;
        const scaleY = imgH / vp.height;
        const iconMap: Record<string, string> = {};

        for (const icon of icons) {
          try {
            // Scale bbox to image coordinates and clamp to bounds
            const left = Math.max(0, Math.round(icon.bbox.x * scaleX));
            const top = Math.max(0, Math.round(icon.bbox.y * scaleY));
            let width = Math.round(icon.bbox.w * scaleX);
            let height = Math.round(icon.bbox.h * scaleY);
            if (left + width > imgW) width = imgW - left;
            if (top + height > imgH) height = imgH - top;
            if (width > 0 && height > 0) {
              const cropped = await sharp(refBuf)
                .extract({ left, top, width, height })
                .png()
                .toBuffer();
              iconMap[icon.id] = cropped.toString("base64");
              console.log(`[callLLMGenerateHTML] Cropped icon "${icon.id}": ${width}×${height}px, ${cropped.length} bytes`);
            }
          } catch (cropErr) {
            console.warn(`[callLLMGenerateHTML] Failed to crop icon "${icon.id}":`, cropErr);
          }
        }

        if (Object.keys(iconMap).length > 0) {
          const mapLines = Object.entries(iconMap).map(([id, b64]) => `  "${id}": "${b64}"`);
          iconImagesSection = "\n\n## ICON_IMAGES\nUse these base64 PNG images for icon <img> src attributes. Map icon id → base64 string:\n{\n" + mapLines.join(",\n") + "\n}";
          console.log(`[callLLMGenerateHTML] ICON_IMAGES section: ${Object.keys(iconMap).length} icons, ${iconImagesSection.length} chars`);
        }
      }
    } catch (parseErr) {
      console.warn(`[callLLMGenerateHTML] Could not parse blueprint for icon extraction:`, parseErr);
    }

    // ── Step 1: Layout Tree → HTML ──
    console.log(`[callLLMGenerateHTML] Step 1: Translating layout tree to HTML...`);
    const generateParts: string[] = [
      "## Hierarchical Layout Tree (extracted from reference image)",
      "Translate this tree MECHANICALLY into HTML/CSS. Each node → an HTML element with the specified CSS properties.",
      "",
      blueprint,
    ];

    // Inject cropped icon images into the prompt
    if (iconImagesSection) {
      generateParts.push(iconImagesSection);
    }

    // Include font family hint from the project's design system
    const fontFamilies = styleTokens?.fontFamilies || [];
    if (fontFamilies.length > 0) {
      generateParts.push("", `## Font Override: Use "${fontFamilies[0]}" as the primary font-family instead of the tree's fontFamily.`);
    }

    generateParts.push("", "## Instructions",
      "The reference image is attached. Use it to verify your reconstruction matches the original.",
      "Translate every node in the layout tree to a corresponding HTML element with the exact CSS properties specified.",
      "Do NOT add, remove, or modify any elements. Do NOT change text, colors, or proportions.",
      "For chart nodes, generate inline SVG with polylines/polygons from the provided data values.",
      "Generate the complete HTML document now.");

    const generatePrompt = generateParts.join("\n");
    console.log(`[callLLMGenerateHTML] Step 1 prompt: ${generatePrompt.length} chars`);

    const abort1 = new AbortController();
    _activeAbort = abort1;
    let raw: string;
    try {
      // Pass the reference image to Step 1 so the HTML generator can verify against the original
      raw = await callProviderWithImage(
        provider,
        GENERATE_HTML_FROM_BLUEPRINT_SYSTEM_PROMPT,
        generatePrompt,
        referenceImageBase64,
        resolvedModel,
        capMaxTokens(provider, 32768, resolvedModel),
        apiKey,
        abort1,
        false // not JSON mode — we want HTML
      );
    } finally {
      if (_activeAbort === abort1) _activeAbort = null;
    }

    // Strip markdown fences
    let html = raw.trim();
    if (html.startsWith("```html")) html = html.slice(7);
    else if (html.startsWith("```")) html = html.slice(3);
    if (html.endsWith("```")) html = html.slice(0, -3);
    html = html.trim();

    if (!html.includes("<") || !html.includes(">")) {
      throw new Error("LLM returned non-HTML content");
    }

    console.log(`[callLLMGenerateHTML] Step 1 complete: HTML ${html.length} chars`);
    return html;
  }

  // ── Standard path (no reference image) ────────────────────────────
  const userPrompt = buildGenerateHTMLPrompt(prompt, styleTokens, designSystem, selection, fullDesignSystem, dsSummary, sourceHtml);

  console.log(`[callLLMGenerateHTML] System prompt: ${GENERATE_HTML_SYSTEM_PROMPT.length} chars, User prompt: ${userPrompt.length} chars, TOTAL: ${GENERATE_HTML_SYSTEM_PROMPT.length + userPrompt.length} chars (~${Math.round((GENERATE_HTML_SYSTEM_PROMPT.length + userPrompt.length)/4)} tokens)`);

  const MAX_USER_PROMPT_CHARS = 500000;
  let safeUserPrompt = userPrompt;
  if (userPrompt.length > MAX_USER_PROMPT_CHARS) {
    console.warn(`[callLLMGenerateHTML] User prompt too long (${userPrompt.length} chars), truncating to ${MAX_USER_PROMPT_CHARS}`);
    safeUserPrompt = userPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "\n\n[PROMPT TRUNCATED — generate based on the content above]";
  }

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, GENERATE_HTML_SYSTEM_PROMPT, safeUserPrompt, resolvedModel, 16384, apiKey, abort, false, 0.5);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  let html = raw.trim();
  if (html.startsWith("```html")) html = html.slice(7);
  else if (html.startsWith("```")) html = html.slice(3);
  if (html.endsWith("```")) html = html.slice(0, -3);
  html = html.trim();

  if (!html.includes("<") || !html.includes(">")) {
    throw new Error("LLM returned non-HTML content");
  }

  console.log(`[callLLMGenerateHTML] HTML output: ${html.length} chars`);
  return html;
}

// ── Call LLM for Layout Tree Extraction (Step 0 only) ───────────────
// Used by the direct-to-snapshot pipeline: vision LLM → layout tree JSON
// No HTML generation, no Puppeteer — the layout tree is converted
// programmatically to a Figma snapshot by treeToSnapshot.ts

export async function callLLMExtractLayoutTree(
  prompt: string,
  referenceImageBase64: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
): Promise<any> {
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  console.log(`[callLLMExtractLayoutTree] Analyzing reference image with ${provider}/${resolvedModel}...`);
  const analyzePrompt = `Analyze this UI screenshot and produce a hierarchical layout tree as JSON.\n\nExtract the EXACT visual structure — every container, text element, icon, chart, and progress bar with CSS-ready properties.\n\nUser context: ${prompt}`;

  const abort = new AbortController();
  _activeAbort = abort;
  let blueprintRaw: string;
  try {
    blueprintRaw = await callProviderWithImage(
      provider,
      ANALYZE_REFERENCE_IMAGE_SYSTEM_PROMPT,
      analyzePrompt,
      referenceImageBase64,
      resolvedModel,
      capMaxTokens(provider, 32768, resolvedModel),
      apiKey,
      abort,
      true // jsonMode
    );
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  // Clean up markdown fences
  let blueprint = blueprintRaw.trim();
  if (blueprint.startsWith("```json")) blueprint = blueprint.slice(7);
  else if (blueprint.startsWith("```")) blueprint = blueprint.slice(3);
  if (blueprint.endsWith("```")) blueprint = blueprint.slice(0, -3);
  blueprint = blueprint.trim();

  console.log(`[callLLMExtractLayoutTree] Layout tree: ${blueprint.length} chars`);
  console.log(`[callLLMExtractLayoutTree] Preview: ${blueprint.slice(0, 500)}...`);

  let parsed: any;
  try {
    parsed = JSON.parse(blueprint);
  } catch (parseErr: any) {
    console.warn(`[callLLMExtractLayoutTree] JSON parse failed: ${parseErr.message}`);
    console.warn(`[callLLMExtractLayoutTree] Attempting JSON repair on truncated output...`);
    parsed = repairTruncatedJSON(blueprint);
  }
  return parsed;
}

// ── Region-by-Region Pipeline ───────────────────────────────────────
// Pass 1: Identify major regions (small JSON output)
// Pass 2: For each region, crop + detailed extraction (focused LLM calls)
// Stitch: Combine region trees into one layout tree

interface RegionInfo {
  id: string;
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  description: string;
}

interface RegionsResult {
  viewport: { width: number; height: number };
  fontFamily: string;
  colors: Record<string, string>;
  regions: RegionInfo[];
}

export async function callLLMRegionByRegion(
  prompt: string,
  referenceImageBase64: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
): Promise<any> {
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  // ── Pass 1: Identify regions ──
  console.log(`[regionByRegion] Pass 1: Identifying regions with ${provider}/${resolvedModel}...`);
  const regionPrompt = `Identify the major visual regions of this UI screenshot.\n\nUser context: ${prompt}`;

  const abort1 = new AbortController();
  _activeAbort = abort1;
  let regionsRaw: string;
  try {
    regionsRaw = await callProviderWithImage(
      provider,
      IDENTIFY_REGIONS_SYSTEM_PROMPT,
      regionPrompt,
      referenceImageBase64,
      resolvedModel,
      capMaxTokens(provider, 4096, resolvedModel),
      apiKey,
      abort1,
      true
    );
  } finally {
    if (_activeAbort === abort1) _activeAbort = null;
  }

  // Parse regions
  let regionsClean = regionsRaw.trim();
  if (regionsClean.startsWith("```json")) regionsClean = regionsClean.slice(7);
  else if (regionsClean.startsWith("```")) regionsClean = regionsClean.slice(3);
  if (regionsClean.endsWith("```")) regionsClean = regionsClean.slice(0, -3);
  regionsClean = regionsClean.trim();

  let regionsResult: RegionsResult;
  try {
    regionsResult = JSON.parse(regionsClean);
  } catch (e: any) {
    console.warn(`[regionByRegion] Pass 1 JSON parse failed: ${e.message}, attempting repair...`);
    regionsResult = repairTruncatedJSON(regionsClean);
  }

  const regions = regionsResult.regions || [];
  console.log(`[regionByRegion] Pass 1 complete: ${regions.length} regions identified`);
  for (const r of regions) {
    console.log(`  - ${r.id}: ${r.name} (${r.bbox.x},${r.bbox.y} ${r.bbox.w}x${r.bbox.h}) — ${r.description}`);
  }

  if (regions.length === 0) {
    throw new Error("Region identification found no regions in the screenshot");
  }

  // ── Pass 2: Extract detail for each region ──
  // Decode full image once for cropping
  const refBuf = Buffer.from(referenceImageBase64, "base64");
  const meta = await sharp(refBuf).metadata();
  const imgW = meta.width || 1;
  const imgH = meta.height || 1;
  const viewport = regionsResult.viewport || { width: 1440, height: 900 };
  const cropScaleX = imgW / viewport.width;
  const cropScaleY = imgH / viewport.height;

  console.log(`[regionByRegion] Image: ${imgW}x${imgH}, viewport: ${viewport.width}x${viewport.height}, cropScale: ${cropScaleX.toFixed(3)}x${cropScaleY.toFixed(3)}`);

  const regionTrees: { region: RegionInfo; tree: any }[] = [];

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    console.log(`[regionByRegion] Pass 2 [${i + 1}/${regions.length}]: Extracting "${region.id}" (${region.bbox.w}x${region.bbox.h})...`);

    // Crop the region from the reference image
    const left = Math.max(0, Math.round(region.bbox.x * cropScaleX));
    const top = Math.max(0, Math.round(region.bbox.y * cropScaleY));
    let width = Math.round(region.bbox.w * cropScaleX);
    let height = Math.round(region.bbox.h * cropScaleY);
    if (left + width > imgW) width = imgW - left;
    if (top + height > imgH) height = imgH - top;

    if (width <= 0 || height <= 0) {
      console.warn(`[regionByRegion] Skipping region "${region.id}" — invalid crop dimensions`);
      continue;
    }

    const croppedBuf = await sharp(refBuf)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    const croppedBase64 = croppedBuf.toString("base64");
    console.log(`[regionByRegion] Cropped "${region.id}": ${width}x${height}px (${croppedBuf.length} bytes)`);

    // Send cropped region to LLM for detailed extraction
    const detailPrompt = `Extract the detailed layout tree for this UI region.\n\nRegion: "${region.name}" — ${region.description}\nCrop dimensions: ${region.bbox.w}px × ${region.bbox.h}px\n\nUser context: ${prompt}`;

    const abort2 = new AbortController();
    _activeAbort = abort2;
    let detailRaw: string;
    try {
      detailRaw = await callProviderWithImage(
        provider,
        EXTRACT_REGION_DETAIL_SYSTEM_PROMPT,
        detailPrompt,
        croppedBase64,
        resolvedModel,
        capMaxTokens(provider, 16384, resolvedModel),
        apiKey,
        abort2,
        true
      );
    } finally {
      if (_activeAbort === abort2) _activeAbort = null;
    }

    // Parse region detail
    let detailClean = detailRaw.trim();
    if (detailClean.startsWith("```json")) detailClean = detailClean.slice(7);
    else if (detailClean.startsWith("```")) detailClean = detailClean.slice(3);
    if (detailClean.endsWith("```")) detailClean = detailClean.slice(0, -3);
    detailClean = detailClean.trim();

    let detailResult: any;
    try {
      detailResult = JSON.parse(detailClean);
    } catch (e: any) {
      console.warn(`[regionByRegion] Pass 2 "${region.id}" JSON parse failed: ${e.message}, attempting repair...`);
      try {
        detailResult = repairTruncatedJSON(detailClean);
      } catch {
        console.warn(`[regionByRegion] Pass 2 "${region.id}" repair also failed, skipping region`);
        continue;
      }
    }

    if (detailResult.tree) {
      regionTrees.push({ region, tree: detailResult.tree });
      console.log(`[regionByRegion] Pass 2 "${region.id}" complete: ${JSON.stringify(detailResult.tree).length} chars`);
    } else {
      console.warn(`[regionByRegion] Pass 2 "${region.id}" returned no tree, skipping`);
    }
  }

  console.log(`[regionByRegion] All regions processed: ${regionTrees.length}/${regions.length} successful`);

  // ── Stitch: Offset each region tree's bboxes by the region's global position ──
  function offsetBboxes(node: any, offsetX: number, offsetY: number): void {
    if (!node) return;
    if (node.bbox) {
      node.bbox.x = (node.bbox.x || 0) + offsetX;
      node.bbox.y = (node.bbox.y || 0) + offsetY;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        offsetBboxes(child, offsetX, offsetY);
      }
    }
  }

  // Build combined layout tree
  const combinedChildren: any[] = [];
  for (const { region, tree } of regionTrees) {
    // Offset all bboxes in this region tree by the region's global position
    offsetBboxes(tree, region.bbox.x, region.bbox.y);
    
    // Set the root container's bbox to the region's global bbox
    tree.bbox = { ...region.bbox };
    tree.id = tree.id || region.id;
    tree.name = tree.name || region.name;
    
    combinedChildren.push(tree);
  }

  const combinedTree = {
    viewport,
    fontFamily: regionsResult.fontFamily || "Inter",
    colors: regionsResult.colors || {},
    tree: {
      id: "root",
      name: "root",
      bbox: { x: 0, y: 0, w: viewport.width, h: viewport.height },
      layout: "column",
      bg: regionsResult.colors?.["page-bg"] || regionsResult.colors?.["background"] || null,
      children: combinedChildren,
    },
  };

  console.log(`[regionByRegion] Combined tree: ${JSON.stringify(combinedTree).length} chars, ${combinedChildren.length} top-level regions`);
  return combinedTree;
}

// ── Option 4: Screenshot-as-Background + Text Overlay ───────────────
// Extracts only text positions from screenshot. The screenshot itself becomes
// the frame's background image, guaranteeing pixel-perfect visuals.

export interface TextOverlayItem {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  fontFamily?: string;
  align?: string;
  opacity?: number;
}

export interface TextOverlayResult {
  viewport: { width: number; height: number };
  texts: TextOverlayItem[];
}

export async function callLLMExtractTextOverlay(
  prompt: string,
  referenceImageBase64: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
): Promise<TextOverlayResult> {
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  console.log(`[extractTextOverlay] Extracting text positions with ${provider}/${resolvedModel}...`);
  const userPrompt = `Extract all visible text from this UI screenshot with exact positions.\n\nContext: ${prompt}`;

  const abort = new AbortController();
  _activeAbort = abort;
  let raw: string;
  try {
    raw = await callProviderWithImage(
      provider,
      EXTRACT_TEXT_OVERLAY_SYSTEM_PROMPT,
      userPrompt,
      referenceImageBase64,
      resolvedModel,
      capMaxTokens(provider, 16384, resolvedModel),
      apiKey,
      abort,
      true
    );
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  let clean = raw.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  else if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  clean = clean.trim();

  let result: TextOverlayResult;
  try {
    result = JSON.parse(clean);
  } catch (e: any) {
    console.warn(`[extractTextOverlay] JSON parse failed: ${e.message}, attempting repair...`);
    result = repairTruncatedJSON(clean);
  }

  console.log(`[extractTextOverlay] Extracted ${result.texts?.length || 0} text elements`);
  return result;
}

// ── Multi-pass specialized extraction (Option 5) ────────────────────
// Pass 1: Container structure
// Pass 2: Text elements
// Pass 3: Visual elements (icons, charts, progress bars, toggles, images)
// Merge: Place text/visuals into containers by position containment

async function callPassWithImage(
  systemPrompt: string,
  userPrompt: string,
  imageBase64: string,
  provider: Provider,
  model: string,
  apiKey: string,
): Promise<any> {
  // Each pass gets its own abort controller (not the shared _activeAbort)
  // since multiple passes run in parallel
  const abort = new AbortController();
  let raw: string;
  raw = await callProviderWithImage(
    provider,
    systemPrompt,
    userPrompt,
    imageBase64,
    model,
    capMaxTokens(provider, 16384, model),
    apiKey,
    abort,
    true, // jsonMode
  );
  let clean = raw.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  else if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  clean = clean.trim();
  try {
    return JSON.parse(clean);
  } catch {
    return repairTruncatedJSON(clean);
  }
}

/**
 * Place text and visual elements into the correct containers based on position containment.
 * Returns a unified layout tree matching the format expected by treeToSnapshot().
 */
function mergeMultiPassResults(
  structure: any,
  textResult: any,
  visualsResult: any,
): any {
  const texts: any[] = textResult?.texts || [];
  const visuals: any[] = visualsResult?.visuals || [];
  const tree = structure?.tree;
  if (!tree) {
    console.warn("[multipass-merge] No structure tree found — building flat layout");
    // Fallback: build a flat container with all elements
    return {
      viewport: structure?.viewport || { width: 1440, height: 900 },
      fontFamily: structure?.fontFamily || "Inter",
      colors: structure?.colors || {},
      tree: {
        id: "root",
        el: "div",
        name: "root",
        bbox: { x: 0, y: 0, w: structure?.viewport?.width || 1440, h: structure?.viewport?.height || 900 },
        layout: "column",
        bg: "#ffffff",
        children: [
          ...texts.map((t: any, i: number) => ({
            type: "text",
            id: `text-${i}`,
            text: t.text,
            bbox: t.bbox,
            fontSize: t.fontSize,
            fontWeight: t.fontWeight,
            color: t.color,
            textAlign: t.textAlign,
            noWrap: t.noWrap,
          })),
          ...visuals,
        ],
      },
    };
  }

  // Build a flat list of ALL leaf containers (no children or empty children)
  interface LeafInfo { node: any; depth: number; }
  const leaves: LeafInfo[] = [];

  function collectLeaves(node: any, depth: number): void {
    if (!node.children || node.children.length === 0) {
      leaves.push({ node, depth });
    } else {
      for (const child of node.children) {
        collectLeaves(child, depth + 1);
      }
    }
  }
  collectLeaves(tree, 0);

  // Also collect ALL containers (including non-leaf) for fallback placement
  const allContainers: LeafInfo[] = [];
  function collectAll(node: any, depth: number): void {
    allContainers.push({ node, depth });
    if (node.children) {
      for (const child of node.children) {
        collectAll(child, depth + 1);
      }
    }
  }
  collectAll(tree, 0);

  /**
   * Find the deepest container whose bbox fully contains the given bbox.
   * Prioritize leaf containers, fall back to any container.
   */
  function findBestContainer(bbox: any): any {
    if (!bbox) return tree;

    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;

    // First try: find deepest LEAF container that contains the center point
    let bestLeaf: any = null;
    let bestLeafDepth = -1;
    for (const { node, depth } of leaves) {
      const nb = node.bbox;
      if (!nb) continue;
      if (cx >= nb.x && cx <= nb.x + nb.w && cy >= nb.y && cy <= nb.y + nb.h) {
        if (depth > bestLeafDepth) {
          bestLeaf = node;
          bestLeafDepth = depth;
        }
      }
    }
    if (bestLeaf) return bestLeaf;

    // Fallback: find deepest ANY container that contains the center point
    let bestAny: any = null;
    let bestAnyDepth = -1;
    for (const { node, depth } of allContainers) {
      const nb = node.bbox;
      if (!nb) continue;
      if (cx >= nb.x && cx <= nb.x + nb.w && cy >= nb.y && cy <= nb.y + nb.h) {
        if (depth > bestAnyDepth) {
          bestAny = node;
          bestAnyDepth = depth;
        }
      }
    }
    return bestAny || tree;
  }

  // Place text elements into containers
  let textPlaced = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const container = findBestContainer(t.bbox);
    if (!container.children) container.children = [];
    container.children.push({
      type: "text",
      id: `text-${i}`,
      text: t.text,
      bbox: t.bbox,
      fontSize: t.fontSize,
      fontWeight: t.fontWeight,
      color: t.color,
      textAlign: t.textAlign,
      noWrap: t.noWrap,
    });
    textPlaced++;
  }

  // Place visual elements into containers
  let visualsPlaced = 0;
  for (const v of visuals) {
    const container = findBestContainer(v.bbox);
    if (!container.children) container.children = [];
    container.children.push(v);
    visualsPlaced++;
  }

  console.log(`[multipass-merge] Placed ${textPlaced} text elements and ${visualsPlaced} visual elements into ${leaves.length} leaf containers`);

  return {
    viewport: structure.viewport || { width: 1440, height: 900 },
    fontFamily: structure.fontFamily || "Inter",
    colors: structure.colors || {},
    tree,
  };
}

export async function callLLMMultiPass(
  prompt: string,
  referenceImageBase64: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
): Promise<any> {
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  console.log(`[multipass] Starting 3-pass extraction with ${provider}/${resolvedModel}...`);
  const context = `Analyze this UI screenshot.\n\nUser context: ${prompt}`;

  // Run all 3 passes in parallel for speed
  const [structureResult, textResult, visualsResult] = await Promise.all([
    (async () => {
      console.log(`[multipass] Pass 1: Extracting container structure...`);
      const r = await callPassWithImage(MULTIPASS_STRUCTURE_PROMPT, context, referenceImageBase64, provider, resolvedModel, apiKey);
      console.log(`[multipass] Pass 1 done: ${JSON.stringify(r).length} chars`);
      return r;
    })(),
    (async () => {
      console.log(`[multipass] Pass 2: Extracting text elements...`);
      const r = await callPassWithImage(MULTIPASS_TEXT_PROMPT, context, referenceImageBase64, provider, resolvedModel, apiKey);
      console.log(`[multipass] Pass 2 done: ${(r?.texts || []).length} text elements`);
      return r;
    })(),
    (async () => {
      console.log(`[multipass] Pass 3: Extracting visual elements...`);
      const r = await callPassWithImage(MULTIPASS_VISUALS_PROMPT, context, referenceImageBase64, provider, resolvedModel, apiKey);
      console.log(`[multipass] Pass 3 done: ${(r?.visuals || []).length} visual elements`);
      return r;
    })(),
  ]);

  // Merge passes into a unified layout tree
  console.log(`[multipass] Merging 3 passes...`);
  const merged = mergeMultiPassResults(structureResult, textResult, visualsResult);
  console.log(`[multipass] Merged tree: ${JSON.stringify(merged).length} chars`);

  return merged;
}

// ── Call LLM for Design System Binding (Step 2) ─────────────────────

export async function callLLMBindDS(
  html: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  fullDesignSystem?: any,
  dsSummary?: any
): Promise<string> {
  const userPrompt = buildDSBindingPrompt(html, styleTokens, designSystem, fullDesignSystem, dsSummary);
  if (!userPrompt) {
    console.log(`[callLLMBindDS] No DS context — skipping binding step`);
    return html;
  }

  console.log(`[callLLMBindDS] System prompt: ${BIND_DS_SYSTEM_PROMPT.length} chars, User prompt: ${userPrompt.length} chars, TOTAL: ${BIND_DS_SYSTEM_PROMPT.length + userPrompt.length} chars (~${Math.round((BIND_DS_SYSTEM_PROMPT.length + userPrompt.length)/4)} tokens)`);

  const MAX_USER_PROMPT_CHARS = 500000;
  let safeUserPrompt = userPrompt;
  if (userPrompt.length > MAX_USER_PROMPT_CHARS) {
    console.warn(`[callLLMBindDS] User prompt too long (${userPrompt.length} chars), truncating to ${MAX_USER_PROMPT_CHARS}`);
    safeUserPrompt = userPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "\n\n[PROMPT TRUNCATED]";
  }

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    // Lower temperature for binding — this is a mechanical rewrite, not creative
    raw = await callProvider(provider, BIND_DS_SYSTEM_PROMPT, safeUserPrompt, resolvedModel, 16384, apiKey, abort, false, 0.2);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  // Strip markdown fences
  let bound = raw.trim();
  if (bound.startsWith("```html")) {
    bound = bound.slice(7);
  } else if (bound.startsWith("```")) {
    bound = bound.slice(3);
  }
  if (bound.endsWith("```")) {
    bound = bound.slice(0, -3);
  }
  bound = bound.trim();

  if (!bound.includes("<") || !bound.includes(">")) {
    console.warn(`[callLLMBindDS] Binding returned non-HTML — using original`);
    return html;
  }

  console.log(`[callLLMBindDS] Bound HTML output: ${bound.length} chars`);
  return bound;
}

// ── Call LLM for Accessibility Audit Enrichment ─────────────────────

const AUDIT_SYSTEM_PROMPT = `You are a WCAG accessibility expert reviewing Figma design audit findings.

You receive a JSON array of accessibility issues found by automated checks. For EACH finding, provide a short, actionable suggestion for how to fix it.

Return a JSON object with this structure:
{
  "findings": [
    {
      "nodeId": "<same nodeId from input>",
      "checkType": "<same checkType from input>",
      "suggestion": "<1-2 sentence fix recommendation>"
    }
  ]
}

Rules:
- Return JSON only. No markdown, no prose.
- Keep suggestions concise and specific (e.g. "Change text color to #333333 for 4.5:1 contrast" rather than "Increase contrast").
- For contrast issues, suggest a specific hex color that would meet WCAG AA.
- For touch targets, suggest a minimum size.
- For font size, suggest a minimum px value.
- Match each finding by nodeId + checkType in your response.`;

export async function callLLMAudit(
  findings: any[],
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string
): Promise<unknown> {
  const userPrompt = `## Accessibility Audit Findings\n${JSON.stringify(findings, null, 2)}\n\nReturn the enriched findings JSON now.`;
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, AUDIT_SYSTEM_PROMPT, userPrompt, resolvedModel, 4096, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-audit");
}

// ── Call LLM for UI State Audit ─────────────────────────────────────

const STATE_AUDIT_SYSTEM_PROMPT = `You are a senior UX designer reviewing Figma design files for completeness of UI states.

You receive a JSON array of components and screens found in a Figma file. For EACH item, determine which interaction/visual states are present and which are missing.

**For components** (buttons, inputs, cards, toggles, etc.), check for these typical states:
- Default, Hover, Pressed/Active, Focused, Disabled, Loading, Error

Not every state applies to every component. A simple divider needs no states. A button needs Default, Hover, Pressed, Disabled at minimum. An input field also needs Focused, Error, Filled. Use your judgment.

**For screens**, check for these typical states:
- Default (populated with data), Empty state, Loading state, Error state, Partial/skeleton state

Again, use judgment — a simple settings screen may not need all of these.

Return a JSON object with this structure:
{
  "items": [
    {
      "nodeId": "<same nodeId from input>",
      "name": "<component or screen name>",
      "itemType": "component" | "screen",
      "presentStates": ["Default", "Hover"],
      "missingStates": [
        { "name": "Disabled", "reason": "Users need visual feedback when the action is unavailable" },
        { "name": "Loading", "reason": "Show progress feedback during async operations" }
      ]
    }
  ]
}

Rules:
- Return JSON only. No markdown, no prose.
- Be practical — only flag states that genuinely matter for the component/screen type.
- If a component already has all appropriate states, return an empty missingStates array.
- Keep reasons concise (1 sentence).
- Match each item by nodeId in your response.
- Do not invent states that don't apply (e.g., don't suggest "Hover" for a mobile-only component).`;

export async function callLLMStateAudit(
  items: any[],
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string
): Promise<unknown> {
  const userPrompt = `## UI Components & Screens to Audit for State Completeness\n${JSON.stringify(items, null, 2)}\n\nAnalyze each item and return the JSON with present and missing states.`;
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, STATE_AUDIT_SYSTEM_PROMPT, userPrompt, resolvedModel, 8192, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-state-audit");
}

// ── Call LLM for Audit Fix ──────────────────────────────────────────

const FIX_SYSTEM_PROMPT = `You are a WCAG accessibility expert helping fix specific issues in a Figma design.

You receive a single accessibility finding with its context. Provide a specific, structured fix.

Return a JSON object with this structure:
{
  "fix": {
    "property": "<one of: fill-color, font-size, resize, opacity>",
    "value": "<specific value — hex color for fill-color, number for font-size/opacity>",
    "width": <number, only for resize>,
    "height": <number, only for resize>,
    "explanation": "<1 sentence explaining the fix>"
  }
}

Rules:
- Return JSON only. No markdown, no prose.
- For contrast/fill-color issues: suggest a specific hex colour (e.g. "#2D2D2D") that meets WCAG AA against the stated background. Preserve the hue of the original colour if possible.
- For touch-target/resize issues: suggest minimum 44×44px dimensions. If the element is in an auto-layout, consider adjusting padding proportionally.
- For font-size issues: suggest 12px minimum, or a larger value if context suggests it (e.g. body text should be 14-16px).
- For opacity issues: suggest 1.0 unless context suggests a different appropriate value.
- Keep the "explanation" concise and specific.`;

export async function callLLMAuditFix(
  finding: any,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string
): Promise<unknown> {
  const userPrompt = `## Accessibility Finding to Fix\n${JSON.stringify(finding, null, 2)}\n\nProvide the structured fix JSON now.`;
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, FIX_SYSTEM_PROMPT, userPrompt, resolvedModel, 2048, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-audit-fix");
}

// ── Call LLM for Layout Audit ───────────────────────────────────────

const LAYOUT_AUDIT_SYSTEM_PROMPT = `You are a senior UI/UX design reviewer performing a comprehensive layout audit. You receive BOTH a screenshot of a Figma frame AND its JSON node tree. Your job is to find EVERY layout issue — structural AND visual. Err heavily on over-reporting. A typical complex frame has 15-30+ issues.

## CRITICAL: DUAL-PASS METHODOLOGY

You MUST perform TWO separate analysis passes and combine the results:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PASS 1: VISUAL SCAN (screenshot-first)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Look at the screenshot AS A DESIGNER would — with fresh eyes. Before touching the JSON, answer these questions visually:

### 1A. Proportional sanity check
Scan every element and ask: "Does this look the right SIZE for what it is?"
- **Buttons**: A standard button is 36-48px tall. If any button looks like it could fit 2-3 lines of text inside, it is TOO TALL. Flag it.
- **Input fields**: Standard height is 36-44px. Oversized inputs look unprofessional.
- **Icons / icon containers**: Standard is 16-24px for inline icons, 32-48px for feature icons. Anything larger is suspect.
- **Cards**: Are cards disproportionately tall or wide for their content? Is there excessive empty space inside?
- **Sections**: Does any section take up way more vertical space than its content warrants?
- **IMPORTANT**: Do NOT flag the root frame, its direct full-width child container, or any frame that serves as the main scrollable content area. A tall frame (even 2000px+) that is genuinely filled with diverse content (images, text blocks, buttons, cards, reviews, etc.) is a normal scrollable page — NOT a proportion issue. Only flag a frame as disproportionate if it has significant EMPTY/WASTED space relative to its actual content.
- **Images / media**: Are they stretched, squished, or comically large/small?
- **RULE**: If any element looks like it's 2x or more the expected size for its role, that is a severity "error".

### 1B. Spacing & rhythm check (visual)
Look at the overall vertical and horizontal rhythm:
- Are there sections where elements feel cramped together?
- Are there sections with weirdly large gaps between elements?
- Is the spacing between items in a list/grid consistent to your eye?
- Do different sections of the page use wildly different spacing scales?
- Are there areas that feel "off" even if you can't immediately say why? → Investigate in the JSON pass.

### 1C. Visual weight & hierarchy
- Can you instantly tell what the primary action is?
- Do headings, subheadings, body text create a clear visual hierarchy?
- Are there elements competing for attention that shouldn't be?
- Are decorative elements (dividers, backgrounds) distracting from content?

### 1D. Content-container fit
- Does any text look truncated, clipped, or run off its container?
- Are there containers that are mostly empty space with tiny content inside?
- Are there elements that look pushed to weird positions (e.g., a label stuck to the very top-left corner with no padding)?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PASS 2: STRUCTURAL ANALYSIS (JSON tree)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Now verify and extend your visual findings with precise measurements from the JSON:

### 2A. Compute absolute bounds
For every node, compute its absolute bounding box (x, y, width, height) relative to the root frame. This enables global overlap and bounds detection.

### 2B. For each PARENT frame, analyze children systematically

a) **Compute actual gaps** between consecutive siblings:
   - VERTICAL layout: gap = child[n+1].y - (child[n].y + child[n].height)
   - HORIZONTAL layout: gap = child[n+1].x - (child[n].x + child[n].width)
   - Compare to declared \`itemSpacing\`. Any difference = spacing bug.
   - Compare all sibling gaps to each other. Any variance = inconsistency.

b) **Check for overlaps** — for every pair of siblings:
   - Two rects overlap if: A.x < B.x + B.width AND A.x + A.width > B.x AND A.y < B.y + B.height AND A.y + A.height > B.y

c) **Check child-within-parent bounds** — for every child:
   - child.x < 0, child.x + child.width > parent.width, child.y < 0, child.y + child.height > parent.height
   - If parent has clipsContent: true → content IS being cropped, always flag.
   - If clipsContent is false but child overflows → visual overflow, flag.

d) **Check padding** — compare content area to frame edges:
   - Are declared paddingLeft/Right/Top/Bottom values actually reflected in child positions?
   - Is padding 0 creating cramped edges?
   - Is padding wildly asymmetric (e.g., 32px left but 8px right)?

e) **Check alignment**:
   - VERTICAL layout: are children aligned left/center/right as declared?
   - HORIZONTAL layout: are children aligned top/center/bottom as declared?
   - Are similar children consistent with each other?

### 2C. Element size validation (CRITICAL — this catches oversized buttons etc.)
For EVERY interactive/semantic element, validate its dimensions against standard UI conventions:

| Element type | Typical height | Flag if |
|---|---|---|
| Button / CTA | 36-48px | > 56px or < 28px |
| Text input / field | 36-44px | > 52px or < 28px |
| Inline icon | 16-24px | > 32px or < 12px |
| Nav link / menu item | 36-48px | > 56px or < 24px |
| Avatar / thumbnail | 32-64px | > 96px or < 20px |
| Card | Proportional to content | > 40% empty space inside |
| Section heading | fontSize+padding | > 3x the text height |

Detect element type from: node name (e.g., "Button", "CTA", "Submit"), fills/corner radius (rounded rect = likely button), or text content ("Buy Now", "Sign Up", etc.).
**Any element > 1.5x the standard height for its type → flag as PROPORTION_ISSUES with severity "error".**
**Any element > 2x → describe it as "dramatically oversized".**

### 2D. Check text nodes
- fontSize < 11px → too small
- Text content likely wider than node? (chars × fontSize × 0.6 > node.width)
- textAutoResize "NONE" on a node too small for its text → truncation risk
- Similar text nodes using different font sizes/weights/families?
- lineHeight < fontSize × 1.2 for body text?

### 2E. Check section spacing ratios
For the top-level sections of the frame:
- Compute the height of each section
- Compute the gaps between sections
- Are gaps wildly inconsistent? (e.g., 8px between sections A-B but 40px between B-C)
- Does any section's internal spacing look different from adjacent sections?
- Are there sections that are mostly padding/whitespace with very little content?

### 2F. Check auto-layout usage
- Frame with layoutMode "NONE" but 3+ children in a row/column → should use auto-layout
- Auto-layout frame with sizing mode causing collapse (width/height = 0)?
- FIXED sizing when children overflow?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PASS 3: CROSS-REFERENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Compare your visual findings (Pass 1) with your structural findings (Pass 2):
- Did you see anything visually "off" that you haven't yet explained with JSON data? → Investigate deeper and report it.
- Did the JSON reveal issues you DIDN'T notice visually? → Still report them.
- For every issue from Pass 1, verify it with JSON measurements and include pixel values.

## CATEGORIES
- SPACING_INCONSISTENCY — gaps between siblings differ, or differ from declared itemSpacing
- OVERLAP — bounding boxes of siblings or related elements intersect
- CROPPING — content extends beyond parent bounds and may be clipped
- ALIGNMENT — elements misaligned relative to siblings, container axis, or grid
- MARGIN_ISSUES — content too close to edges, asymmetric/missing padding, excessive margins
- SIZE_INCONSISTENCY — similar elements have different dimensions
- TYPOGRAPHY_ISSUES — inconsistent fonts, sizes too small, line height problems
- PROPORTION_ISSUES — element is too large/small for its purpose, disproportionate whitespace, content-container mismatch. NEVER flag a frame just for being tall — only flag it if it has significant empty/wasted space inside. A 2000px page full of content is normal, not an issue.
- AUTO_LAYOUT_PROBLEMS — missing auto-layout, wrong sizing mode, collapsed frames
- VISUAL_HIERARCHY — unclear importance ranking, weak CTA prominence
- DESIGN_CONVENTION — element violates standard UI sizing/spacing conventions

## OUTPUT FORMAT
Return a JSON object (no markdown fences, no prose):
{
  "summary": "<1-2 sentence overall assessment>",
  "issues": [
    {
      "category": "<one of the categories above>",
      "severity": "error" | "warning" | "info",
      "nodeId": "<id of the most relevant node>",
      "nodeName": "<name of that node>",
      "description": "<SPECIFIC description with actual pixel values, e.g. 'Button \"Submit\" is 96px tall — standard button height is 36-48px, making this ~2.5x too tall'>",
      "suggestion": "<concrete fix, e.g. 'Reduce button height to 44px and adjust vertical padding to 10px'>"
    }
  ]
}

## RULES
- Return ONLY valid JSON. No markdown, no explanations, no code fences.
- Be EXHAUSTIVE — report every issue, even 1px misalignments. 15-30+ issues is normal for a complex frame.
- Be SPECIFIC — always include actual measured values ("height is 96px, expected ~40px"), never vague ("too tall").
- Walk EVERY node in the tree. Don't skip subtrees.
- severity: "error" = broken/ugly/overlapping/dramatically oversized, "warning" = noticeable misalignment or inconsistency, "info" = minor polish.
- Include the nodeId so users can navigate to the problem.
- Sort by severity (errors first).
- TRUST YOUR EYES: If something looks wrong in the screenshot, it IS wrong. Report it even if the JSON looks technically correct.
- NEVER flag the root frame, main content wrapper, or any large container frame as a proportion/size issue just because it is tall. Scrollable pages are naturally tall. Only flag proportion issues on LEAF elements (buttons, icons, inputs, cards, images) or sections that have clearly excessive empty space relative to their content.
- Check EVERY button, input, card, and interactive element against the size conventions table.
- If the layout is flawless, return {"summary": "Layout looks clean.", "issues": []}.
- Aim for COMPLETENESS over brevity. Missing a real issue is worse than reporting a false positive.`;

export async function callLLMLayoutAudit(
  selectionSnapshot: any,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  imageBase64?: string
): Promise<unknown> {
  const snapshotJson = JSON.stringify(selectionSnapshot, null, 2);
  const userPrompt = `## Frame Snapshot to Audit

\`\`\`json
${snapshotJson}
\`\`\`

## Instructions
${imageBase64 ? `**PASS 1 — VISUAL (do this FIRST, before reading the JSON):**
1. Look at the screenshot. Scan every element for proportion problems — buttons that are way too tall, containers that are mostly empty space, sections with weird spacing.
2. Note every element whose SIZE looks wrong for what it is (e.g., a button that's 80-100px tall when it should be ~40px).
3. Note every area where SPACING looks off — cramped sections, uneven gaps, sections that feel disconnected.
4. Note any visual hierarchy problems — can you instantly tell what's most important?

**PASS 2 — STRUCTURAL (now use the JSON to verify and extend):**` : "**STRUCTURAL ANALYSIS:**"}
5. Walk through EVERY node in this tree systematically, starting from the root.
6. For each frame/container, compute the actual pixel gaps between consecutive children and compare to declared itemSpacing.
7. Check every child's bounds against its parent's bounds for overflow/cropping.
8. Check all sibling pairs for overlap.
9. **CHECK EVERY button, input, card against the size conventions table in your instructions.** Flag anything > 1.5x standard height.
10. Group similar elements and compare their sizes for consistency.
11. Check all text nodes for truncation risk and consistency.
12. Report EVERY issue found — even 1px discrepancies. Each distinct problem gets its own entry.
${imageBase64 ? "\n**PASS 3 — CROSS-REFERENCE:** Verify all visual findings with JSON pixel values. If you noticed something visually but can't find it in JSON, report it anyway with your best estimate." : ""}

Return the full JSON with ALL issues. Aim for 15+ issues on a complex frame.`;

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    if (imageBase64) {
      raw = await callProviderWithImage(provider, LAYOUT_AUDIT_SYSTEM_PROMPT, userPrompt, imageBase64, resolvedModel, 16384, apiKey, abort, true);
    } else {
      raw = await callProvider(provider, LAYOUT_AUDIT_SYSTEM_PROMPT, userPrompt, resolvedModel, 16384, apiKey, abort);
    }
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-layout-audit");
}

// ── Call LLM for Layout Plan (Multi-Step Pipeline Step 1) ───────────

export async function callLLMPlan(
  prompt: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  dsSummary?: any,
  referenceImageBase64?: string
): Promise<unknown> {
  let userPrompt = buildPlanPrompt(prompt, dsSummary);

  // Append reference image instruction if present
  if (referenceImageBase64) {
    userPrompt += `\n\n## Reference Image (HIGHEST PRIORITY FOR LAYOUT PLANNING)

A reference image is attached. Your layout plan MUST be based on this image.

ANALYZE the reference image and create blocks that match its ACTUAL structure:
- FIRST: determine if the reference is DESKTOP (wide, sidebar, multi-column) or MOBILE (narrow, stacked). Set the plan viewport accordingly — do NOT force mobile if the reference is desktop, even if the prompt mentions "mobile" or "app".
- If the reference has a sidebar navigation, include a sidebar block (~200-250px FIXED width, NOT 50% of the screen)
- If the reference has stat/metric cards in a row, include a stats-row block (HORIZONTAL, not stacked vertically)
- If the reference has a chart section, include a chart block
- If the reference has a data table or transaction list, include that block
- Match the NUMBER of sections and their ARRANGEMENT from the reference
- Match PROPORTIONS: if the sidebar is narrow (~15%), specify ~200-250px. If content sections share a row, specify equal widths.
- For EACH block, note the visual richness needed: icons, card surfaces, progress bars, colored indicators, shadows

Do NOT fall back to a generic "hero → features → CTA" template. The plan must reflect what is ACTUALLY VISIBLE in the reference image. The reference image's viewport type OVERRIDES any mention of "mobile" or "desktop" in the user's prompt.`;
  }

  console.log(`[callLLMPlan] System: ${PLAN_SYSTEM_PROMPT.length} chars, User: ${userPrompt.length} chars${referenceImageBase64 ? `, refImage: ${referenceImageBase64.length} chars` : ""}`);

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;
  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    if (referenceImageBase64) {
      raw = await callProviderWithImage(provider, PLAN_SYSTEM_PROMPT, userPrompt, referenceImageBase64, resolvedModel, 4096, apiKey, abort, true);
    } else {
      raw = await callProvider(provider, PLAN_SYSTEM_PROMPT, userPrompt, resolvedModel, 4096, apiKey, abort, true, 0.4);
    }
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-plan");
}

// ── Call LLM for Visual Refinement (Multi-Step Pipeline Step 3) ─────

export async function callLLMRefine(
  nodeTree: string,
  prompt: string,
  imageBase64: string,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string
): Promise<unknown> {
  const userPrompt = buildRefinePrompt(nodeTree, prompt);
  console.log(`[callLLMRefine] System: ${REFINE_SYSTEM_PROMPT.length} chars, User: ${userPrompt.length} chars, Image: ${imageBase64.length} chars`);

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;
  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProviderWithImage(provider, REFINE_SYSTEM_PROMPT, userPrompt, imageBase64, resolvedModel, 8192, apiKey, abort, true);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-refine");
}
