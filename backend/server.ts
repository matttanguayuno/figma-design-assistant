// backend/server.ts
// Minimal Express server for the DesignOps AI backend.
// Endpoints:
//   POST /plan   — receive intent + snapshots, call LLM, validate, return batch

import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import express, { Request, Response } from "express";
import cors from "cors";
import { callLLM, callLLMGenerate, cancelCurrentRequest } from "./llm";
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

// ── Health check ────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ── POST /cancel ────────────────────────────────────────────────────

app.post("/cancel", (_req: Request, res: Response) => {
  cancelCurrentRequest();
  res.json({ status: "cancelled" });
});

// ── POST /plan ──────────────────────────────────────────────────────

app.post("/plan", async (req: Request, res: Response) => {
  try {
    const { intent, selection, designSystem, apiKey } = req.body;

    // API key is required (per-user)
    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key. Please configure your Anthropic API key in Settings." });
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

    console.log(`[plan] intent="${intent}", nodes=${selection.nodes.length}`);

    // 1. Call LLM
    const rawBatch = await callLLM(intent, selection, designSystem, apiKey);
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
    const { prompt, styleTokens, designSystem, apiKey } = req.body;

    // API key is required (per-user)
    if (!apiKey || typeof apiKey !== "string") {
      res.status(401).json({ error: "Missing API key. Please configure your Anthropic API key in Settings." });
      return;
    }

    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing or invalid 'prompt'" });
      return;
    }

    console.log(`[generate] prompt="${prompt}"`);
    console.log(`[generate] styleTokens:`, JSON.stringify(styleTokens).slice(0, 1000));
    console.log(`[generate] designSystem textStyles:`, JSON.stringify(designSystem?.textStyles || []).slice(0, 500));

    // 1. Call LLM to generate a NodeSnapshot
    const snapshot = await callLLMGenerate(
      prompt,
      styleTokens || {},
      designSystem || { textStyles: [], fillStyles: [], components: [], variables: [] },
      apiKey
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

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`DesignOps AI backend running on http://localhost:${PORT}`);
  console.log(`  POST /plan     — generate operation batch`);
  console.log(`  POST /generate — generate new frame from prompt`);
  console.log(`  GET  /health   — health check`);
});
