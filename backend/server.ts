// backend/server.ts
// Minimal Express server for the DesignOps AI backend.
// Endpoints:
//   POST /plan   — receive intent + snapshots, call LLM, validate, return batch

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import express, { Request, Response } from "express";
import cors from "cors";
import { callLLM, callLLMAnalyze, callLLMGenerate, callLLMAudit, callLLMStateAudit, callLLMAuditFix, cancelCurrentRequest, PROVIDER_MODELS, PROVIDER_LABELS, Provider } from "./llm";
import { validateOperationBatch } from "./validator";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

async function resolveImagePrompt(prompt: string): Promise<string> {
  console.log(`[image] Searching for image matching: "${prompt}"`);

  // Use Unsplash search API to find a relevant photo
  const searchUrl = `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(prompt)}&per_page=3`;
  const searchResp = await fetch(searchUrl);
  if (!searchResp.ok) {
    throw new Error(`Unsplash search failed (${searchResp.status})`);
  }
  const searchData = await searchResp.json() as any;

  if (!searchData.results || searchData.results.length === 0) {
    throw new Error(`No images found for prompt: "${prompt}"`);
  }

  // Pick the top result (most relevant) instead of random
  const imageUrl = searchData.results[0].urls?.small;
  if (!imageUrl) {
    throw new Error("Unsplash result missing image URL");
  }

  console.log(`[image] Downloading: ${imageUrl.slice(0, 80)}...`);

  // Download the actual image
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) {
    throw new Error(`Image download failed (${imgResp.status})`);
  }
  const arrayBuffer = await imgResp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Return as base64 string so plugin can use figma.createImage(bytes)
  const base64 = buffer.toString("base64");
  console.log(`[image] Encoded ${buffer.length} bytes as base64 (${base64.length} chars)`);
  return base64;
}

// ── Middleware ───────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Increase server-level timeout to 5 minutes for long LLM calls
app.use((_req, _res, next) => {
  _req.setTimeout(300_000);  // 5 min
  _res.setTimeout(300_000);
  next();
});

// ── Health check ────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ── GET /models ─────────────────────────────────────────────────────

app.get("/models", (_req: Request, res: Response) => {
  res.json({
    providers: Object.entries(PROVIDER_MODELS).map(([key, models]) => ({
      id: key,
      label: PROVIDER_LABELS[key as Provider],
      models,
    })),
  });
});

// ── POST /validate-key ──────────────────────────────────────────────

