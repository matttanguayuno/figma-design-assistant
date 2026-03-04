// backend/llm.ts
// Multi-provider LLM wrapper — supports Anthropic, OpenAI, and Google Gemini.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt, GENERATE_SYSTEM_PROMPT, buildGeneratePrompt, GENERATE_HTML_SYSTEM_PROMPT, buildGenerateHTMLPrompt, PLAN_SYSTEM_PROMPT, buildPlanPrompt, REFINE_SYSTEM_PROMPT, buildRefinePrompt } from "./promptBuilder";

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
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o Mini" },
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
  layoutPlan?: any
): Promise<unknown> {
  const userPrompt = buildGeneratePrompt(prompt, styleTokens, designSystem, selection, fullDesignSystem, dsSummary, layoutPlan);
  console.log(`[callLLMGenerate] System prompt: ${GENERATE_SYSTEM_PROMPT.length} chars, User prompt: ${userPrompt.length} chars, TOTAL: ${GENERATE_SYSTEM_PROMPT.length + userPrompt.length} chars (~${Math.round((GENERATE_SYSTEM_PROMPT.length + userPrompt.length)/4)} tokens)`);

  // Hard safety: if the user prompt exceeds ~500K chars (~125K tokens), truncate it
  const MAX_USER_PROMPT_CHARS = 500000;
  let safeUserPrompt = userPrompt;
  if (userPrompt.length > MAX_USER_PROMPT_CHARS) {
    console.warn(`[callLLMGenerate] User prompt too long (${userPrompt.length} chars), truncating to ${MAX_USER_PROMPT_CHARS}`);
    safeUserPrompt = userPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "\n\n[PROMPT TRUNCATED — generate based on the content above]";
  }

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, GENERATE_SYSTEM_PROMPT, safeUserPrompt, resolvedModel, 16384, apiKey, abort, true, 0.5);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-generate");
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
  dsSummary?: any
): Promise<string> {
  const userPrompt = buildGenerateHTMLPrompt(prompt, styleTokens, designSystem, selection, fullDesignSystem, dsSummary);
  console.log(`[callLLMGenerateHTML] System prompt: ${GENERATE_HTML_SYSTEM_PROMPT.length} chars, User prompt: ${userPrompt.length} chars, TOTAL: ${GENERATE_HTML_SYSTEM_PROMPT.length + userPrompt.length} chars (~${Math.round((GENERATE_HTML_SYSTEM_PROMPT.length + userPrompt.length)/4)} tokens)`);

  const MAX_USER_PROMPT_CHARS = 500000;
  let safeUserPrompt = userPrompt;
  if (userPrompt.length > MAX_USER_PROMPT_CHARS) {
    console.warn(`[callLLMGenerateHTML] User prompt too long (${userPrompt.length} chars), truncating to ${MAX_USER_PROMPT_CHARS}`);
    safeUserPrompt = userPrompt.slice(0, MAX_USER_PROMPT_CHARS) + "\n\n[PROMPT TRUNCATED — generate based on the content above]";
  }

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    // Higher max tokens since HTML can be verbose; temperature 0.5 for creativity
    raw = await callProvider(provider, GENERATE_HTML_SYSTEM_PROMPT, safeUserPrompt, resolvedModel, 16384, apiKey, abort, false, 0.5);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  // The LLM should return raw HTML, not JSON. Strip any markdown fences.
  let html = raw.trim();
  if (html.startsWith("```html")) {
    html = html.slice(7);
  } else if (html.startsWith("```")) {
    html = html.slice(3);
  }
  if (html.endsWith("```")) {
    html = html.slice(0, -3);
  }
  html = html.trim();

  // Validate it looks like HTML
  if (!html.includes("<") || !html.includes(">")) {
    throw new Error("LLM returned non-HTML content");
  }

  console.log(`[callLLMGenerateHTML] HTML output: ${html.length} chars`);
  return html;
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
  dsSummary?: any
): Promise<unknown> {
  const userPrompt = buildPlanPrompt(prompt, dsSummary);
  console.log(`[callLLMPlan] System: ${PLAN_SYSTEM_PROMPT.length} chars, User: ${userPrompt.length} chars`);

  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;
  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, PLAN_SYSTEM_PROMPT, userPrompt, resolvedModel, 4096, apiKey, abort, true, 0.4);
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
