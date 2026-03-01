// backend/llm.ts
// Multi-provider LLM wrapper — supports Anthropic, OpenAI, and Google Gemini.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt, GENERATE_SYSTEM_PROMPT, buildGeneratePrompt } from "./promptBuilder";

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
  abort: AbortController
): Promise<string> {
  const client = getAnthropicClient(apiKey);
  // Use streaming to avoid Anthropic's "Streaming is required for long requests" error
  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
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

// ── OpenAI implementation ───────────────────────────────────────────

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  maxTokens: number,
  apiKey: string,
  abort: AbortController
): Promise<string> {
  const client = getOpenAIClient(apiKey);
  const completion = await client.chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    },
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
  abort: AbortController
): Promise<string> {
  const client = getGeminiClient(apiKey);
  const genModel = client.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
    },
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
  abort: AbortController
): Promise<string> {
  switch (provider) {
    case "anthropic":
      return callAnthropic(systemPrompt, userPrompt, model, maxTokens, apiKey, abort);
    case "openai":
      return callOpenAI(systemPrompt, userPrompt, model, maxTokens, apiKey, abort);
    case "gemini":
      return callGemini(systemPrompt, userPrompt, model, maxTokens, apiKey, abort);
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
  model?: string
): Promise<unknown> {
  const systemPrompt =
    "You are a design layout analyzer. You MUST return ONLY valid JSON — no markdown fences, no prose, no explanation. " +
    "When asked to analyze multiple items, ALWAYS respond with a JSON ARRAY (wrapped in square brackets [ ]). " +
    "Never return a single object — always wrap it in an array, even if there is only one item.";
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, systemPrompt, prompt, resolvedModel, 8192, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "analyze");
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
  fullDesignSystem?: any
): Promise<unknown> {
  const userPrompt = buildGeneratePrompt(prompt, styleTokens, designSystem, selection, fullDesignSystem);
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
    raw = await callProvider(provider, GENERATE_SYSTEM_PROMPT, safeUserPrompt, resolvedModel, 16384, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-generate");
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
