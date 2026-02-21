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
  model?: string
): Promise<unknown> {
  const userPrompt = buildUserPrompt(intent, selection, designSystem);
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

// ── Call LLM for Frame Generation ───────────────────────────────────

export async function callLLMGenerate(
  prompt: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  apiKey: string,
  provider: Provider = "anthropic",
  model?: string,
  selection?: any
): Promise<unknown> {
  const userPrompt = buildGeneratePrompt(prompt, styleTokens, designSystem, selection);
  const resolvedModel = model || PROVIDER_MODELS[provider][0].id;

  const abort = new AbortController();
  _activeAbort = abort;

  let raw: string;
  try {
    raw = await callProvider(provider, GENERATE_SYSTEM_PROMPT, userPrompt, resolvedModel, 16384, apiKey, abort);
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  return parseJsonResponse(raw, "llm-generate");
}