app.post("/validate-key", async (req: Request, res: Response) => {
  try {
    const { apiKey, provider } = req.body;
    if (!apiKey || typeof apiKey !== "string") {
      res.status(400).json({ valid: false, error: "Missing API key." });
      return;
    }
    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ valid: false, error: `Unknown provider: ${provider}` });
      return;
    }

    console.log(`[validate-key] Testing ${resolvedProvider} key ending …${apiKey.slice(-4)}`);

    if (resolvedProvider === "anthropic") {
      const client = new (await import("@anthropic-ai/sdk")).default({ apiKey });
      await client.messages.create({
        model: "claude-haiku-4-20250414",
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      });
    } else if (resolvedProvider === "openai") {
      const { default: OpenAILib } = await import("openai");
      const client = new OpenAILib({ apiKey });
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      });
    } else if (resolvedProvider === "gemini") {
      const { GoogleGenerativeAI: GeminiLib } = await import("@google/generative-ai");
      const client = new GeminiLib(apiKey);
      const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      await model.generateContent("Hi");
    }

    console.log(`[validate-key] ${resolvedProvider} key is valid`);
    res.json({ valid: true });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[validate-key] Failed:`, msg);

    // Detect common auth / billing errors
    let userMessage = "Invalid API key or connection error.";
    if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid") || msg.includes("Incorrect API key")) {
      userMessage = "Invalid API key. Please check and try again.";
    } else if (msg.includes("402") || msg.includes("insufficient") || msg.includes("billing") || msg.includes("quota")) {
      userMessage = "API key is valid but your account has insufficient credits or billing is not set up.";
    } else if (msg.includes("403") || msg.includes("permission")) {
      userMessage = "API key does not have permission to access this model.";
    } else if (msg.includes("429") || msg.includes("rate")) {
      userMessage = "API key is valid (rate limited — try again shortly).";
      // Rate limited means the key itself is valid
      res.json({ valid: true, warning: userMessage });
      return;
    }
    res.json({ valid: false, error: userMessage });
  }
});

// ── POST /cancel ────────────────────────────────────────────────────

app.post("/cancel", (_req: Request, res: Response) => {
  cancelCurrentRequest();
  res.json({ status: "cancelled" });
});

// ── POST /analyze — free-form LLM call (no operations schema) ──────

app.post("/analyze", async (req: Request, res: Response) => {
  try {
    const { prompt, apiKey, provider, model } = req.body;

    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key." });
      return;
    }
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing 'prompt'" });
      return;
    }

    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    console.log(`[analyze] provider=${resolvedProvider}, model=${model || "default"}, prompt=${prompt.length} chars`);

    const result = await callLLMAnalyze(prompt, apiKey, resolvedProvider, model);
    console.log(`[analyze] LLM returned:`, JSON.stringify(result).slice(0, 300));

    res.json(result);
  } catch (err: any) {
    console.error("[analyze] Error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
});

// ── POST /plan ──────────────────────────────────────────────────────

app.post("/plan", async (req: Request, res: Response) => {
  try {
    const { intent, selection, designSystem, fullDesignSystem, apiKey, provider, model } = req.body;

    // API key is required (per-user)
    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key. Please configure your API key in Settings." });
      return;
    }

    // Validate provider
    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    // Basic input validation
    if (!intent || typeof intent !== "string") {
      res.status(400).json({ error: "Missing or invalid 'intent'" });
      return;
    }
    if (!selection || !Array.isArray(selection.nodes)) {
      res.status(400).json({ error: "Missing or invalid 'selection'" });
      return;
    }
    if (!designSystem) {
      res.status(400).json({ error: "Missing 'designSystem'" });
      return;
    }

    // --- Safety: truncate selection nodes to prevent token overflow ---
    const selJson = JSON.stringify(selection.nodes);
    console.log(`[plan] provider=${resolvedProvider}, model=${model || "default"}, intent="${intent}", nodes=${selection.nodes.length}, selectionSize=${selJson.length}`);
    if (selJson.length > 80000) {
      console.warn(`[plan] Selection too large (${selJson.length} chars), truncating nodes`);
      // Keep first 80K chars worth of nodes
      let accumulated = 0;
      const trimmedNodes: any[] = [];
      for (const node of selection.nodes) {
        const nodeJson = JSON.stringify(node);
        if (accumulated + nodeJson.length > 80000 && trimmedNodes.length > 0) break;
        trimmedNodes.push(node);
        accumulated += nodeJson.length;
      }
      selection.nodes = trimmedNodes;
      console.log(`[plan] Trimmed to ${trimmedNodes.length} nodes, ~${accumulated} chars`);
    }
    if (designSystem) {
      if (Array.isArray(designSystem.components) && designSystem.components.length > 12) {
        designSystem.components = designSystem.components.slice(0, 12);
      }
      if (Array.isArray(designSystem.variables) && designSystem.variables.length > 12) {
        designSystem.variables = designSystem.variables.slice(0, 12);
      }
    }

    // Truncate fullDesignSystem if present (cap at ~30K chars to stay within token budget)
    let safeFullDS = fullDesignSystem || null;
    if (safeFullDS) {
      const fdJson = JSON.stringify(safeFullDS);
      if (fdJson.length > 30000) {
        console.warn(`[plan] fullDesignSystem too large (${fdJson.length} chars), trimming...`);
        safeFullDS = {
          ...safeFullDS,
          colorPalette: (safeFullDS.colorPalette || []).slice(0, 30),
          components: (safeFullDS.components || []).slice(0, 20),
          variables: (safeFullDS.variables || []).slice(0, 20),
          typographyScale: (safeFullDS.typographyScale || []).slice(0, 15),
          buttonStyles: (safeFullDS.buttonStyles || []).slice(0, 5),
          inputStyles: (safeFullDS.inputStyles || []).slice(0, 5),
        };
      }
      console.log(`[plan] fullDesignSystem: ${safeFullDS.colorPalette?.length || 0} colors, ${safeFullDS.components?.length || 0} components, ${safeFullDS.variables?.length || 0} variables`);
    }

    // 1. Call LLM
    const analyzeMode = req.query.analyze === "true";
    if (analyzeMode) {
      // Free-form analysis mode: skip operations system prompt and validation
      const imageBase64 = req.body.imageBase64 || undefined;
      if (imageBase64) {
        console.log(`[plan/analyze] Including screenshot (${imageBase64.length} chars base64)`);
      }
      const result = await callLLMAnalyze(intent, apiKey, resolvedProvider, model, imageBase64);
      console.log(`[plan/analyze] LLM returned:`, JSON.stringify(result).slice(0, 300));
      res.json(result);
      return;
    }

    const rawBatch = await callLLM(intent, selection, designSystem, apiKey, resolvedProvider, model, safeFullDS);
    console.log(`[plan] LLM returned:`, JSON.stringify(rawBatch).slice(0, 300));

    // 2. Validate
    const lenient = req.query.lenient === "true";
    const result = validateOperationBatch(rawBatch, selection, designSystem, lenient);

    if (!result.valid) {
      console.warn("[plan] Validation failed:", result.errors);
      res.status(422).json({
        error: "LLM response failed validation",
        details: result.errors,
      });
      return;
    }

    console.log(
      `[plan] Returning ${result.batch!.operations.length} operations`
    );

    // 3. Resolve SET_IMAGE prompts to base64 image data
    const batch = result.batch!;
    for (let i = 0; i < batch.operations.length; i++) {
      const op = batch.operations[i];
      if (op.type === "SET_IMAGE") {
        try {
          console.log(`[plan] SET_IMAGE imagePrompt from LLM: "${op.imagePrompt}"`);
          const base64 = await resolveImagePrompt(op.imagePrompt);
          batch.operations[i] = { ...op, imageBase64: base64 } as any;
          console.log(`[plan] SET_IMAGE resolved, base64 length: ${base64.length}`);
        } catch (imgErr: any) {
          console.warn(`[plan] Image resolution failed: ${imgErr.message}`);
        }
      }
    }

    res.json(batch);
  } catch (err: any) {
    console.error("[plan] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate ──────────────────────────────────────────────────

app.post("/generate", async (req: Request, res: Response) => {
  try {
    const { prompt, styleTokens, designSystem, selection, fullDesignSystem, apiKey, provider, model } = req.body;

    // API key is required (per-user)
    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key. Please configure your API key in Settings." });
      return;
    }

    // Validate provider
    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing or invalid 'prompt'" });
      return;
    }

    console.log(`[generate] provider=${resolvedProvider}, model=${model || "default"}, prompt="${prompt}"`);
    console.log(`[generate] styleTokens:`, JSON.stringify(styleTokens).slice(0, 1000));
    console.log(`[generate] designSystem textStyles:`, JSON.stringify(designSystem?.textStyles || []).slice(0, 500));

    // Log incoming payload sizes to debug token budget issues
    const selectionJson = JSON.stringify(selection || null);
    const styleTokensJson = JSON.stringify(styleTokens || {});
    const designSystemJson = JSON.stringify(designSystem || {});
    console.log(`[generate] PAYLOAD SIZES — selection: ${selectionJson.length} chars, styleTokens: ${styleTokensJson.length} chars, designSystem: ${designSystemJson.length} chars, TOTAL: ${selectionJson.length + styleTokensJson.length + designSystemJson.length} chars`);

    // Hard-truncate selection nodes if they're still too large
    let safeSelection = selection || null;
    if (selectionJson.length > 250000) {
      console.warn(`[generate] Selection too large (${selectionJson.length} chars), truncating nodes...`);
      safeSelection = { nodes: (selection?.nodes || []).map((n: any) => {
        const nodeJson = JSON.stringify(n);
        if (nodeJson.length > 200000) {
          return JSON.parse(nodeJson.slice(0, 200000).replace(/,[^,]*$/, '') + '}');
        }
        return n;
      }) };
    }
    // Hard-truncate designSystem components/variables
    const safeDesignSystem = {
      textStyles: (designSystem?.textStyles || []).slice(0, 12),
      fillStyles: (designSystem?.fillStyles || []).slice(0, 12),
      components: (designSystem?.components || []).slice(0, 20),
      variables: (designSystem?.variables || []).slice(0, 20),
    };
    // Hard-truncate referenceSnapshots in styleTokens
    const safeStyleTokens = { ...(styleTokens || {}) };
    if (safeStyleTokens.referenceSnapshots?.length > 0) {
      safeStyleTokens.referenceSnapshots = safeStyleTokens.referenceSnapshots.slice(0, 2).map((s: any) => {
        const sJson = JSON.stringify(s);
        if (sJson.length > 80000) {
          return JSON.parse(sJson.slice(0, 80000).replace(/,[^,]*$/, '') + '}');
        }
        return s;
      });
    }

    // Truncate fullDesignSystem if present
    let safeFullDS = fullDesignSystem || null;
    if (safeFullDS) {
      const fdJson = JSON.stringify(safeFullDS);
      if (fdJson.length > 30000) {
        safeFullDS = {
          ...safeFullDS,
          colorPalette: (safeFullDS.colorPalette || []).slice(0, 30),
          components: (safeFullDS.components || []).slice(0, 20),
          variables: (safeFullDS.variables || []).slice(0, 20),
          typographyScale: (safeFullDS.typographyScale || []).slice(0, 15),
          buttonStyles: (safeFullDS.buttonStyles || []).slice(0, 5),
          inputStyles: (safeFullDS.inputStyles || []).slice(0, 5),
        };
      }
    }

    // 1. Call LLM to generate a NodeSnapshot
    const snapshot = await callLLMGenerate(
      prompt,
      safeStyleTokens,
      safeDesignSystem,
      apiKey,
      resolvedProvider,
      model,
      safeSelection,
      safeFullDS
    );

    console.log(`[generate] LLM returned snapshot:`, JSON.stringify(snapshot).slice(0, 500));

    // Basic validation: must have type and name
    if (!snapshot || typeof snapshot !== "object" || !(snapshot as any).type) {
      res.status(422).json({ error: "LLM returned an invalid frame structure" });
      return;
    }

    res.json({ snapshot });
  } catch (err: any) {
    console.error("[generate] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /audit ─────────────────────────────────────────────────────

app.post("/audit", async (req: Request, res: Response) => {
  try {
    const { findings, apiKey, provider, model } = req.body;

    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key." });
      return;
    }

    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    if (!findings || !Array.isArray(findings) || findings.length === 0) {
      res.status(400).json({ error: "No findings to analyze." });
      return;
    }

    console.log(`[audit] provider=${resolvedProvider}, model=${model || "default"}, findings=${findings.length}`);

    const result = await callLLMAudit(findings, apiKey, resolvedProvider, model);
    console.log(`[audit] LLM returned:`, JSON.stringify(result).slice(0, 500));

    res.json(result);
  } catch (err: any) {
    console.error("[audit] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /audit-fix ──────────────────────────────────────────────────────

app.post("/audit-fix", async (req: Request, res: Response) => {
  try {
    const { finding, apiKey, provider, model } = req.body;

    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key." });
      return;
    }

    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    if (!finding || typeof finding !== "object") {
      res.status(400).json({ error: "No finding provided." });
      return;
    }

    console.log(`[audit-fix] provider=${resolvedProvider}, model=${model || "default"}, checkType=${finding.checkType}`);

    const result = await callLLMAuditFix(finding, apiKey, resolvedProvider, model);
    console.log(`[audit-fix] LLM returned:`, JSON.stringify(result).slice(0, 500));

    res.json(result);
  } catch (err: any) {
    console.error("[audit-fix] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /audit-states ───────────────────────────────────────────────────

app.post("/audit-states", async (req: Request, res: Response) => {
  try {
    const { items, apiKey, provider, model } = req.body;

    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key." });
      return;
    }

    const resolvedProvider: Provider = provider || "anthropic";
    if (!PROVIDER_MODELS[resolvedProvider]) {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
      return;
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "No items to audit." });
      return;
    }

    console.log(`[audit-states] provider=${resolvedProvider}, model=${model || "default"}, items=${items.length}`);

    const result = await callLLMStateAudit(items, apiKey, resolvedProvider, model);
    console.log(`[audit-states] LLM returned:`, JSON.stringify(result).slice(0, 500));

    res.json(result);
  } catch (err: any) {
    console.error("[audit-states] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`DesignOps AI backend running on http://localhost:${PORT}`);
  console.log(`  POST /plan          — generate operation batch`);
  console.log(`  POST /generate      — generate new frame from prompt`);
  console.log(`  POST /audit         — accessibility audit enrichment`);
  console.log(`  POST /audit-fix     — LLM-assisted audit fix`);
  console.log(`  POST /audit-states  — UI state completeness audit`);
  console.log(`  GET  /health        — health check`);
});
