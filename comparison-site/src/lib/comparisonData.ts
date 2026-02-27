/* ───────────────────────────────────────────────
 * Comparison Data Model & Seed Data
 * All content that drives the comparison page.
 * ─────────────────────────────────────────────── */

// ── Types ────────────────────────────────────────

export type CapabilityStatus = "strong" | "limited" | "none" | "unknown";

export interface Screenshot {
  src: string;
  alt: string;
  caption?: string;
}

export interface Cluster {
  id: string;
  title: string;
  summary: string;
  figmaStatus: CapabilityStatus;
  unoStatus: CapabilityStatus;
  figmaBullets: string[];
  unoBullets: string[];
  notes?: string[];
  screenshots?: Screenshot[];
  tags: string[];
}

export interface SideSnapshot {
  name: string;
  summary: string;
}

export interface RiskItem {
  title: string;
  detail: string;
}

export interface ComparisonData {
  figmaSnapshot: SideSnapshot;
  unoSnapshot: SideSnapshot;
  topDifferentiators: string[];
  clusters: Cluster[];
  risks: { ifFigmaAdds: RiskItem[]; moat: RiskItem[] };
}

// ── Status helpers ───────────────────────────────

export const STATUS_META: Record<
  CapabilityStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  strong: {
    label: "Strong",
    color: "text-emerald-400",
    bg: "bg-emerald-950/60",
    border: "border-emerald-700/50",
  },
  limited: {
    label: "Limited",
    color: "text-yellow-400",
    bg: "bg-yellow-950/50",
    border: "border-yellow-700/40",
  },
  none: {
    label: "Not Available",
    color: "text-red-400",
    bg: "bg-red-950/50",
    border: "border-red-700/40",
  },
  unknown: {
    label: "Unknown",
    color: "text-zinc-400",
    bg: "bg-zinc-800/60",
    border: "border-zinc-600/40",
  },
};

// ── All tags (derived at the bottom) ─────────────

export let ALL_TAGS: string[] = [];

// ── Seed data ────────────────────────────────────

