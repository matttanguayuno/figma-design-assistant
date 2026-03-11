/* ─────────────────────────────────────────────────────────────
 * Capability Matrix Data
 * Drives the comparison table for Uno Design Assistant vs competitors.
 * ───────────────────────────────────────────────────────────── */

// ── Types ────────────────────────────────────────────────────

export type SupportLevel = "full" | "partial" | "none";

export interface ToolScreenshot {
  /** Tool id this screenshot belongs to */
  toolId: string;
  src: string;
  alt: string;
  caption?: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  /** Per-tool support status, keyed by tool id */
  support: Record<string, SupportLevel>;
  /** Per-tool notes, keyed by tool id (optional) */
  notes?: Record<string, string>;
  /** Example test prompt used for this capability */
  testPrompt?: string;
  /** Screenshots grouped by tool */
  screenshots: ToolScreenshot[];
}

export interface Tool {
  id: string;
  name: string;
  url?: string;
  color: string; // tailwind bg class for column header
  textColor: string; // tailwind text class
}

// ── Tools ────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    id: "uno-design-assistant",
    name: "Uno Design Assistant",
    color: "bg-violet-600",
    textColor: "text-violet-100",
  },
  {
    id: "figma-ai",
    name: "Figma AI",
    url: "https://www.figma.com",
    color: "bg-zinc-700",
    textColor: "text-zinc-100",
  },
  {
    id: "codia",
    name: "Codia",
    url: "https://codia.ai",
    color: "bg-lime-700",
    textColor: "text-lime-100",
  },
  {
    id: "ux-pilot",
    name: "UX Pilot",
    url: "https://uxpilot.ai",
    color: "bg-purple-700",
    textColor: "text-purple-100",
  },
  {
    id: "wireframe-designer",
    name: "Wireframe Designer",
    color: "bg-zinc-600",
    textColor: "text-zinc-100",
  },
];

// ── Support-level styling ────────────────────────────────────

export const SUPPORT_META: Record<
  SupportLevel,
  { label: string; icon: string; cellClass: string; chipBg: string; chipBorder: string; chipColor: string }
> = {
  full: {
    label: "Yes",
    icon: "✅",
    cellClass: "bg-emerald-950/50 text-emerald-400",
    chipBg: "rgba(103, 229, 173, 0.12)",
    chipBorder: "rgba(103, 229, 173, 0.35)",
    chipColor: "#8AE9A3",
  },
  partial: {
    label: "Partial",
    icon: "⚠️",
    cellClass: "bg-yellow-950/40 text-yellow-400",
    chipBg: "rgba(245, 158, 11, 0.12)",
    chipBorder: "rgba(245, 158, 11, 0.35)",
    chipColor: "#F59E0B",
  },
  none: {
    label: "No",
    icon: "❌",
    cellClass: "bg-red-950/30 text-red-400/70",
    chipBg: "rgba(248, 89, 119, 0.12)",
    chipBorder: "rgba(248, 89, 119, 0.35)",
    chipColor: "#E15A7B",
  },
};

// ── Capabilities ─────────────────────────────────────────────

