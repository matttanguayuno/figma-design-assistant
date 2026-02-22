# Feature Roadmap — DesignOps AI Plugin

Prioritized list of operations to add for lead designer workflow.

## High Impact (common day-to-day tasks)

- [x] **1. DELETE_NODE** — "Remove the newsletter signup section."
  Delete elements via natural language. Includes sibling shift-up and parent shrink logic (inverse of CLONE_NODE).

- [ ] **2. SET_VISIBILITY** — "Hide the sale badge" / "Show the promo banner."
  Toggle `visible` property. Low effort, high utility for toggling states without destroying nodes.

- [ ] **3. SET_FILL_COLOR** — "Change the hero background to dark blue" / "Make the CTA button red."
  Direct color changes without needing a named style. Lead designers constantly tweak colors during exploration.

- [ ] **4. SET_OPACITY** — "Make the overlay 50% transparent."
  Quick adjustment for layered compositions.

- [ ] **5. SET_CORNER_RADIUS** — "Round the card corners to 16px" / "Make the avatar fully circular."
  Very common design refinement.

## High Impact (design exploration)

- [ ] **6. DUPLICATE_FRAME** — "Duplicate this frame and make it dark theme" / "Create a mobile variant of this screen."
  Clones an entire top-level frame as a new variant placed beside it on the canvas, then applies follow-up operations (SET_FILL_COLOR, SET_TEXT, RESIZE_NODE, etc.) to transform it. Enables rapid theme/variant exploration without manual copy-paste.

## Medium Impact (layout & structure)

- [ ] **7. REORDER_NODE** — "Move the testimonials section above the pricing section."
  Reorder siblings within a parent (swap or move to index). Different from MOVE_NODE which repositions spatially.

- [ ] **8. SWAP_NODE** — "Replace the placeholder image with this component."
  Swap one node for another while preserving size/position.

- [ ] **9. SET_AUTO_LAYOUT** — "Convert this frame to horizontal auto-layout with 16px gap."
  Restructure layout mode — very powerful for cleanup.

- [ ] **10. SET_PADDING** — "Add 24px padding to the card."
  Adjust frame padding directly.

## Lower Priority (nice-to-have)

- [ ] **11. ADD_EFFECT** — "Add a drop shadow to the card" / "Apply background blur."
  Shadow, blur, and other effects.

- [ ] **12. SET_STROKE** — "Add a 1px border to the input field."
  Stroke color/weight/style.

- [ ] **13. SET_CONSTRAINTS** — "Pin the header to the top."
  Useful for responsive design setup.

## Feature Ideas (under consideration)

- [ ] **Auto-fix for audit findings**
  Add a "Fix" button to accessibility audit findings that applies deterministic corrections (e.g., increase contrast, bump font size to 12px, resize touch targets to 44px). Transforms audits from passive reports into active remediation tools. Most a11y fixes are concrete property changes — no LLM needed. *High value, moderate effort.*

- [ ] **Design token extraction**
  Scan a selection or entire page and extract all unique colors, typography styles, spacing values, border radii, etc. into a structured token file (JSON, CSS custom properties, or Tailwind config). Addresses a major pain point in design-to-dev handoff. *High value, moderate effort.*

- [ ] **Design-to-code generation**
  Select a frame and generate React / HTML+CSS / SwiftUI / Flutter code via the LLM. Leverages the existing tree walker from the audit infrastructure. High perceived value but complex to do well at production quality. *Highest perceived value, high effort.*

- [ ] **Consistency checker**
  Flag inconsistencies across a file: near-duplicate colors ("14 slightly different grays"), inconsistent spacing ("7px, 8px, 9px — should these be unified?"), mixed border radii, etc. Think of it as a design-system-readiness audit. *Medium value, moderate effort.*

- [ ] **Component documentation generator**
  Auto-generate documentation for component sets: variant names, props, usage guidelines, visual examples list. Leverages existing tree-walking code. *Medium value, low effort.*
