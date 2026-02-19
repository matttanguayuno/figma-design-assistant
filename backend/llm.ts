// backend/llm.ts
// Thin wrapper around the Anthropic Claude API.

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, buildUserPrompt, GENERATE_SYSTEM_PROMPT, buildGeneratePrompt } from "./promptBuilder";

// ── Client ──────────────────────────────────────────────────────────

let client: Anthropic | null = null;

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

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is not set. " +
          "Set it before starting the backend."
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
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

// ── Call LLM ────────────────────────────────────────────────────────

export async function callLLM(
  intent: string,
  selection: SelectionSnapshot,
  designSystem: DesignSystemSnapshot
): Promise<unknown> {
  const anthropic = getClient();
  const userPrompt = buildUserPrompt(intent, selection, designSystem);

  const abort = new AbortController();
  _activeAbort = abort;

  let message;
  try {
    message = await anthropic.messages.create(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: abort.signal as any }
    );
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  // Extract text content
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("LLM returned no text content");
  }

  const raw = textBlock.text.trim();
  console.log(`[llm] Raw response: ${raw.slice(0, 500)}`);

  // Parse JSON — strip potential markdown fences if the model disobeys
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Try stripping ```json ... ``` wrapper
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      json = JSON.parse(match[1].trim());
    } else {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}…`);
    }
  }

  return json;
}

// ── Call LLM for Frame Generation ───────────────────────────────────

export async function callLLMGenerate(
  prompt: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot
): Promise<unknown> {
  const anthropic = getClient();
  const userPrompt = buildGeneratePrompt(prompt, styleTokens, designSystem);

  const abort = new AbortController();
  _activeAbort = abort;

  let message;
  try {
    message = await anthropic.messages.create(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 16384,
        system: GENERATE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: abort.signal as any }
    );
  } finally {
    if (_activeAbort === abort) _activeAbort = null;
  }

  // Extract text content
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("LLM returned no text content");
  }

  const raw = textBlock.text.trim();
  console.log(`[llm-generate] Raw response: ${raw.slice(0, 500)}`);

  // Parse JSON
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      json = JSON.parse(match[1].trim());
    } else {
      throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}…`);
    }
  }

  return json;
}