export const CAPABILITIES: Capability[] = [
  // ── Generation ─────────────────────────────
  {
    id: "text-to-ui",
    name: "Text-to-UI Generation",
    description:
      "Generate full UI frames from a natural-language text prompt.",
    testPrompt: "Design a mobile login screen for a fitness app called \"FitPulse\". Include a logo area, email and password fields, a \"Sign In\" button, a \"Forgot Password?\" link, and a \"Sign up\" option at the bottom.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "full",
      codia: "none",
      "ux-pilot": "full",
      "wireframe-designer": "full",
    },
    notes: {
      codia:
        "Codia only converts screenshots/images to Figma — no free-form text-to-UI generation.",
      "wireframe-designer":
        "Generates wireframe-fidelity only (grayscale, no color).",
    },
    screenshots: [
      { toolId: "uno-design-assistant", src: "/screenshots/Uno - Text-to-UI - 1.png", alt: "Uno Design Assistant text-to-UI generation", caption: "Uno Design Assistant — Text-to-UI prompt and generation" },
      { toolId: "uno-design-assistant", src: "/screenshots/Uno - Text-to-UI - 2.png", alt: "Uno Design Assistant text-to-UI result", caption: "Uno Design Assistant — Generated UI output" },
      { toolId: "figma-ai", src: "/screenshots/Figma - Text-to-UI - 1.png", alt: "Figma AI text-to-UI generation", caption: "Figma AI — Text-to-UI prompt" },
      { toolId: "figma-ai", src: "/screenshots/Figma - Text-to-UI - 2.png", alt: "Figma AI text-to-UI result", caption: "Figma AI — Generated UI output" },
      { toolId: "ux-pilot", src: "/screenshots/UX Pilot - Text-to-UI - 1.png", alt: "UX Pilot text-to-UI prompt", caption: "UX Pilot — Text-to-UI prompt" },
      { toolId: "ux-pilot", src: "/screenshots/UX Pilot - Text-to-UI - 2.png", alt: "UX Pilot text-to-UI result", caption: "UX Pilot — Generated UI output" },
      { toolId: "wireframe-designer", src: "/screenshots/Wireframe Designer - Text-to-UI - 1.png", alt: "Wireframe Designer text-to-UI prompt", caption: "Wireframe Designer — Text-to-UI prompt" },
      { toolId: "wireframe-designer", src: "/screenshots/Wireframe Designer - Text-to-UI - 2.png", alt: "Wireframe Designer text-to-UI result", caption: "Wireframe Designer — Generated wireframe output" },
    ],
  },
  {
    id: "screenshot-to-figma",
    name: "Screenshot to Figma",
    description:
      "Convert a screenshot or mockup image into editable Figma layers.",
    testPrompt: "Create a mobile dashboard screen inspired by this reference image. Use a similar card layout and navigation style but for a personal finance tracking app called \"CashFlow\".",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "full",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      "uno-design-assistant":
        "Attach a reference image to any generation prompt; the AI uses it as visual inspiration.",
      codia:
        "Core feature — upload screenshot, edit in-browser, export to Figma with layer hierarchy.",
    },
    screenshots: [],
  },
  {
    id: "html-to-figma",
    name: "HTML-to-Figma Generation",
    description:
      "Generate HTML/CSS first, render in a headless browser, then convert to Figma nodes.",
    testPrompt: "Create a pricing comparison table with three tiers: Free, Pro, and Enterprise. Each column should list features with checkmarks and a \"Choose Plan\" button at the bottom.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "multi-step-generation",
    name: "Multi-Step Generation",
    description:
      "Multi-pass pipeline (analyze → plan → generate → refine) for higher-quality output.",
    testPrompt: "Design a landing page hero section for a SaaS product called \"CloudSync\" — include a headline, subtext, a CTA button, and a product mockup area on the right.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "wireframe-mode",
    name: "Wireframe Generation",
    description:
      "Generate low-fidelity wireframes (grayscale, structural).",
    testPrompt: "Create a wireframe for a task management dashboard with a sidebar navigation, a top stats bar, and a kanban board in the center.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "partial",
      codia: "none",
      "ux-pilot": "full",
      "wireframe-designer": "full",
    },
    notes: {
      "ux-pilot": "Dedicated wireframe mode alongside hifi mode.",
      "wireframe-designer": "This is the only mode — all output is wireframe fidelity.",
    },
    screenshots: [],
  },
  {
    id: "hifi-generation",
    name: "High-Fidelity Generation",
    description:
      "Generate polished, production-quality UI with real colors, typography, and images.",
    testPrompt: "Design a high-fidelity e-commerce product detail page with a large hero image, color/size selectors, reviews section, and an \"Add to Cart\" button.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "full",
      codia: "partial",
      "ux-pilot": "full",
      "wireframe-designer": "none",
    },
    notes: {
      codia: "Hifi output only via screenshot conversion, not from text prompts.",
      "wireframe-designer": "Only generates wireframe-fidelity output.",
    },
    screenshots: [],
  },

  // ── Editing ────────────────────────────────
  {
    id: "text-editing",
    name: "Edit Text Content",
    description:
      "Change text on existing layers via natural language.",
    testPrompt: "Change the headline to \"Welcome Back\" and the subtitle to \"Pick up where you left off\"",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "full",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "color-editing",
    name: "Edit Colors / Fills",
    description:
      "Change fill colors, backgrounds, and paint styles on existing nodes.",
    testPrompt: "Change the header background to dark navy (#1A1A2E) and make all the header text white",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "partial",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "layout-editing",
    name: "Edit Layout & Spacing",
    description:
      "Change auto-layout direction, padding, spacing, and sizing modes on existing frames.",
    testPrompt: "Change the product grid from vertical stacking to a horizontal row layout with wrapping, increase padding to 32px on all sides, and set the gap between items to 24px",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "partial",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "resize",
    name: "Resize Elements",
    description:
      "Resize any element with automatic sibling shifting and ancestor propagation.",
    testPrompt: "Make the hero section 200px taller",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "clone-delete",
    name: "Clone & Delete Nodes",
    description:
      "Deep-copy or remove nodes with automatic gap correction and parent resizing.",
    testPrompt: "Clone the first testimonial card and add two more copies below it",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "shadows-borders",
    name: "Shadows, Borders & Effects",
    description:
      "Add/edit drop shadows, strokes, corner radius, and opacity.",
    testPrompt: "Add a subtle drop shadow to all cards (light gray, 4px offset, 12px blur), a 2px light gray border on the inside of each card, and round the button corners to 12px",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "stock-images",
    name: "Stock Image Injection",
    description:
      "Search and insert Unsplash stock photos into image nodes via AI-generated queries.",
    testPrompt: "Replace the placeholder images with relevant stock photos — a coffee shop for the first card, a mountain landscape for the second, and a modern office for the third",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "partial",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      "figma-ai": "Figma AI can generate images but not pull stock photos.",
    },
    screenshots: [],
  },

  // ── Variants & Responsive ─────────────────
  {
    id: "dark-mode-variant",
    name: "Dark Mode Variant",
    description:
      "Duplicate a frame and auto-transform it to dark mode (or vice versa).",
    testPrompt: "Duplicate this frame as a dark mode version",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "partial",
      "wireframe-designer": "partial",
    },
    notes: {
      "ux-pilot":
        "Can generate a dark-mode version if prompted, but it creates a new frame rather than duplicating/transforming.",
      "wireframe-designer":
        "Can darken theme if prompted, but wireframe-only.",
    },
    screenshots: [],
  },
  {
    id: "responsive-conversion",
    name: "Responsive Conversion",
    description:
      "Convert between mobile and desktop layouts with structural restructuring.",
    testPrompt: "Duplicate this frame as a mobile layout — stack sections vertically and reduce padding",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "partial",
      "wireframe-designer": "partial",
    },
    notes: {
      "ux-pilot":
        "Can pick mobile or desktop, but doesn't convert an existing frame between them.",
      "wireframe-designer": "Can pick mobile or desktop target, but no conversion of existing.",
    },
    screenshots: [],
  },
  {
    id: "translation-variant",
    name: "Translation Variant",
    description:
      "Duplicate a frame and translate all text to another language.",
    testPrompt: "Create a Spanish version of this screen",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "partial",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      codia: "Has a 'Translate Language' feature in the AI Toolbox (premium).",
    },
    screenshots: [],
  },

  // ── Design System ─────────────────────────
  {
    id: "ds-extraction",
    name: "Design System Extraction",
    description:
      "Scan the document to extract colors, typography, components, variables, spacing, and theming info.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "partial",
      "wireframe-designer": "none",
    },
    notes: {
      "ux-pilot": "Has a 'Design Systems' tab and 'Import components' button, but doesn't auto-extract from the document.",
    },
    screenshots: [],
  },
  {
    id: "ds-bound-generation",
    name: "DS-Bound Generation",
    description:
      "Inject your design tokens into every AI prompt so generated UI uses your actual styles.",
    testPrompt: "Design a settings page that uses our existing design system colors and typography — include a profile section, notification toggles, and a \"Log Out\" button",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "style-binding",
    name: "Auto Style Binding",
    description:
      "Automatically bind generated fills and text to local Figma paint/text styles.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },

  // ── Audits & Governance ───────────────────
  {
    id: "accessibility-audit",
    name: "Accessibility Audit (WCAG)",
    description:
      "Scan frames for contrast violations, undersized touch targets, tiny fonts, empty text, and low opacity.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "a11y-auto-fix",
    name: "Accessibility Auto-Fix",
    description:
      "Automatically fix WCAG violations (contrast, sizing, opacity) with one click.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "ui-state-audit",
    name: "UI State Audit",
    description:
      "Check components for missing interaction states (Hover, Pressed, Focused, Disabled, Loading, Error).",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "layout-audit",
    name: "Layout Quality Audit",
    description:
      "Visual + structural analysis for spacing, alignment, overlap, cropping, typography, and proportion issues.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },

  // ── Workflow & Engineering ────────────────
  {
    id: "multi-provider",
    name: "Multi-Provider AI",
    description:
      "Choose from multiple AI providers and models (Anthropic, OpenAI, Google).",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "import-export",
    name: "Import / Export JSON",
    description:
      "Export frames as structured JSON snapshots and re-import them.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "partial",
      "wireframe-designer": "none",
    },
    notes: {
      "ux-pilot": "Has 'Export to UX Pilot' and 'Retrieve in Figma' options.",
    },
    screenshots: [],
  },
  {
    id: "export-docs",
    name: "Export Design Docs",
    description:
      "Generate Markdown documentation of your design system (colors, typography, components, spacing).",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "prompt-history",
    name: "Prompt History & Replay",
    description:
      "Browse and one-click replay your last 30 prompts.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "undo-revert",
    name: "Undo / Revert",
    description:
      "Revert the last AI operation batch to restore previous state.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "parallel-jobs",
    name: "Parallel Generation Jobs",
    description:
      "Submit multiple prompts concurrently with independent progress tracking and cancel.",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "preview-plan",
    name: "Preview Plan Before Apply",
    description:
      "See the AI's proposed operations as a readable list before committing changes.",
    testPrompt: "Swap the positions of the hero image and the text block",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
  {
    id: "design-library",
    name: "Design / Template Library",
    description:
      "Browse a library of pre-made designs or templates to start from.",
    support: {
      "uno-design-assistant": "none",
      "figma-ai": "none",
      codia: "full",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      codia: "Has a Design Library tab with search, categories, and recommended templates.",
    },
    screenshots: [],
  },
  {
    id: "image-editing",
    name: "AI Image Editing",
    description:
      "Edit images with AI (background removal, colorization, style transfer).",
    support: {
      "uno-design-assistant": "none",
      "figma-ai": "full",
      codia: "partial",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      codia: "AI Toolbox has Image Edit and Remove BG (premium features).",
      "figma-ai": "Figma AI can generate and edit images natively.",
    },
    screenshots: [],
  },
  {
    id: "ai-copywriting",
    name: "AI Copywriting",
    description:
      "Generate or rewrite copy/text content with AI assistance.",
    testPrompt: "Rewrite the hero headline and subtext to be more compelling and action-oriented for a B2B audience",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "full",
      codia: "partial",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      codia: "Has an 'AI Copywriting' option in the AI Toolbox (premium).",
      "uno-design-assistant": "Via SET_TEXT operation with natural language intent.",
    },
    screenshots: [],
  },
  {
    id: "svg-conversion",
    name: "SVG / Icon Conversion",
    description:
      "Convert raster icons to SVG or manage icon assets.",
    support: {
      "uno-design-assistant": "none",
      "figma-ai": "none",
      codia: "partial",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    notes: {
      codia: "Shows 'Continue converting icons to SVG' in the AI Toolbox.",
    },
    screenshots: [],
  },
  {
    id: "post-gen-linting",
    name: "Post-Generation Linting",
    description:
      "Automatically lint and fix generated output (spacing snapping, contrast, touch targets, truncation).",
    support: {
      "uno-design-assistant": "full",
      "figma-ai": "none",
      codia: "none",
      "ux-pilot": "none",
      "wireframe-designer": "none",
    },
    screenshots: [],
  },
];

// ── Category grouping for the table ──────────────────────────

export interface CapabilityGroup {
  name: string;
  capabilities: Capability[];
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    name: "Generation",
    capabilities: CAPABILITIES.filter((c) =>
      ["text-to-ui", "screenshot-to-figma", "html-to-figma", "multi-step-generation", "wireframe-mode", "hifi-generation"].includes(c.id)
    ),
  },
  {
    name: "Editing & Modification",
    capabilities: CAPABILITIES.filter((c) =>
      ["text-editing", "color-editing", "layout-editing", "resize", "clone-delete", "shadows-borders", "stock-images"].includes(c.id)
    ),
  },
  {
    name: "Variants & Responsive",
    capabilities: CAPABILITIES.filter((c) =>
      ["dark-mode-variant", "responsive-conversion", "translation-variant"].includes(c.id)
    ),
  },
  {
    name: "Design System",
    capabilities: CAPABILITIES.filter((c) =>
      ["ds-extraction", "ds-bound-generation", "style-binding"].includes(c.id)
    ),
  },
  {
    name: "Audits & Governance",
    capabilities: CAPABILITIES.filter((c) =>
      ["accessibility-audit", "a11y-auto-fix", "ui-state-audit", "layout-audit"].includes(c.id)
    ),
  },
  {
    name: "AI Content Tools",
    capabilities: CAPABILITIES.filter((c) =>
      ["ai-copywriting", "image-editing", "svg-conversion", "design-library"].includes(c.id)
    ),
  },
  {
    name: "Workflow & Engineering",
    capabilities: CAPABILITIES.filter((c) =>
      ["multi-provider", "import-export", "export-docs", "prompt-history", "undo-revert", "parallel-jobs", "preview-plan", "post-gen-linting"].includes(c.id)
    ),
  },
];