export const COMPARISON_DATA: ComparisonData = {
  /* ── Executive Snapshot ────────────────────── */
  figmaSnapshot: {
    name: "Figma AI",
    summary:
      "Native AI features baked into Figma — prompt-to-UI (Figma Make), text rewrite, image generation/editing, layer renaming, auto-layout suggestions, and dev-mode code snippets. Broad but shallow; not deeply design-system-aware and limited at editing existing complex frames.",
  },
  unoSnapshot: {
    name: "Uno Design Assistant",
    summary:
      "A Figma plugin that extracts your file's full design system (styles, components, variables, tokens) and injects it into every AI call. Supports 9 models across 3 providers, 16 structured edit operations, responsive conversion, accessibility audits with auto-fix, and UI state coverage analysis.",
  },
  topDifferentiators: [
    "Design-system-aware generation — every prompt is enriched with your actual paint styles, text styles, components, variables, and spacing tokens",
    "Structural editing & refactoring — 16 operation types with deep resize logic, responsive mobile↔desktop conversion, and undo/revert",
    "Governance & QA audits — WCAG accessibility audit with auto-fix, UI state coverage audit, exportable reports, and canvas warning badges",
  ],

  /* ── Capability Clusters ───────────────────── */
  clusters: [
    // 1 — Generation
    {
      id: "generation",
      title: "Generation",
      summary:
        "Creating new UI frames from a natural-language prompt.",
      figmaStatus: "strong",
      unoStatus: "strong",
      figmaBullets: [
        "Figma Make: generate full frames from a text prompt",
        "Creates basic component structures with auto layout",
        "Produces placeholder text and simple styling",
        "Generally mobile or desktop presets",
      ],
      unoBullets: [
        "Prompt-to-UI with full DS context injected (up to 80 colors, 15 typography tokens, 25 components)",
        "Mode-aware paint-style binding: generated fills auto-bind to Light/ or Dark/ styles by hex match",
        "Text-style auto-binding (font family + weight + size → Figma text style)",
        "Smart frame sizing: 390px mobile or 1440px desktop based on prompt context",
        "Image/icon transplant from reference frames (matched by name)",
        "Multi-frame parallel generation — select multiple frames, one prompt spawns concurrent jobs",
        "Variant generation: select a frame, describe a variant → generated beside it matching source dimensions",
        "Collision-free canvas placement (5-candidate algorithm)",
      ],
      notes: [
        "Figma Make is faster for quick throwaway exploration; Uno shines when output must match an existing DS.",
      ],
      screenshots: [
        { src: "/screenshots/figma-make.png", alt: "Figma Make prompt UI", caption: "Figma Make — prompt-to-UI" },
        { src: "/screenshots/uno-generate.png", alt: "Uno Design Assistant generation", caption: "Uno — DS-aware generation with style binding" },
      ],
      tags: ["generation", "ds"],
    },

    // 2 — Editing & Refactor
    {
      id: "editing",
      title: "Editing & Refactor",
      summary:
        "Modifying existing frames via natural language or structured operations.",
      figmaStatus: "limited",
      unoStatus: "strong",
      figmaBullets: [
        "Text layer rewrite / shorten / expand / tone adjust",
        "Basic layer renaming and organization",
        "Auto-layout suggestions and conversion",
        "Limited ability to edit complex existing frames",
      ],
      unoBullets: [
        "16 structured operation types: RESIZE, MOVE, RENAME, DELETE, SET_LAYOUT_MODE, SET_LAYOUT_PROPS, SET_SIZE_MODE, APPLY_TEXT_STYLE, APPLY_FILL_STYLE, SET_TEXT, SET_IMAGE, SET_FILL_COLOR, INSERT_COMPONENT, CREATE_FRAME, CLONE_NODE, DUPLICATE_FRAME",
        "Deep RESIZE_NODE (~500 lines): proportional corner-radius scaling, recursive subtree scaling, grid-cell normalization, bottom-up tight-fit, ancestor propagation (15 levels), post-resize gap correction",
        "Post-resize AI refinement pass for layout fine-tuning",
        "Undo/revert system with deep state capture (fills, text, fonts, dimensions, positions, styles)",
        "Auto-classifies prompt intent as 'generate' vs 'edit' based on selection + keywords",
        "CLONE_NODE with sibling gap detection and parent propagation",
        "DELETE_NODE with sibling shifting and ancestor shrinking",
      ],
      notes: [
        "Figma AI edits are limited to text content and auto-layout hints. Uno performs structural refactors across the full node tree.",
      ],
      screenshots: [
        { src: "/screenshots/uno-edit-ops.png", alt: "Uno edit operations in action", caption: "Uno — 16 structured operations applied to a frame" },
      ],
      tags: ["editing", "refactor"],
    },

    // 3 — Design System Intelligence
    {
      id: "design-system",
      title: "Design System Intelligence",
      summary:
        "Understanding and utilizing your file's design tokens, styles, and components.",
      figmaStatus: "none",
      unoStatus: "strong",
      figmaBullets: [
        "No deep integration with your design system tokens",
        "Generated UI uses generic colors and typography",
        "No awareness of paint styles, text styles, or variable collections",
        "No theming support (Light/Dark)",
      ],
      unoBullets: [
        "Full cross-page DS extraction: paint styles, text styles, components (with variant properties), variables, spacing, padding, corner radii",
        "21 semantic color roles auto-inferred (primary, secondary, surface, on-primary, error, etc.)",
        "17 typography roles auto-inferred (display, heading1–6, body, caption, button, etc.)",
        "Theming detection: 'complete' (≥2 modes + COLOR vars), 'partial', or 'none'",
        "Mode-aware paint-style binding: 3 parallel hex→styleId maps (Light/, Dark/, Unscoped) with priority lookup",
        "Theme mode detection from prompt and frame names",
        "DS summary banner in plugin UI — expandable panel showing pages scanned, color/typography/component breakdown, theming status",
        "Cached to clientStorage with document-hash staleness detection",
        "Up to 80 colors injected into LLM prompts, grouped by role and mode",
      ],
      notes: [
        "This is Uno's strongest differentiator. Figma AI has no equivalent.",
      ],
      screenshots: [
        { src: "/screenshots/uno-ds-banner.png", alt: "Uno DS summary banner", caption: "Uno — expandable DS summary with token breakdown" },
        { src: "/screenshots/uno-style-binding.png", alt: "Uno paint style binding", caption: "Uno — auto-bound paint styles (Light/Dark)" },
      ],
      tags: ["ds", "theming", "tokens"],
    },

    // 4 — Responsive Conversion
    {
      id: "responsive",
      title: "Responsive Conversion",
      summary:
        "Converting designs between mobile and desktop layouts.",
      figmaStatus: "none",
      unoStatus: "strong",
      figmaBullets: [
        "No built-in responsive conversion capability",
        "Users must manually rebuild frames for different breakpoints",
        "Auto-layout can help with spacing but doesn't restructure layouts",
      ],
      unoBullets: [
        "Automatic mobile↔desktop detection from prompt intent",
        "Programmatic pre-processing pipeline before LLM:",
        "— Bottom nav scoring and migration to top desktop nav",
        "— Header element merging (search bars, cart/account icons)",
        "— Card list detection (3+ similar children) → horizontal wrap grid",
        "— Hero/banner detection and transformation (side-by-side layout, text scaling, image capping)",
        "— Desktop padding/spacing scaling, recursive FILL sizing, clipsContent enforcement",
        "Post-variant WCAG contrast safety net: walks all text + icon nodes, fixes any below 4.5:1 ratio",
      ],
      notes: [
        "Responsive conversion is fully absent from Figma AI. This is a unique capability.",
      ],
      screenshots: [
        { src: "/screenshots/uno-responsive-conversion.png", alt: "Uno responsive conversion", caption: "Uno — mobile-to-desktop conversion pipeline" },
      ],
      tags: ["responsive", "layout"],
    },

    // 5 — Accessibility & Governance
    {
      id: "accessibility",
      title: "Accessibility & Governance",
      summary:
        "Auditing designs for WCAG compliance, component state coverage, and quality.",
      figmaStatus: "none",
      unoStatus: "strong",
      figmaBullets: [
        "No built-in accessibility audit",
        "No WCAG contrast checking",
        "No touch-target validation",
        "No component state coverage analysis",
        "Third-party plugins exist but are separate tools",
      ],
      unoBullets: [
        "5 accessibility checks: contrast (WCAG AA 4.5:1 / 3.0:1), font size (<12px), empty text, touch target (<44×44px), low opacity (<0.4)",
        "Auto-fix system: deterministic fixes for contrast (binary search), font size, touch target (padding expansion), opacity",
        "AI Fix per finding via LLM for nuanced corrections",
        "Fix All button for batch remediation",
        "Canvas warning badges (red/orange) placed on violating nodes",
        "UI State Audit: component variant coverage (Default, Hover, Pressed, Focused, Disabled, Loading, Error) + screen state coverage (Default, Empty, Loading, Error, Skeleton)",
        "Click-to-navigate: selecting a finding zooms to the node on canvas",
        "Export results as Markdown or JSON with timestamps",
        "Audit changelog: hidden canvas frame recording timestamped AI actions",
      ],
      notes: [
        "Governance audits are completely absent from native Figma AI. This is a key differentiator for enterprise teams.",
      ],
      screenshots: [
        { src: "/screenshots/uno-accessibility-audit.png", alt: "Uno accessibility audit panel", caption: "Uno — WCAG audit with auto-fix" },
        { src: "/screenshots/uno-state-audit.png", alt: "Uno state audit panel", caption: "Uno — component state coverage analysis" },
      ],
      tags: ["accessibility", "governance", "audit"],
    },

    // 6 — Workflow / Engineering Layer
    {
      id: "workflow",
      title: "Workflow / Engineering Layer",
      summary:
        "Model choice, import/export, progress UX, and developer-facing features.",
      figmaStatus: "limited",
      unoStatus: "strong",
      figmaBullets: [
        "Locked to Figma's internal model — no choice of provider or model",
        "Dev Mode: code snippets and handoff help (not production-grade)",
        "No import/export of frames as structured data",
        "No design-docs generation",
      ],
      unoBullets: [
        "9 models across 3 providers: Claude Opus 4 / Sonnet 4 / Haiku 4, GPT-4o / GPT-4o Mini / o3-mini, Gemini 2.5 Pro / 2.5 Flash / 2.0 Flash",
        "Per-provider API key storage with live validation",
        "Cancel in-flight LLM calls at any time (AbortController propagated to backend)",
        "Export frames to JSON (with embedded base64 images + DS context)",
        "Import from JSON with collision avoidance and relative position preservation",
        "Export Design Docs as Markdown (with GitHub Copilot front matter): color palette, typography scale, spacing, button/input specs, component inventory",
        "Segmented 3-phase progress bar with S-curve fill and adaptive timing estimates",
        "Parallel job cards with individual cancel and per-job progress",
        "Yield-to-UI async batching (prevents Figma thread blocking)",
      ],
      notes: [
        "Figma's Dev Mode AI assists with handoff but doesn't offer model choice, structured export, or design-docs generation.",
      ],
      screenshots: [
        { src: "/screenshots/uno-settings.png", alt: "Uno settings panel", caption: "Uno — multi-model provider settings" },
        { src: "/screenshots/uno-export-docs.png", alt: "Uno design docs export", caption: "Uno — exported design documentation" },
      ],
      tags: ["workflow", "engineering", "export"],
    },
  ],

  /* ── Strategic Risk ────────────────────────── */
  risks: {
    ifFigmaAdds: [
      { title: "DS-aware generation", detail: "Token injection into prompts would close the biggest gap" },
      { title: "Accessibility audit", detail: "Built-in WCAG audit with auto-fix — several third-party plugins already do this" },
      { title: "Responsive conversion", detail: "Breakpoint-aware layout restructuring is complex but high-value" },
      { title: "Multi-model choice", detail: "Unlikely given Figma's platform strategy, but possible via partnerships" },
      { title: "Structured editing", detail: "Their Make product may evolve to support resize, clone, reorder, component insertion" },
      { title: "Import/export", detail: "Frame-level import/export with DS context would reduce lock-in concerns" },
    ],
    moat: [
      { title: "Semantic DS extraction", detail: "Full cross-page extraction with 21 color roles, 17 typography roles — not easily replicated as a native feature" },
      { title: "Mode-aware style binding", detail: "Light/Dark/Unscoped priority maps require understanding of individual file's style architecture" },
      { title: "Deep structural editing", detail: "16-operation system with 500-line resize logic, ancestor propagation, and post-edit AI refinement" },
      { title: "Responsive pipeline", detail: "Programmatic nav migration, card-to-grid, hero transformation — domain-specific UX heuristics" },
      { title: "Multi-provider flexibility", detail: "9 models, 3 providers — teams use preferred/approved LLMs and switch as models improve" },
      { title: "Composable audit system", detail: "A11y + state coverage with canvas badges, Fix All, and exportable reports — compounds value in enterprise" },
    ],
  },
};

// Derive unique tags from all clusters
ALL_TAGS = Array.from(
  new Set(COMPARISON_DATA.clusters.flatMap((c) => c.tags))
).sort();
