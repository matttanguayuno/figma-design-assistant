# Frame Generation Improvement Plan

## Goal
Elevate new frame draft generation quality to match tools like Figma First Draft / Pencil.dev.

---

## Phase 1 — Prompt Engineering & LLM Tuning (Highest Impact, Lowest Effort)

The current `GENERATE_SYSTEM_PROMPT` (promptBuilder.ts L376-475) is heavily focused on structural correctness but gives almost no guidance on **visual design quality**. Temperature is also unset (defaults to 1.0 which is too high for structured JSON output).

1. **Set temperature to 0.4–0.6** in `callLLMGenerate()` (llm.ts L545) for all three providers.

2. **Add a "Design Principles" section** to `GENERATE_SYSTEM_PROMPT` covering:
   - Visual hierarchy (headings > subheadings > body > caption, with concrete font size ratios)
   - Spacing rhythm (8px grid system — padding/spacing should be multiples of 4 or 8)
   - Section composition patterns per screen type
   - Card/container patterns (subtle background fill, 12-16px radius, drop shadow)
   - CTA hierarchy (primary filled, secondary outlined, tertiary text-only)

3. **Add screen-type templates** — ~15-20 common screen archetypes with expected node trees, injected conditionally based on keyword matching.

4. **Increase minimum node count guidance** — specify per-archetype (e.g., reviews section = 30-50 nodes).

5. **Add explicit "polish" rules**: subtle shadows on cards, alternating section backgrounds, opacity/secondary colors for metadata, ≥44px touch targets on mobile.

---

## Phase 2 — Multi-Pass Visual Refinement (High Impact)

Adapt the existing visual review loop (code.ts L10331+) to post-generation refinement.

1. After `createNodeFromSnapshot()`, take a screenshot via `node.exportAsync()`.
2. Send screenshot to a "refine" LLM call to identify visual quality issues.
3. Apply returned edit operations (existing 16 operation types).
4. Optional second pass — re-screenshot and verify. Cap at 2 passes.
5. Wire into `runGenerateJob()` after node creation, before select-and-zoom.

---

## Phase 3 — Icon Support (Medium Impact)

1. **SVG injection approach** — Bundle ~100-200 common icons (Material Symbols / Phosphor) as SVG path data in a JSON map. AI references icons by name, `createNodeFromSnapshot` creates vector nodes from SVG paths.
2. **Extend `NodeSnapshot`** with `iconName?: string`.
3. **Update `GENERATE_SYSTEM_PROMPT`** with available icon names.
4. **Update `createNodeFromSnapshot`** — when RECTANGLE has `iconName`, look up SVG data and create vector/image fill.
5. **Curate icon set**: navigation, actions, content, status, social, misc (~100-200 icons).

---

## Phase 4 — Component Instance Reuse (Medium Impact, Higher Effort)

1. Build a **component catalog** during `extractDesignSystemSnapshot()`.
2. Inject catalog into generate prompt with component names, variants, keys.
3. Extend `NodeSnapshot` with `componentKey?: string` and `variantProperties?: Record<string, string>`.
4. Update `createNodeFromSnapshot` — when `type === "INSTANCE"`, use `figma.importComponentByKeyAsync()`.
5. Hybrid approach — prefer INSTANCE when available, fall back to primitives.

---

## Phase 5 — Better Image Handling & Responsive Intelligence

1. **Image placeholders** — Add `imagePrompt?: string` to NodeSnapshot, call `resolveImagePrompt()` during creation.
2. **Responsive variant generation** — detect "mobile"/"desktop"/"responsive" in prompt, generate at appropriate widths.
3. **Breakpoint-aware layout rules** — mobile = single column 390px, tablet = 768px 2-col, desktop = 1440px multi-column.

---

## Key Files

| File | Purpose |
|------|---------|
| `backend/promptBuilder.ts` L376-475 | GENERATE_SYSTEM_PROMPT |
| `backend/llm.ts` L545 | callLLMGenerate() — model, tokens, temperature |
| `figma-plugin/code.ts` L1944-2493 | createNodeFromSnapshot() |
| `figma-plugin/code.ts` L7604-7900 | runGenerateJob() |
| `figma-plugin/types.ts` L9-55 | NodeSnapshot type |
| `backend/server.ts` L327 | POST /generate endpoint |

---

## Verification

- Phase 1: Generate "reviews section for mobile," "login page," "settings screen," "pricing page" — compare before/after
- Phase 2: A/B compare first-pass vs. refined screenshot
- Phase 3: Verify icons render as vectors at 24px with color binding
- Phase 4: Confirm instances use real library components
- Phase 5: Test mobile vs desktop prompts, verify Unsplash images in placeholders
