# Uno Design Assistant — Capability Demo Prompts

Example prompts for every capability in the comparison matrix. Names match the matrix exactly so you can cross-reference.

---

## Generation

### Text-to-UI Generation
> Generate full UI frames from a natural-language text prompt.

```
Design a mobile login screen for a fitness app called "FitPulse".
Include a logo area, email and password fields, a "Sign In" button,
a "Forgot Password?" link, and a "Sign up" option at the bottom.
```

---

### Screenshot to Figma
> Convert a screenshot or mockup image into editable Figma layers.

*(attach a screenshot of any app you like):*
```
Create a mobile dashboard screen inspired by this reference image.
Use a similar card layout and navigation style but for a personal
finance tracking app called "CashFlow".
```

---

### HTML-to-Figma Generation
> The AI writes real HTML/CSS, renders it in a headless browser, then converts the result into native Figma nodes.

*(set mode to "HTML" in Settings first):*
```
Create a pricing comparison table with three tiers: Free, Pro, and
Enterprise. Each column should list features with checkmarks and a
"Choose Plan" button at the bottom.
```

---

### Multi-Step Generation
> Multi-pass pipeline (analyze → plan → generate → refine) for higher-quality output.

*(set mode to "Multi-Step" in Settings first):*
```
Design a landing page hero section for a SaaS product called
"CloudSync" — include a headline, subtext, a CTA button, and a
product mockup area on the right.
```

---

### Wireframe Generation
> Generate low-fidelity wireframes (grayscale, structural).

```
Create a wireframe for a task management dashboard with a sidebar
navigation, a top stats bar, and a kanban board in the center.
```

---

### High-Fidelity Generation
> Generate polished, production-quality UI with real colors, typography, and images.

```
Design a high-fidelity e-commerce product detail page with a large
hero image, color/size selectors, reviews section, and an "Add to
Cart" button.
```

---

## Editing & Modification

### Edit Text Content
> Change text on existing layers via natural language.

*(select a frame first):*
```
Change the headline to "Welcome Back" and the subtitle to
"Pick up where you left off"
```

---

### Edit Colors / Fills
> Change fill colors, backgrounds, and paint styles on existing nodes.

*(select a frame):*
```
Change the header background to dark navy (#1A1A2E) and make
all the header text white
```

---

### Edit Layout & Spacing
> Change auto-layout direction, padding, spacing, and sizing modes on existing frames.

*(select a frame):*
```
Change the product grid from vertical stacking to a horizontal
row layout with wrapping, increase padding to 32px on all sides,
and set the gap between items to 24px
```

---

### Resize Elements
> Resize any element with automatic sibling shifting and ancestor propagation.

*(select a frame):*
```
Make the hero section 200px taller
```

---

### Clone & Delete Nodes
> Deep-copy or remove nodes with automatic gap correction and parent resizing.

*(select a frame):*
```
Clone the first testimonial card and add two more copies below it
```

or:
```
Delete the second product card
```

---

### Shadows, Borders & Effects
> Add/edit drop shadows, strokes, corner radius, and opacity.

*(select a frame):*
```
Add a subtle drop shadow to all cards (light gray, 4px offset,
12px blur), a 2px light gray border on the inside of each card,
and round the button corners to 12px
```

---

### Stock Image Injection
> Search and insert Unsplash stock photos into image nodes via AI-generated queries.

*(select a frame with image placeholders):*
```
Replace the placeholder images with relevant stock photos —
a coffee shop for the first card, a mountain landscape for the
second, and a modern office for the third
```

---

## Variants & Responsive

### Dark Mode Variant
> Duplicate a frame and auto-transform it to dark mode (or vice versa).

*(select a frame):*
```
Duplicate this frame as a dark mode version
```

---

### Responsive Conversion
> Convert between mobile and desktop layouts with structural restructuring.

*(select a desktop frame):*
```
Duplicate this frame as a mobile layout — stack sections
vertically and reduce padding
```

---

### Translation Variant
> Duplicate a frame and translate all text to another language.

*(select a frame):*
```
Create a Spanish version of this screen
```

---

## Design System

### Design System Extraction
> Scan the document to extract colors, typography, components, variables, spacing, and theming info.

**How to use:** Click **☰ menu → Extract Design System**.

---

### DS-Bound Generation
> Inject your design tokens into every AI prompt so generated UI uses your actual styles.

*(extract design system first, then):*
```
Design a settings page that uses our existing design system
colors and typography — include a profile section, notification
toggles, and a "Log Out" button
```

---

### Auto Style Binding
> Automatically bind generated fills and text to local Figma paint/text styles.

This happens automatically when a design system is extracted. Generated nodes will reference your existing color and text styles instead of hardcoded hex values.

---

## Audits & Governance

### Accessibility Audit (WCAG)
> Scan frames for contrast violations, undersized touch targets, tiny fonts, empty text, and low opacity.

**How to use:** Select a frame → **☰ menu → Analyze → Accessibility Audit**

---

### Accessibility Auto-Fix
> Automatically fix WCAG violations (contrast, sizing, opacity) with one click.

**How to use:** After running the audit, click the **Fix** button on flagged issues.

---

### UI State Audit
> Check components for missing interaction states (Hover, Pressed, Focused, Disabled, Loading, Error).

**How to use:** Select a frame → **☰ menu → Analyze → UI State Audit**

---

