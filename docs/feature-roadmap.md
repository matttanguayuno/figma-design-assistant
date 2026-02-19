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