### Layout Quality Audit
> Visual + structural analysis for spacing, alignment, overlap, cropping, typography, and proportion issues.

**How to use:** Select a frame → **☰ menu → Analyze → Layout Audit**

---

## AI Content Tools

### AI Copywriting
> Generate or rewrite copy/text content with AI assistance.

*(select a frame):*
```
Rewrite the hero headline and subtext to be more compelling
and action-oriented for a B2B audience
```

---

### AI Image Editing
> Edit images with AI (background removal, colorization, style transfer).

*(Not an Uno Design Assistant capability — listed for competitor comparisons only.)*

---

### SVG / Icon Conversion
> Convert raster icons to SVG or manage icon assets.

*(Not an Uno Design Assistant capability — listed for competitor comparisons only.)*

---

### Design / Template Library
> Browse a library of pre-made designs or templates to start from.

*(Not an Uno Design Assistant capability — listed for competitor comparisons only.)*

---

## Workflow & Engineering

### Multi-Provider AI
> Choose from multiple AI providers and models.
> - **Anthropic:** Claude Opus 4, Sonnet 4, Haiku 4
> - **OpenAI:** GPT-4o, GPT-4o Mini, o3-mini
> - **Google Gemini:** Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 Flash

**How to use:** **☰ menu → Settings** → pick provider, model, and enter API key.

---

### Import / Export JSON
> Export frames as structured JSON snapshots and re-import them.

**How to use:** Select a frame → **☰ menu → Import/Export → Export to JSON** (or Import from JSON).

---

### Export Design Docs
> Generate Markdown documentation of your design system (colors, typography, components, spacing).

**How to use:** **☰ menu → Import/Export → Export Design Docs**

---

### Prompt History & Replay
> Browse and one-click replay your last 30 prompts.

**How to use:** **☰ menu → Prompt History** → click any previous prompt to re-run it.

---

### Undo / Revert
> Revert the last AI operation batch to restore previous state.

**How to use:** Click the **Revert Last** button after any generation.

---

### Parallel Generation Jobs
> Submit multiple prompts concurrently with independent progress tracking and cancel.

**How to use:** Type a prompt and click Generate, then immediately type another prompt and click Generate again. Both run in parallel with separate progress tracking.

---

### Preview Plan Before Apply
> See the AI's proposed operations as a readable list before committing changes.

*(select a frame, then click "Preview Plan"):*
```
Swap the positions of the hero image and the text block
```

---

### Post-Generation Linting
> Automatically lint and fix generated output (spacing snapping, contrast, touch targets, truncation).

This runs silently after every generation — no prompt needed.

---

## Quick Reference — Prompts by Capability

| Capability | Example Prompt |
|---|---|
| Text-to-UI Generation | *"Design a mobile onboarding flow with 3 swipeable cards, illustrations, and a Get Started button"* |
| Screenshot to Figma | *"Create a dashboard inspired by this reference image" (attach image)* |
| HTML-to-Figma Generation | *"Create a pricing table with Free, Pro, Enterprise tiers" (HTML mode)* |
| Multi-Step Generation | *"Design a SaaS landing page hero section" (Multi-Step mode)* |
| Wireframe Generation | *"Create a wireframe for a task management dashboard"* |
| High-Fidelity Generation | *"Design a high-fidelity e-commerce product page"* |
| Edit Text Content | *"Change the headline to 'Welcome Back' and update the button to say 'Continue'"* |
| Edit Colors / Fills | *"Make the header background dark navy and all header text white"* |
| Edit Layout & Spacing | *"Change the cards from vertical stack to a 3-column grid, 24px gaps"* |
| Resize Elements | *"Make the hero section 200px taller"* |
| Clone & Delete Nodes | *"Duplicate the first team member card and add 3 more below"* |
| Shadows, Borders & Effects | *"Add a soft drop shadow and 12px corner radius to every card"* |
| Stock Image Injection | *"Add a stock photo of a mountain sunset to the hero image"* |
| Dark Mode Variant | *"Duplicate this screen as a dark mode version"* |
| Responsive Conversion | *"Create a mobile version of this desktop layout"* |
| Translation Variant | *"Duplicate this as a French translation"* |
| Design System Extraction | *(Menu → Extract Design System)* |
| DS-Bound Generation | *"Design a profile page using our existing design system tokens"* |
| Auto Style Binding | *(Automatic after DS extraction)* |
| Accessibility Audit (WCAG) | *(Menu → Analyze → Accessibility Audit)* |
| Accessibility Auto-Fix | *(Click Fix on flagged issues)* |
| UI State Audit | *(Menu → Analyze → UI State Audit)* |
| Layout Quality Audit | *(Menu → Analyze → Layout Audit)* |
| AI Copywriting | *"Rewrite the hero text to be more compelling for B2B"* |
| Multi-Provider AI | *(Menu → Settings → pick provider/model)* |
| Import / Export JSON | *(Menu → Import/Export → Export to JSON)* |
| Export Design Docs | *(Menu → Import/Export → Export Design Docs)* |
| Prompt History & Replay | *(Menu → Prompt History → click to replay)* |
| Undo / Revert | *(Click "Revert Last")* |
| Parallel Generation Jobs | *Submit multiple prompts back-to-back* |
| Preview Plan Before Apply | *Click "Preview Plan" instead of "Apply"* |
| Post-Generation Linting | *(Automatic after every generation)* |
