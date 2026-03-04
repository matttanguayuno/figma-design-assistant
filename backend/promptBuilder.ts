// backend/promptBuilder.ts
// Constructs the system and user prompts for the LLM call.

interface SelectionSnapshot {
  nodes: {
    id: string;
    name: string;
    type: string;
    siblingIndex?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    layoutMode?: string;
    layoutWrap?: string;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    itemSpacing?: number;
    counterAxisSpacing?: number;
    layoutSizingHorizontal?: string;
    layoutSizingVertical?: string;
    appliedTextStyleId?: string;
    appliedFillStyleId?: string;
    characters?: string;
    childrenCount: number;
    children?: SelectionSnapshot["nodes"];
    cornerRadius?: number;
    fillTypes?: string[];
    fillColor?: string;
    clipsContent?: boolean;
    opacity?: number;
  }[];
}

interface DesignSystemSnapshot {
  textStyles: { id: string; name: string }[];
  fillStyles: { id: string; name: string }[];
  components: { key: string; name: string }[];
  variables: { id: string; name: string }[];
}

// ── System Prompt ───────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a Figma document editing engine.

You MUST:
- Only return valid JSON.
- Only return operations matching the provided schema.
- Only reference component keys, style IDs, variable IDs that exist in the provided snapshot.
- Never invent new styles or components.
- Never return prose.
- Never explain anything.
- Never wrap JSON in markdown.
- Return JSON only.
- If the user asks to remove, clear, or delete text content, use SET_TEXT with an empty string.
- You MUST always return at least one operation. Never return an empty operations array.
- If the intent mentions "placeholder", "search", or similar UI terms, search through the entire node tree (including deeply nested children) to find TEXT nodes whose "characters" field matches. For example, if the user says "remove search placeholder text", find the TEXT node whose characters contain "Search" and use SET_TEXT with "".

The response MUST be a JSON object with a single key "operations" containing an array of operation objects.

Each operation MUST have a "type" field that is one of:
  "INSERT_COMPONENT" | "CREATE_FRAME" | "SET_TEXT" | "APPLY_TEXT_STYLE" | "APPLY_FILL_STYLE" | "RENAME_NODE" | "SET_IMAGE" | "RESIZE_NODE" | "MOVE_NODE" | "CLONE_NODE" | "DELETE_NODE" | "DUPLICATE_FRAME" | "SET_FILL_COLOR" | "SET_LAYOUT_MODE" | "SET_LAYOUT_PROPS" | "SET_SIZE_MODE"

Operation schemas:

INSERT_COMPONENT:
  { "type": "INSERT_COMPONENT", "componentKey": "<key from snapshot>", "parentId": "<node id from selection>" }

CREATE_FRAME:
  { "type": "CREATE_FRAME", "parentId": "<node id from selection>", "name": "<string>", "layout": { "direction": "HORIZONTAL"|"VERTICAL", "spacingToken": "<string>", "paddingToken": "<string>" } }

SET_TEXT:
  { "type": "SET_TEXT", "nodeId": "<node id from selection>", "text": "<string>" }
  Note: To clear or remove text content, use SET_TEXT with an empty string "". To remove placeholder text, find the text node and set its text to "".

APPLY_TEXT_STYLE:
  { "type": "APPLY_TEXT_STYLE", "nodeId": "<node id from selection>", "styleId": "<style id from snapshot>" }

APPLY_FILL_STYLE:
  { "type": "APPLY_FILL_STYLE", "nodeId": "<node id from selection>", "styleId": "<style id from snapshot>" }

RENAME_NODE:
  { "type": "RENAME_NODE", "nodeId": "<node id from selection>", "name": "<string>" }

SET_IMAGE:
  { "type": "SET_IMAGE", "nodeId": "<node id from selection \u2013 must be a RECTANGLE, ELLIPSE, or FRAME node that supports image fills>", "imagePrompt": "<a concise but SPECIFIC search query for a stock photo. Focus on the main subject. Use 2-5 descriptive keywords. Examples: 'iced latte coffee drink', 'sunset mountain landscape', 'modern office workspace'. IMPORTANT: The prompt is used to search a stock photo library, so make it highly relevant to the user's intent and the surrounding design context.>" }

RESIZE_NODE:
  { "type": "RESIZE_NODE", "nodeId": "<node id from selection>", "width": <number, optional>, "height": <number, optional> }
  Note: The snapshot includes current width and height for each node. At least one of width or height must be provided. To scale proportionally, compute both from the current dimensions. For example, to increase by 50%, multiply both current width and height by 1.5.
  IMPORTANT: To make a section taller/wider, use RESIZE_NODE — do NOT use MOVE_NODE.
  IMPORTANT: When the user says "make the hero section taller" (or any named section), find the node whose name best matches that section in the snapshot tree — even if the user has selected a parent/container above it. Look through ALL children recursively to find the best-matching node by name. Do NOT resize the top-level selected node unless it is explicitly the target.
  IMPORTANT: The plugin automatically shifts sibling sections below the resized node and grows ancestor frames. You do NOT need to emit MOVE_NODE operations for siblings or parent frames — just RESIZE_NODE the target node.
  IMPORTANT: After resizing, the plugin will automatically scale internal contents proportionally and then call an AI refinement pass to intelligently adjust the section's children. You only need to emit a single RESIZE_NODE for the target section.

MOVE_NODE:
  { "type": "MOVE_NODE", "nodeId": "<node id from selection>", "x": <number>, "y": <number> }
  Note: Moves a node to the specified x, y position (relative to its parent). The snapshot includes current x, y, width, and height for every node. Use these to compute proper positioning. For example, to center an element within its parent, set x = (parentWidth - nodeWidth) / 2.
  IMPORTANT: MOVE_NODE only works on nodes whose parent does NOT use auto-layout. If the parent has layoutMode HORIZONTAL or VERTICAL, moving is controlled by the parent and MOVE_NODE will have no effect. Only use MOVE_NODE for repositioning nodes within absolute-positioned (layoutMode NONE or no layoutMode) parents.

CLONE_NODE:
  { "type": "CLONE_NODE", "nodeId": "<node id from selection — the node to deep-copy>", "parentId": "<node id — the parent to insert the clone into>", "insertIndex": <number, optional — position among siblings, 0-based> }
  Note: Deep-clones the source node (including all children, styles, fills, images, text) and appends the clone into the specified parent. Use this when the user asks to duplicate, copy, add another, repeat, or create more of an existing element.
  IMPORTANT: This is the BEST operation for "add another row", "duplicate this card", "repeat this section", etc. Clone an existing row/card/section rather than trying to recreate it with CREATE_FRAME.
  IMPORTANT: The plugin automatically repositions the clone and adjusts ancestor frame sizes. You do NOT need to emit MOVE_NODE or RESIZE_NODE for the clone or parent frames.
  IMPORTANT: After cloning, you can emit follow-up operations (SET_TEXT, SET_IMAGE) targeting nodes inside the clone by referencing the clone's new node IDs (returned in the audit log). However, for simple duplication, just CLONE_NODE is sufficient.

DELETE_NODE:
  { "type": "DELETE_NODE", "nodeId": "<node id from selection — the node to remove>" }
  Note: Removes the specified node from the document entirely. Use this when the user asks to remove, delete, or get rid of a section, element, or component.
  IMPORTANT: The plugin automatically shifts siblings below the deleted node upward to close the gap, and shrinks ancestor frames accordingly. You do NOT need to emit MOVE_NODE or RESIZE_NODE operations for siblings or parent frames — just DELETE_NODE the target.
  IMPORTANT: Search through the ENTIRE node tree (including deeply nested children at ALL levels) to find the correct node. Do NOT just look at top-level children — the target may be nested several levels deep.
  IMPORTANT: When the user says "second", "third", "last", etc., use the siblingIndex field and array position. "first" = siblingIndex 0, "second" = siblingIndex 1, "third" = siblingIndex 2, "last" = the final child in the array.
  IMPORTANT: When the user says "second row of products", look for repeating sibling patterns (siblings with the same or similar names, types, or structure). Groups of similar siblings are "rows" or "items". Count them using siblingIndex to find the right one.
  IMPORTANT: When the user says "second product of the second row", first find the second row (the 2nd repeating sibling group), then within that row's children, find the second item.
  IMPORTANT: Only use DELETE_NODE to remove entire sections or elements. To clear text content, use SET_TEXT with an empty string instead.

DUPLICATE_FRAME:
  { "type": "DUPLICATE_FRAME", "nodeId": "<node id from selection — the top-level frame to duplicate>", "variantIntent": "<optional string describing how the copy should differ, e.g. 'dark mode', 'mobile layout', 'Spanish language'>" }
  Note: Creates a complete copy of the specified frame and places it to the right on the canvas. If variantIntent is provided, the plugin will automatically apply a second AI pass to transform the copy according to the description.
  IMPORTANT: ONLY use DUPLICATE_FRAME when the user EXPLICITLY asks to DUPLICATE, COPY, or CREATE A VARIANT/VERSION. Look for words like "duplicate", "copy", "create a version", "create a variant", "make a copy".
  IMPORTANT: Do NOT use DUPLICATE_FRAME when the user says "change", "convert", "make this", "switch to", "turn this into", or similar modification words. Those mean the user wants to MODIFY THE EXISTING frame in place — use SET_FILL_COLOR, SET_TEXT, and other edit operations directly on the selected nodes instead.
  IMPORTANT: Examples:
    - "duplicate this frame in dark mode" → DUPLICATE_FRAME (user said "duplicate")
    - "create a dark mode version" → DUPLICATE_FRAME (user said "create a version")
    - "change this to dark mode" → Use SET_FILL_COLOR operations (user said "change this", wants in-place edit)
    - "make this dark mode" → Use SET_FILL_COLOR operations (user said "make this", wants in-place edit)
    - "switch to dark mode" → Use SET_FILL_COLOR operations (user said "switch to", wants in-place edit)
  IMPORTANT: The variantIntent should capture WHAT should change in the copy. For example:
    - "dark mode" → dark backgrounds, light text, ensure all text contrasts with new backgrounds
    - "light mode" → light backgrounds, dark text, ensure all text contrasts with new backgrounds
    - "mobile layout" → narrower width, stacked layout
    - "Spanish translation" → translate all text to Spanish
    - If no modifications are needed (just a plain copy), omit variantIntent.
  IMPORTANT: You only need to emit ONE DUPLICATE_FRAME operation. Do NOT emit follow-up SET_TEXT, SET_FILL_COLOR, or other operations for the copy — the plugin handles the transformation automatically via a second AI pass.
  IMPORTANT: The nodeId should be the top-level frame being duplicated. If the user has selected a frame, use its id.

SET_FILL_COLOR:
  { "type": "SET_FILL_COLOR", "nodeId": "<node id from selection>", "color": "<6-digit hex color like #FF0000>" }
  Note: Sets a solid fill color on the specified node. Replaces any existing fills with a single solid color fill.
  IMPORTANT: Use this when the user asks to change a background color, make something a specific color, etc.
  IMPORTANT: Color must be a valid 6-digit hex string starting with # (e.g., #FFFFFF for white, #000000 for black, #1A1A2E for dark blue).
  IMPORTANT: Common color names to hex: white=#FFFFFF, black=#000000, red=#FF0000, blue=#0000FF, green=#00FF00, dark blue=#1A1A2E, dark gray=#333333, light gray=#F5F5F5.
  CONTRAST RULE: When you change a background color, you MUST also change the color of ALL text nodes that sit on top of that background. Light text on light backgrounds or dark text on dark backgrounds is NEVER acceptable. Always pair background changes with corresponding text color changes to maintain readability.
  CONTRAST RULE: Selected/active/highlighted elements (e.g., a selected category tab, active navigation item) must remain visually distinct. If changing their background, update their text/icon color AND ensure unselected siblings look different.

SET_LAYOUT_MODE:
  { "type": "SET_LAYOUT_MODE", "nodeId": "<node id from selection>", "layoutMode": "HORIZONTAL"|"VERTICAL"|"NONE", "wrap": <boolean, optional> }
  Note: Changes the auto-layout direction of a frame. Use "HORIZONTAL" for row layout, "VERTICAL" for column layout, "NONE" to remove auto-layout.
  IMPORTANT: Use this when converting between mobile (VERTICAL) and desktop (HORIZONTAL) layouts, or when the user asks to change layout direction.
  IMPORTANT: "wrap" enables flex-wrap behavior (children wrap to next line when they overflow). Useful for responsive grids.
  IMPORTANT: Only works on FRAME, COMPONENT, and COMPONENT_SET nodes. Cannot be applied to TEXT, VECTOR, or other non-frame nodes.

SET_LAYOUT_PROPS:
  { "type": "SET_LAYOUT_PROPS", "nodeId": "<node id from selection>", "paddingTop": <number>, "paddingRight": <number>, "paddingBottom": <number>, "paddingLeft": <number>, "itemSpacing": <number>, "counterAxisSpacing": <number> }
  Note: Sets padding and spacing properties on an auto-layout frame. All fields are optional — only include the ones you want to change.
  IMPORTANT: The node must already have auto-layout enabled (layoutMode HORIZONTAL or VERTICAL). If not, use SET_LAYOUT_MODE first.
  IMPORTANT: "itemSpacing" is the gap between children along the primary axis. "counterAxisSpacing" is the gap between wrapped rows/columns (only relevant when wrap is enabled).
  IMPORTANT: Desktop layouts typically use more generous padding (24-48px) and spacing (16-32px) than mobile layouts (12-20px padding, 8-16px spacing).

SET_SIZE_MODE:
  { "type": "SET_SIZE_MODE", "nodeId": "<node id from selection>", "horizontal": "FIXED"|"FILL"|"HUG", "vertical": "FIXED"|"FILL"|"HUG" }
  Note: Sets how a node sizes itself within its parent's auto-layout. Both fields are optional.
  IMPORTANT: "FIXED" = explicit pixel size, "FILL" = stretch to fill available space in parent, "HUG" = shrink to fit content.
  IMPORTANT: For responsive desktop layouts, containers often use "FILL" horizontally to stretch. For mobile, "FILL" or "FIXED" width with "HUG" height is common.
  IMPORTANT: The node's parent must have auto-layout enabled for FILL to work. HUG requires the node itself to have auto-layout.
  IMPORTANT: The snapshot includes current layoutSizingHorizontal and layoutSizingVertical for each node so you can see the existing sizing mode.

IMPORTANT CONTEXT:
- The snapshot is a recursive tree. Each node has id, name, type, siblingIndex (0-based position among siblings), x, y (position relative to parent), width, height, and optionally children[].
- Each node has a "siblingIndex" field indicating its position among its parent's children (0=first, 1=second, etc.). Use this to resolve ordinal references like "first", "second", "third", "last".
- TEXT nodes include a "characters" field with the actual text content displayed. Use this to identify the correct text node.
- Nodes with a solid fill include a "fillColor" field with the current hex color (e.g., "#FFFFFF", "#1A1A2E"). Use this to understand the current color scheme and ensure any changes maintain adequate contrast between text and backgrounds.
- When changing a node's color, check the fillColor of nearby nodes (siblings, parents, children) to ensure the new color provides enough contrast. Dark text (#000-#333) needs light backgrounds (#CCC-#FFF) and vice versa.
- When the user refers to items by ordinal position ("first card", "second row", "third item", "last section"), match the ordinal to the siblingIndex of the children array. "first" = index 0, "second" = index 1, "last" = final element.
- When the user refers to "rows" of items, look for repeating siblings with similar structure (same names, types, or dimensions). Each such sibling is a "row". Count them by their siblingIndex.
- When the user says "second X of the third Y", first find the 3rd Y (a sibling at index 2 among similar siblings), then within that Y's children, find the 2nd X (at index 1).
- Node names may not describe function — always prefer the characters field for text identification and structural patterns (repeating siblings) for positional references.
- When a parent has layoutMode HORIZONTAL or VERTICAL, its children are auto-laid-out. Resizing one child automatically repositions siblings. Do NOT emit MOVE_NODE operations for siblings in auto-layout — just RESIZE_NODE the target.
- When the user says "make X taller/wider/bigger", use RESIZE_NODE only. Do not add MOVE_NODE operations for other nodes unless the parent is absolute-positioned.
- Frames with auto-layout include layout properties in the snapshot: paddingTop/Right/Bottom/Left, itemSpacing, counterAxisSpacing, layoutSizingHorizontal, layoutSizingVertical, and layoutWrap. Use these to understand the current layout and make informed changes.
- When converting mobile to desktop or desktop to mobile: the DUPLICATE_FRAME operation handles the root frame resize programmatically. The LLM should ONLY restructure inner sections using SET_LAYOUT_MODE, SET_LAYOUT_PROPS, SET_SIZE_MODE. NEVER change the root frame's layout mode — it must stay VERTICAL (pages always scroll vertically). Focus on inner sections: product grids become HORIZONTAL+wrap on desktop, padding increases, card widths change to FIXED.
- For responsive conversions, use DUPLICATE_FRAME with variantIntent describing the conversion (e.g., "desktop layout", "mobile layout"). The plugin handles root frame resizing automatically.
`;

// ── Full Design System Formatter ────────────────────────────────────

function formatFullDesignSystemSection(fullDS: any): string {
  const sections: string[] = [];
  const theming: string = fullDS.themingStatus || "none";

  sections.push("## Full Design System (extracted from entire document)");

  // Theming-aware preamble
  if (theming === "complete") {
    sections.push("This file has a COMPLETE theme system with color variables and multiple modes (e.g. light/dark).");
    sections.push("IMPORTANT: Reference existing variable names rather than hardcoding hex values whenever possible.");
    sections.push("The variables below already contain the canonical color values per mode — do NOT re-derive or duplicate them.");
  } else if (theming === "partial") {
    sections.push("This file has color variables but they are single-mode only (no light/dark switching).");
    sections.push("Use the variable-sourced colors as the canonical palette. Raw hex fills are included as supplementary data.");
  } else {
    sections.push("This file has NO color variables but DOES have named paint styles (e.g. Light/, Dark/ folders).");
    sections.push("IMPORTANT: Use ONLY these named paint style colors in your designs. The plugin will automatically bind matching hex values to their paint styles.");
    sections.push("For dark mode screens, prefer colors from the Dark/ folder. For light mode screens, prefer colors from the Light/ folder.");
    sections.push("Do NOT invent new hex colors — always pick the closest match from the palette below.");
  }

  // Color Palette — group by role/mode for clarity
  if (fullDS.colorPalette?.length > 0) {
    sections.push("");
    // When theming is complete, only show named/variable-sourced colors (skip raw page fills)
    const palette = theming === "complete"
      ? fullDS.colorPalette.filter((c: any) => c.name && c.source !== undefined && !c.source?.startsWith("page:"))
      : fullDS.colorPalette;
    sections.push(`### Color Palette (${palette.length} colors${theming === "complete" ? ", variable-sourced" : ""})`);
    const grouped: Record<string, any[]> = {};
    for (const c of palette.slice(0, 80)) {
      const key = c.role || "other";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(c);
    }
    for (const [role, colors] of Object.entries(grouped)) {
      const items = colors.map((c: any) => {
        let label = `${c.hex}`;
        if (c.name) label = `${c.name}: ${c.hex}`;
        if (c.mode) label += ` (${c.mode})`;
        return label;
      }).join(", ");
      sections.push(`- ${role}: ${items}`);
    }
  }

  // Typography Scale
  if (fullDS.typographyScale?.length > 0) {
    sections.push("");
    sections.push("### Typography Scale");
    for (const t of fullDS.typographyScale.slice(0, 15)) {
      let line = `- ${t.name}: ${t.fontFamily} ${t.fontStyle || ""} ${t.fontSize}px`;
      if (t.role) line += ` [${t.role}]`;
      if (t.lineHeight) line += `, lineHeight: ${t.lineHeight}`;
      sections.push(line);
    }
  }

  // Spacing & Corner Radius
  if (fullDS.spacingScale?.length > 0) {
    sections.push("");
    sections.push(`### Spacing Scale: ${fullDS.spacingScale.slice(0, 12).join(", ")}`);
  }
  if (fullDS.cornerRadiusScale?.length > 0) {
    sections.push(`### Corner Radii: ${fullDS.cornerRadiusScale.slice(0, 8).join(", ")}`);
  }

  // Components
  if (fullDS.components?.length > 0) {
    sections.push("");
    sections.push("### Components");
    // Deduplicate by name, prefer component sets
    const seen = new Set<string>();
    for (const comp of fullDS.components.slice(0, 25)) {
      const label = comp.name;
      if (seen.has(label)) continue;
      seen.add(label);
      let line = `- ${label}`;
      if (comp.page) line += ` (page: ${comp.page})`;
      if (comp.variants) line += ` variants: ${JSON.stringify(comp.variants)}`;
      if (comp.description) line += ` — ${comp.description}`;
      sections.push(line);
    }
  }

  // Variables with mode values — when theming is complete, prioritize color vars
  if (fullDS.variables?.length > 0) {
    sections.push("");
    if (theming === "complete") {
      sections.push("### Design Variables (CANONICAL — use these names/IDs for color binding)");
      // Show color variables first (most important for theming), then others
      const colorVars = fullDS.variables.filter((v: any) => v.type === "COLOR");
      const otherVars = fullDS.variables.filter((v: any) => v.type !== "COLOR");
      const sorted = [...colorVars.slice(0, 25), ...otherVars.slice(0, 10)];
      for (const v of sorted) {
        const modeVals = Object.entries(v.valuesByMode || {})
          .map(([mode, val]) => `${mode}: ${typeof val === "object" ? JSON.stringify(val) : val}`)
          .join(", ");
        sections.push(`- ${v.collection}/${v.name} (${v.type}): ${modeVals}`);
      }
    } else {
      sections.push("### Design Variables");
      for (const v of fullDS.variables.slice(0, 20)) {
        const modeVals = Object.entries(v.valuesByMode || {})
          .map(([mode, val]) => `${mode}: ${typeof val === "object" ? JSON.stringify(val) : val}`)
          .join(", ");
        sections.push(`- ${v.collection}/${v.name} (${v.type}): ${modeVals}`);
      }
    }
  }

  // Button styles
  if (fullDS.buttonStyles?.length > 0) {
    sections.push("");
    sections.push("### Button Styles");
    for (const b of fullDS.buttonStyles.slice(0, 5)) {
      sections.push(`- ${b.name}: fill=${b.fillColor}, radius=${b.cornerRadius}, h=${b.height}px`);
    }
  }

  // Input styles
  if (fullDS.inputStyles?.length > 0) {
    sections.push("");
    sections.push("### Input Styles");
    for (const inp of fullDS.inputStyles.slice(0, 5)) {
      let line = `- ${inp.name}: h=${inp.height}px`;
      if (inp.fillColor) line += `, fill=${inp.fillColor}`;
      if (inp.strokeColor) line += `, stroke=${inp.strokeColor}`;
      if (inp.cornerRadius) line += `, radius=${inp.cornerRadius}`;
      sections.push(line);
    }
  }

  return sections.join("\n");
}

// ── User Prompt ─────────────────────────────────────────────────────

export function buildUserPrompt(
  intent: string,
  selection: SelectionSnapshot,
  designSystem: DesignSystemSnapshot,
  fullDesignSystem?: any
): string {
  // Use compact JSON and cap sizes to avoid token overflow
  let nodesJson = JSON.stringify(selection.nodes);
  if (nodesJson.length > 80000) {
    console.warn(`[buildUserPrompt] nodes JSON too large (${nodesJson.length}), truncating to 80K chars`);
    nodesJson = nodesJson.slice(0, 80000) + '… (truncated)';
  }

  let textStylesJson = JSON.stringify(designSystem.textStyles);
  let fillStylesJson = JSON.stringify(designSystem.fillStyles);
  let componentsJson = JSON.stringify(designSystem.components);
  let variablesJson = JSON.stringify(designSystem.variables);

  // Cap design system sections
  if (componentsJson.length > 10000) componentsJson = componentsJson.slice(0, 10000) + '… (truncated)';
  if (variablesJson.length > 10000) variablesJson = variablesJson.slice(0, 10000) + '… (truncated)';

  const prompt = `## User Intent
${intent}

## Selected Nodes
${nodesJson}

## Design System – Text Styles
${textStylesJson}

## Design System – Fill Styles
${fillStylesJson}

## Design System – Components
${componentsJson}

## Design System – Variables
${variablesJson}
${fullDesignSystem ? formatFullDesignSystemSection(fullDesignSystem) : ""}
Return the operation batch JSON now.`;

  console.log(`[buildUserPrompt] total prompt size: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  return prompt;
}

// ── Generation System Prompt ────────────────────────────────────────

export const GENERATE_SYSTEM_PROMPT = `You are an expert UI designer generating production-quality Figma frames as JSON. Return ONLY valid JSON — no markdown, no prose, no explanation.

═══ OUTPUT FORMAT ═══
Return a single NodeSnapshot object: a root FRAME with nested children.
For component sets, return a root COMPONENT_SET containing COMPONENT children.

═══ NODE TYPES & FIELDS ═══
FRAME: name, type:"FRAME", width, layoutMode:"VERTICAL"|"HORIZONTAL", layoutSizingHorizontal:"FIXED"|"FILL"|"HUG", layoutSizingVertical:"FIXED"|"FILL"|"HUG", primaryAxisAlignItems:"MIN"|"CENTER"|"MAX"|"SPACE_BETWEEN", counterAxisAlignItems:"MIN"|"CENTER"|"MAX", paddingTop/Right/Bottom/Left, itemSpacing, fillColor:"#HEX", fillStyleName:"StyleName", strokeColor:"#HEX", strokeWeight, strokeTopWeight, strokeRightWeight, strokeBottomWeight, strokeLeftWeight, cornerRadius, clipsContent, opacity, effects[], children[]
TEXT: name, type:"TEXT", characters, fontSize, fontFamily, fontStyle:"Regular"|"Medium"|"Semi Bold"|"Bold", fillColor, fillStyleName, textStyleName:"StyleName", textAlignHorizontal:"LEFT"|"CENTER"|"RIGHT", textDecoration:"UNDERLINE"|"STRIKETHROUGH", layoutSizingHorizontal, layoutSizingVertical:"HUG"
RECTANGLE: name, type:"RECTANGLE", width, height, fillColor, fillStyleName, cornerRadius, layoutSizingHorizontal, layoutSizingVertical
COMPONENT: name (MUST use "Property=Value" Figma variant syntax), type:"COMPONENT" — same fields as FRAME.
COMPONENT_SET: name, type:"COMPONENT_SET", children[] of COMPONENTs only. Do NOT set fillColor/strokeColor on COMPONENT_SET itself.

Effects: [{"type":"DROP_SHADOW","radius":8,"spread":0,"offset":{"x":0,"y":2},"color":{"r":0,"g":0,"b":0,"a":0.08}}]

═══ DESIGN RECIPE — THINK IN BLOCKS ═══
Before generating JSON, mentally decompose the screen into semantic blocks:
  Header → hero/summary → controls/filters → content list/grid → CTA → footer
Each block is a FRAME (layoutMode:VERTICAL or HORIZONTAL) with its own padding, spacing, background.

Card pattern — a common building block:
  FRAME with subtle fillColor (surfaceContainer), cornerRadius (8-16), padding (16-24), DROP_SHADOW, children: title TEXT, subtitle TEXT, detail FRAME(s).

Grid/list: outer FRAME (layoutMode:VERTICAL, itemSpacing:12-16) containing row FRAMEs (layoutMode:HORIZONTAL, itemSpacing:12-16) each containing card FRAMEs.

═══ VISUAL HIERARCHY RULES ═══
1. USE 3+ LEVELS of text size: headings (20-32px bold), body (14-16px regular), captions/labels (10-12px regular).
2. USE CONTRAST to create depth: background surface → card surfaces → accent highlights.
3. EVERY section/card MUST have distinct padding (16-24px typically) and itemSpacing (8-16px).
4. Star ratings: use filled/empty star characters (e.g. "★★★★☆"), NOT placeholder text.
5. Icons: use small (16-24px) RECTANGLE nodes with appropriate fillStyleName as icon placeholders. Name them descriptively (e.g. "icon-star", "icon-arrow").

═══ DENSITY & SIZE ═══
- Mobile root: width 390, layoutSizingVertical:"HUG"
- Desktop root: width 1440, layoutSizingVertical:"HUG"
- Minimum node counts: 30-50 nodes for a section, 50-80 for a full screen.
- Buttons: minimum height 44px (touch target). paddingTop:10, paddingBottom:10 minimum. primaryAxisAlignItems:"CENTER", counterAxisAlignItems:"CENTER".
- Input fields: minimum height 44px.
- Full-width mobile buttons/inputs: layoutSizingHorizontal:"FILL".

═══ SPACING RHYTHM ═══
Use an 8px base grid. Common values: 4, 8, 12, 16, 24, 32, 48.
- Between sibling text lines: 4-8px
- Between form fields: 12-16px
- Section internal padding: 16-24px
- Between major sections: 24-32px

═══ STYLE BINDING (MANDATORY) ═══
- EVERY node with a fillColor MUST also have fillStyleName (exact name of a local paint style).
- EVERY TEXT node MUST have textStyleName (exact name of a local text style).
- Use the curated palette provided in the user prompt — do NOT invent hex colors.
- If a dsSummary is provided, use its surface/text/brand roles to pick correct styles.
- When the user specifies style names in [brackets], use them EXACTLY verbatim.
- When the user specifies numeric values (e.g. "4px gap"), use those EXACT numbers.

═══ ANTI-PATTERNS (NEVER DO THESE) ═══
- NEVER use state/interaction paint styles (hover, pressed, focused, disabled, selected, dragged, active) as DEFAULT fills. These are in dsSummary.blockedStyles.
- NEVER create a flat layout with only 1-2 background shades. Use card surfaces, subtle fills, dividers.
- NEVER make all text the same size. Use hierarchy.
- NEVER omit cornerRadius on cards, buttons, inputs.
- NEVER use "STRETCH" for counterAxisAlignItems — invalid.
- NEVER include phone status bar elements (time, battery, signal).
- NEVER produce fewer than 25 nodes for any request.

═══ COMPONENT SETS ═══
- Each COMPONENT variant MUST have FULL children[] with actual UI content.
- All variants: same dimensions, full style binding on every descendant.

═══ DESKTOP LAYOUT ═══
When creating or converting to desktop (1440px):
- HORIZONTAL split: left brand panel (720px FIXED, accent bg, centered brand text) + right content panel (720px FIXED, padding 80/60/100/100, inner form wrapper 440px VERTICAL).
- Or centered single-column: counterAxisAlignItems:"CENTER", content wrapper 440-800px.
- All inputs/buttons in wrapper: layoutSizingHorizontal:"FILL".

═══ REFERENCE SNAPSHOTS ═══
When provided, reference snapshots are HIGHEST PRIORITY. Replicate their fillColor, strokeColor, cornerRadius, padding, spacing, fonts exactly.

Generate the JSON now.`;


// ── Generation User Prompt ──────────────────────────────────────────

export function buildGeneratePrompt(
  prompt: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  selection?: any,
  fullDesignSystem?: any,
  dsSummary?: any,
  layoutPlan?: any
): string {
  const parts: string[] = [
    "## User Request",
    prompt,
  ];

  // ── 0. Layout Plan (from multi-step pipeline) ──
  if (layoutPlan) {
    parts.push("", "## Layout Plan (FOLLOW THIS STRUCTURE)");
    parts.push("A planning step has already decomposed this screen into semantic blocks.");
    parts.push("You MUST follow this plan exactly — create one FRAME per block, in this order,");
    parts.push("with the specified roles, children structure, and estimated heights.");
    parts.push("");
    parts.push(JSON.stringify(layoutPlan, null, 2));
    parts.push("");
    parts.push("IMPORTANT: Every block in the plan MUST appear as a top-level child of the root FRAME.");
    parts.push("Use the block IDs as frame names. Flesh out each block with real content, proper styling,");
    parts.push("and enough child nodes to create a production-quality design.");
  }

  // ── 1. DSSummary (curated palette — preferred over raw tokens) ──
  if (dsSummary) {
    parts.push("", "## Design System Summary (USE THESE STYLES)");

    // Surface colors
    if (dsSummary.surfaces?.length > 0) {
      parts.push("### Surface Colors (for backgrounds, cards, containers)");
      for (const c of dsSummary.surfaces) {
        parts.push(`- ${c.name}: ${c.hex} → fillStyleName: "${c.name}"  role: ${c.role}`);
      }
    }

    // Text colors
    if (dsSummary.textColors?.length > 0) {
      parts.push("### Text Colors");
      for (const c of dsSummary.textColors) {
        parts.push(`- ${c.name}: ${c.hex} → fillStyleName: "${c.name}"  role: ${c.role}`);
      }
    }

    // Brand/accent colors
    if (dsSummary.brandColors?.length > 0) {
      parts.push("### Brand / Accent Colors (for buttons, links, highlights)");
      for (const c of dsSummary.brandColors) {
        parts.push(`- ${c.name}: ${c.hex} → fillStyleName: "${c.name}"  role: ${c.role}`);
      }
    }

    // Typography roles
    if (dsSummary.typeRoles && Object.keys(dsSummary.typeRoles).length > 0) {
      parts.push("### Typography Roles (MANDATORY: set textStyleName on EVERY TEXT node)");
      parts.push("Use the EXACT fontSize listed for each role — the Figma text style defines a specific size.");
      for (const [role, styleName] of Object.entries(dsSummary.typeRoles)) {
        const fontSize = dsSummary.typeRoleFontSizes?.[role];
        if (fontSize) {
          parts.push(`- ${role}: textStyleName="${styleName}", fontSize: ${fontSize}`);
        } else {
          parts.push(`- ${role}: textStyleName="${styleName}"`);
        }
      }
    }

    // Spacing + Radii + Shadow
    if (dsSummary.spacingScale?.length > 0) {
      parts.push(`### Spacing Scale: ${dsSummary.spacingScale.join(", ")}`);
    }
    if (dsSummary.radii?.length > 0) {
      parts.push(`### Corner Radii: ${dsSummary.radii.join(", ")}`);
    }
    if (dsSummary.shadow) {
      parts.push(`### Default Shadow: ${JSON.stringify(dsSummary.shadow)}`);
    }

    // Blocked styles
    if (dsSummary.blockedStyles?.length > 0) {
      parts.push("### BLOCKED STYLES (do NOT use these as default fills — they are state/interaction styles)");
      parts.push(dsSummary.blockedStyles.slice(0, 20).join(", "));
    }
  }

  // ── 2. Selected frame context ──
  if (selection && selection.nodes && selection.nodes.length > 0) {
    const selectedNode = selection.nodes[0];
    const selectedWidth = selectedNode.width || 0;
    const isMobile = selectedWidth > 0 && selectedWidth <= 500;
    const promptLower = prompt.toLowerCase();
    const wantsDesktop = promptLower.includes("desktop") || promptLower.includes("wide") || promptLower.includes("1440");

    parts.push("", "## Currently Selected Frame");
    parts.push(`Name: "${selectedNode.name || 'unknown'}", ${selectedWidth}×${selectedNode.height || 0}px`);
    parts.push("Keep ALL UI elements from this frame. Replicate text, colors, fonts, styling.");
    parts.push(`DIMENSION RULE: width:${selectedWidth}, height:${selectedNode.height || 0}, layoutSizingVertical:"FIXED".`);

    if (isMobile && wantsDesktop) {
      parts.push("", "DESKTOP ADAPTATION: Source is mobile (" + selectedWidth + "px). Output MUST be 1440px wide.");
      parts.push("Use HORIZONTAL split: left brand panel (720px) + right form panel (720px, inner wrapper 440px).");
    }

    parts.push("", "### Selected Frame Node Tree");
    const nodeJson = JSON.stringify(selectedNode);
    if (nodeJson.length > 200000) {
      parts.push(nodeJson.slice(0, 200000) + '... (truncated)');
    } else {
      parts.push(nodeJson);
    }
  }

  // ── 3. Fallback: raw style tokens (when no dsSummary) ──
  if (!dsSummary && styleTokens && Object.keys(styleTokens).length > 0) {
    parts.push("", "## Design Style Tokens");
    if (styleTokens.fontFamilies?.length > 0) {
      parts.push("Font families: " + styleTokens.fontFamilies.slice(0, 3).join(", "));
    }
    if (styleTokens.fontSizes?.length > 0) {
      parts.push("Font sizes: " + styleTokens.fontSizes.slice(0, 8).join(", "));
    }
    if (styleTokens.colors?.length > 0) {
      const hexToStyleName: Record<string, string> = {};
      if (designSystem.fillStyles?.length > 0) {
        for (const s of designSystem.fillStyles as any[]) {
          if (s.hex) hexToStyleName[s.hex.toUpperCase()] = s.name;
        }
      }
      const annotatedColors = styleTokens.colors.slice(0, 12).map((hex: string) => {
        const styleName = hexToStyleName[hex.toUpperCase()];
        return styleName ? `${hex} (fillStyleName: "${styleName}")` : hex;
      });
      parts.push("Colors: " + annotatedColors.join(", "));
    }
    if (styleTokens.cornerRadii?.length > 0) {
      parts.push("Corner radii: " + styleTokens.cornerRadii.join(", "));
    }
    if (styleTokens.buttonStyles?.length > 0) {
      parts.push("Button styles: " + JSON.stringify(styleTokens.buttonStyles.slice(0, 3)));
    }
    if (styleTokens.inputStyles?.length > 0) {
      parts.push("Input styles: " + JSON.stringify(styleTokens.inputStyles));
    }
  }

  // ── 4. Reference snapshots (highest priority style source) ──
  if (styleTokens?.referenceSnapshots?.length > 0) {
    parts.push("", "## Reference Frame (REPLICATE these styles exactly)");
    const refJson = JSON.stringify(styleTokens.referenceSnapshots[0]);
    if (refJson.length > 80000) {
      parts.push(refJson.slice(0, 80000) + '... (truncated)');
    } else {
      parts.push(refJson);
    }
  }

  // ── 5. Text + paint styles (fallback when dsSummary lacks them) ──
  if (!dsSummary) {
    if (designSystem.textStyles.length > 0) {
      const trimmed = designSystem.textStyles.slice(0, 8).map((s: any) => ({
        name: s.name, fontFamily: s.fontFamily, fontStyle: s.fontStyle, fontSize: s.fontSize
      }));
      parts.push("", "## Text Styles (set textStyleName on EVERY TEXT node)");
      for (const s of trimmed) {
        parts.push(`- ${s.name} (${s.fontFamily}, ${s.fontStyle}, ${s.fontSize}px)`);
      }
    }

    if (designSystem.fillStyles?.length > 0) {
      const styleNames = designSystem.fillStyles.slice(0, 60).map((s: any) => {
        let label = s.name;
        if (s.hex) label += ` → ${s.hex}`;
        return label;
      });
      parts.push("", "## Paint Styles (use fillStyleName to bind)");
      for (const name of styleNames) {
        parts.push(`- ${name}`);
      }
    }
  }

  // ── 6. Full design system (cross-page data) ──
  if (fullDesignSystem) {
    parts.push("", formatFullDesignSystemSection(fullDesignSystem));
  }

  parts.push("", "Generate the complete NodeSnapshot JSON now.");

  const fullPrompt = parts.join("\n");
  console.log(`[buildGeneratePrompt] Total prompt size: ${fullPrompt.length} chars`);
  return fullPrompt;
}

// ── HTML Generation System Prompt ───────────────────────────────────

// ════════════════════════════════════════════════════════════════════
// STEP 1 — Creative HTML Generation (no DS constraints)
// ════════════════════════════════════════════════════════════════════

export const GENERATE_HTML_SYSTEM_PROMPT = `You are an award-winning UI/UX designer and copywriter creating production-quality web pages.
Generate a stunning, modern HTML/CSS page that would impress a design director at a top agency.
The HTML will be rendered in Puppeteer and converted into a Figma design file, so follow the conversion rules below.

Return ONLY a complete HTML document (<!DOCTYPE html>...). No markdown fences, no explanation.

═══ CONTENT STRATEGY (think before you design) ═══
Before writing HTML, mentally plan the CONTENT like a creative director:
- HEADLINE: Write a punchy, benefit-driven headline (not generic "Welcome to X"). Use power words, create urgency or desire.
  BAD: "Welcome to Burger Haven" / "About Our Company"
  GOOD: "Flame-Grilled Perfection, Served Fresh" / "Every Bite Tells a Story"
- SUBHEADLINE: Support the headline with a specific value proposition or emotional hook.
- BODY COPY: Write realistic, compelling text — not lorem ipsum or generic filler. Every section needs enough text to fill its space naturally (2-3 sentences minimum for content sections).
- CTA: Action-oriented button text (not "Submit" / "Click Here"). Use "Order Now", "Explore the Menu", "Reserve a Table", etc.
- SECTION DENSITY: Every section should feel COMPLETE. If you show an image with text beside it, include a heading + 2-3 sentences + a CTA link/button. Empty-feeling sections look unfinished.
- For PARTIAL page requests (e.g., "header and hero"), still make the sections substantial and detailed — don't make them thin or minimal.

═══ MOBILE vs DESKTOP ═══
- For MOBILE (390px): Stack everything vertically. Full-width images. Larger touch targets (min 44px tap areas). Shorter headings. More compact but still spacious padding (32-48px sections).
- For DESKTOP (1440px): Use multi-column layouts. Side-by-side content. Larger hero sections. More generous spacing (64-96px sections).
- The root <div> width is specified in the user prompt — follow it exactly.

═══ DESIGN PHILOSOPHY ═══
Think like a senior designer at a top creative agency. Every pixel matters.
- Create VISUAL IMPACT: Use bold hero sections, dramatic imagery, generous whitespace.
- Establish clear VISUAL HIERARCHY: Guide the eye from most important → supporting → details.
- Use CONTRAST and SCALE: Large headings vs small body text. Bold vs light weights. Dark vs light areas.
- Design with BREATHING ROOM: Generous padding (40-80px vertical sections), ample whitespace between elements.
- Create RHYTHM: Alternate section styles (dark bg/light bg, image-left/image-right, full-width/contained).
- Use COLOR SPARINGLY: 1 dominant neutral, 1-2 accent colors max. Large color-filled areas, not scattered bits.

═══ LAYOUT PATTERNS (use these for professional results) ═══
DESKTOP (1440px):
- HERO SECTION: Full-width, tall (450-600px), with large background image. Overlay semi-transparent dark gradient on the image, then place white heading text on top. Center-aligned text with clear CTA button. The hero should feel IMMERSIVE and DRAMATIC.
- FEATURE/CARDS GRID: 3-4 cards in a horizontal row. Each card: image on top (200-250px tall, same height for all), then text content with padding (heading + description + optional link). Equal card widths via flex:1.
- ALTERNATING CONTENT: Section with image on one side (50% width, 300-400px tall), text content on the other (heading + 2-3 paragraphs + CTA). Alternate left/right for visual rhythm.
- TESTIMONIALS: Large quote text (20-24px italic), customer photo (small 60px circle), name and role below.
- CTA BANNER: Full-width colored background, centered text with button. Stand-out section.
- FOOTER: Dark background, 3-4 columns of links, contact info, social.

MOBILE (390px):
- HERO: Full-width image (250-350px tall) with overlay gradient + centered text. Keep heading shorter (max 6-8 words).
- CARDS: Stack vertically (one per row), full-width. Image + text below each.
- CONTENT SECTIONS: Image on top (full-width, 200-250px), text below. No side-by-side on mobile.
- NAV: Simple row with brand name + hamburger icon (☰) or 2-3 text links max.
- All touch targets: minimum 44px height.

═══ TYPOGRAPHY RULES ═══
- Hero heading: 48-64px, bold (700-900 weight). Make it commanding.
- Section headings: 28-36px, semibold.
- Body text: 16-18px, regular weight, 1.5-1.7 line-height for readability.
- Limit to 2 font weights max (regular + bold). Avoid thin/light weights.
- Text line length: max 600-700px (use max-width on text containers for readability).

═══ SPACING RULES ═══
- Section vertical padding: 64-96px (generous, breathing room).
- Card internal padding: 20-32px.
- Gap between cards: 24-32px.
- Heading to body text: 16-24px.
- Body text to CTA button: 24-32px.
- NEVER use less than 12px padding/gap anywhere. Cramped spacing = amateur design.

═══ COLOR USAGE ═══
- Define ALL colors as CSS custom properties in :root { ... }. Reference them via var(--name) — never raw hex/rgb in rules.
- Background sections: Alternate between white/light-gray (#f8f8f8 or similar) for visual rhythm.
- Accent color: Used ONLY for buttons, links, and small highlights — never huge areas.
- Text: Near-black (#1a1a1a or #222) for body, slightly lighter (#555 or #666) for secondary text.
- Buttons: Solid accent fill, white text, rounded corners (8-12px radius), comfortable padding (16px 32px min).

═══ STRUCTURE ═══
- <body> must contain a single <div id="root"> with the width specified in the user prompt.
- All styles in a single <style> block in <head>. Never use inline style= attributes.

═══ FIGMA CONVERSION RULES (CRITICAL — follow exactly) ═══
These constraints exist because the HTML is parsed into Figma auto-layout frames:
- Use ONLY flexbox for layout (display:flex + flex-direction). No CSS Grid, float, position:absolute/fixed/relative.
- NEVER use position:absolute or position:relative. Elements with position:absolute will be DROPPED from the output.
- Use "gap" for spacing between children, "padding" on containers.
- For elements that should stretch to fill available space in a row, use "flex: 1" (not width:100%).
- No transform, animation, transition, media queries, @keyframes, or JavaScript.
- No CSS mask or mask-image properties.
- No overflow:hidden on containers with content that should be visible.
- box-shadow maps to Figma drop shadows (e.g. box-shadow: 0px 4px 16px 0px rgba(0,0,0,0.08)).
- Star ratings: use ★ and ☆ characters in a <span>, not individual elements.

═══ IMAGES — CRITICAL ═══
Every design MUST include images. Add data-image-prompt as an HTML ATTRIBUTE on the element (NOT as a CSS property).
The backend fetches matching photos from Unsplash and fills the element automatically.

CORRECT — attribute on the HTML element:
  <div class="hero-image" data-image-prompt="gourmet burger fresh ingredients close-up"></div>
  <img alt="outdoor patio" data-image-prompt="outdoor restaurant patio sunny day">

WRONG — never put data-image-prompt in CSS:
  .hero-image { data-image-prompt: "..."; }  /* THIS DOES NOT WORK */

Rules:
- data-image-prompt is an HTML attribute, like class or id. It must be in the HTML markup, not in CSS.
- Use 3-6 specific, descriptive keywords per prompt. Include style cues: "professional", "editorial", "overhead shot", "close-up", etc.
- Elements with data-image-prompt MUST have explicit width AND height in CSS.
- IMPORTANT: All images in a card grid MUST have the SAME explicit height (e.g., all 250px) for visual consistency.
- Include at LEAST 4-6 images per page (hero background, product/service images, gallery, team photos, etc.).
- NEVER use placeholder src values — always use data-image-prompt.
- Hero images should be full-width and at least 400px tall.
- Images make the design look professional and real — a design without images looks broken.

═══ HERO OVERLAY PATTERN (important!) ═══
To put text ON TOP of a hero image, the text MUST be INSIDE the same element that has data-image-prompt.
The data-image-prompt element becomes a frame with an image fill — children render on top of it.

CORRECT — text children inside the image element:
  <div class="hero" data-image-prompt="juicy burger dark moody professional">
    <div class="hero-overlay">
      <h1>Flame-Grilled Perfection</h1>
      <p>Crafted daily with the finest ingredients</p>
      <button>Order Now</button>
    </div>
  </div>
  .hero { display:flex; flex-direction:column; justify-content:center; align-items:center; width:100%; height:500px; }
  .hero-overlay { display:flex; flex-direction:column; align-items:center; gap:16px; padding:40px; background:rgba(0,0,0,0.45); border-radius:12px; }
  .hero h1 { color:white; font-size:48px; }

WRONG — never use a separate sibling div for the image and overlay:
  <div class="hero">
    <div class="hero-bg" data-image-prompt="..."></div>  <!-- WRONG: image and text are siblings -->
    <div class="hero-text"><h1>Title</h1></div>            <!-- Text ends up BELOW the image, not on top -->
  </div>

The CORRECT pattern puts data-image-prompt on the OUTER container and text as children inside it.

═══ COMMON MISTAKES TO AVOID ═══
- Tiny cramped sections with 8px padding (use 64-96px).
- All sections same white background (alternate light/dark styles).
- Too many bright colors everywhere (stick to 1 accent color).
- Text directly on images without overlay/contrast layer.
- Inconsistent image sizes in grids (always match heights).
- Missing visual breaks between sections.
- Generic, boring flat layouts without depth (add subtle shadows/overlays).

Generate the complete HTML document now.`;

// ════════════════════════════════════════════════════════════════════
// STEP 2 — Design System Binding (mechanical CSS rewrite)
// ════════════════════════════════════════════════════════════════════

export const BIND_DS_SYSTEM_PROMPT = `You are a design system engineer. You receive an HTML document and a design system specification.
Your ONLY job is to mechanically rewrite the CSS colors and typography to match the design system.

DO NOT change layout, structure, content, images, or data-image-prompt attributes.

Return the FULL modified HTML document. No markdown fences, no explanation.

═══ COLOR BINDING (CRITICAL) ═══
You MUST replace every hex color value in the :root CSS variables with the ACTUAL hex values from the design system provided below.
Do NOT keep the original hex values. Do NOT invent colors. Use ONLY the exact hex codes given in the DS specification.

For each :root variable, find the closest matching DS color by semantic role:
- background/surface → DS surface color
- primary/brand → DS primary color
- text/foreground → DS text color
- accent/secondary → DS secondary/accent color
- error/danger → DS error color

Add a /* fillStyleName: "ExactDSName" */ comment above each variable with the EXACT style name from the DS.

Example (using DS-provided values, NOT made up):
  :root {
    /* fillStyleName: "Light/Surface" */
    --bg: #F5F5F5;  /* ← this hex MUST come from the DS spec below */
    /* fillStyleName: "Light/Primary" */
    --primary: #6750A4;  /* ← this hex MUST come from the DS spec below */
  }

═══ TYPOGRAPHY BINDING ═══
Above each text CSS rule, add a comment with the matching DS text style name.
Use the EXACT font-size from the DS type role (replace the original font-size).
  /* textStyleName: "Headline/Large" */
  .headline { font-size: 32px; font-weight: 700; }
Match by semantic purpose: display→display, headline→headline, body→body, label→label.

═══ COMPONENT BINDING ═══
Add data-component attributes to elements that match available DS components:
  <button class="btn" data-component="Button/Primary">Click</button>

Return the full modified HTML document now.`;

// ── Step 1: Creative HTML User Prompt ───────────────────────────────

export function buildGenerateHTMLPrompt(
  prompt: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  selection?: any,
  fullDesignSystem?: any,
  dsSummary?: any
): string {
  const parts: string[] = [
    "## User Request",
    prompt,
  ];

  // Detect mobile vs desktop from prompt or selection
  const promptLower = prompt.toLowerCase();
  const isMobile = promptLower.includes("mobile") || promptLower.includes("phone") || promptLower.includes("390") || promptLower.includes("iphone");
  const isDesktop = promptLower.includes("desktop") || promptLower.includes("wide") || promptLower.includes("1440");

  // Determine root width
  let rootWidth = isMobile ? 390 : (isDesktop ? 1440 : 1440); // default to desktop
  if (selection && selection.nodes && selection.nodes.length > 0) {
    const selectedNode = selection.nodes[0];
    const selectedWidth = selectedNode.width || 0;
    if (selectedWidth > 0) {
      rootWidth = selectedWidth;
      parts.push("", "## Target Frame");
      parts.push(`Width: ${selectedWidth}px, Height: ${selectedNode.height || 0}px`);
    }
  }

  parts.push("", `## Layout: ${isMobile ? 'MOBILE' : 'DESKTOP'} — set root <div> to width:${rootWidth}px.`);
  if (isMobile) {
    parts.push("This is a MOBILE design. Stack all content vertically. Use full-width images. No side-by-side columns. Minimum 44px touch targets.");
  }

  // Include font family hint so the LLM picks a reasonable default
  const fontFamilies = styleTokens?.fontFamilies || [];
  if (fontFamilies.length > 0) {
    parts.push("", `## Font: Use "${fontFamilies[0]}" as the primary font-family.`);
  }

  // Encourage content depth
  parts.push("", "## Content Guidelines");
  parts.push("Write compelling, realistic copy — not generic filler. Every section should feel complete with enough text, images, and visual weight. Avoid empty-feeling sections.");

  parts.push("", "Generate the complete HTML document now. Return ONLY the HTML — no markdown fences, no explanation.");

  const fullPrompt = parts.join("\n");
  console.log(`[buildGenerateHTMLPrompt] Step 1 prompt size: ${fullPrompt.length} chars`);
  return fullPrompt;
}

// ── Step 2: DS Binding User Prompt ──────────────────────────────────

export function buildDSBindingPrompt(
  html: string,
  styleTokens: any,
  designSystem: DesignSystemSnapshot,
  fullDesignSystem?: any,
  dsSummary?: any
): string | null {
  // If there's no design system context, skip Step 2 entirely
  // dsSummary fields are OBJECTS (surfaces.background, text.primary, brand.primary) not arrays
  const hasDSSummary = dsSummary && (
    (dsSummary.surfaces && (dsSummary.surfaces.background || dsSummary.surfaces.surface || dsSummary.surfaces.surfaceContainer)) ||
    (dsSummary.text && (dsSummary.text.primary || dsSummary.text.secondary)) ||
    (dsSummary.brand && (dsSummary.brand.primary || dsSummary.brand.secondary || dsSummary.brand.accent)) ||
    (dsSummary.typeRoles && Object.keys(dsSummary.typeRoles).length > 0)
  );
  const hasTextStyles = designSystem?.textStyles?.length > 0;
  const hasFillStyles = designSystem?.fillStyles?.length > 0;
  const hasComponents = fullDesignSystem?.components?.length > 0 || designSystem?.components?.length > 0;

  if (!hasDSSummary && !hasTextStyles && !hasFillStyles && !hasComponents) {
    console.log(`[buildDSBindingPrompt] No DS context available — skipping Step 2`);
    return null;
  }

  const parts: string[] = [
    "## HTML to Modify",
    "Below is the HTML document. Rewrite its CSS to use the design system tokens described after it.",
    "Do NOT change layout, structure, content, images, or data-image-prompt attributes.",
    "",
    "```html",
    html,
    "```",
  ];

  // ── DS Colors ──
  if (dsSummary) {
    parts.push("", "## Design System Colors");
    parts.push("Replace the existing :root CSS variables with these DS colors. Add /* fillStyleName: \"...\" */ comments.");
    parts.push("");
    parts.push(":root {");

    // Helper to emit a color token
    const emitToken = (role: string, varPrefix: string, token: any) => {
      if (!token || !token.hex) return;
      const varName = `--${varPrefix}${role.replace(/[A-Z]/g, (m: string) => '-' + m.toLowerCase()).replace(/^-/, '')}`;
      parts.push(`  /* fillStyleName: "${token.styleName}" */`);
      parts.push(`  ${varName}: ${token.hex};`);
    };

    if (dsSummary.surfaces && (dsSummary.surfaces.background || dsSummary.surfaces.surface || dsSummary.surfaces.surfaceContainer)) {
      parts.push("  /* ── Surface Colors ── */");
      for (const [role, token] of Object.entries(dsSummary.surfaces)) {
        emitToken(role, "", token);
      }
    }

    if (dsSummary.text && (dsSummary.text.primary || dsSummary.text.secondary)) {
      parts.push("  /* ── Text Colors ── */");
      for (const [role, token] of Object.entries(dsSummary.text)) {
        emitToken(role, "text-", token);
      }
    }

    if (dsSummary.brand && (dsSummary.brand.primary || dsSummary.brand.secondary || dsSummary.brand.accent)) {
      parts.push("  /* ── Brand / Accent Colors ── */");
      for (const [role, token] of Object.entries(dsSummary.brand)) {
        emitToken(role, "brand-", token);
      }
    }

    parts.push("}");

    // Typography roles
    if (dsSummary.typeRoles && Object.keys(dsSummary.typeRoles).length > 0) {
      parts.push("", "## Typography Roles");
      parts.push("Add /* textStyleName: \"...\" */ comments above matching text CSS rules.");
      parts.push("Use the EXACT font-size from each role.");
      for (const [role, styleName] of Object.entries(dsSummary.typeRoles)) {
        const fontSize = dsSummary.typeRoleFontSizes?.[role];
        if (fontSize) {
          parts.push(`- ${role}: textStyleName="${styleName}" → font-size: ${fontSize}px`);
        } else {
          parts.push(`- ${role}: textStyleName="${styleName}"`);
        }
      }
    }

    // Spacing/radii hints
    if (dsSummary.radii?.length > 0) {
      parts.push(`\n## Corner Radii: ${dsSummary.radii.join(", ")}px — prefer these values.`);
    }
  }

  // Fallback: raw style tokens
  if (!dsSummary && styleTokens && Object.keys(styleTokens).length > 0) {
    parts.push("", "## Style Tokens");
    if (styleTokens.colors?.length > 0) {
      parts.push("Colors: " + styleTokens.colors.slice(0, 12).join(", "));
    }
  }

  // Fallback: text + paint styles
  if (!dsSummary) {
    if (designSystem.textStyles.length > 0) {
      const trimmed = designSystem.textStyles.slice(0, 8).map((s: any) => s.name);
      parts.push("", "## Text Styles (add textStyleName comments)");
      parts.push(trimmed.join(", "));
    }
    if (designSystem.fillStyles?.length > 0) {
      const styleNames = designSystem.fillStyles.slice(0, 30).map((s: any) => {
        let label = s.name;
        if (s.hex) label += ` → ${s.hex}`;
        return label;
      });
      parts.push("", "## Paint Styles (map to CSS variables with fillStyleName comments)");
      for (const name of styleNames) {
        parts.push(`- ${name}`);
      }
    }
  }

  // Full design system
  if (fullDesignSystem) {
    parts.push("", formatFullDesignSystemSection(fullDesignSystem));
  }

  // Components
  const components = fullDesignSystem?.components || designSystem?.components || [];
  if (components.length > 0) {
    parts.push("", "## Available Components — add data-component attributes to matching elements");
    for (const comp of components.slice(0, 25)) {
      const name = comp.name || comp.key;
      if (name) parts.push(`- ${name}`);
    }
  }

  parts.push("", "Return the FULL modified HTML document now. No markdown fences, no explanation.");

  const fullPrompt = parts.join("\n");
  console.log(`[buildDSBindingPrompt] Step 2 prompt size: ${fullPrompt.length} chars`);
  return fullPrompt;
}

// ── Plan System Prompt (Multi-Step Pipeline Step 1) ─────────────────

export const PLAN_SYSTEM_PROMPT = `You are a senior UI/UX architect creating a structural layout plan for a Figma frame.
Return ONLY valid JSON — no markdown, no prose, no explanation.

═══ OUTPUT FORMAT ═══
Return a JSON object with this structure:
{
  "blocks": [
    {
      "id": "header",
      "role": "header|hero|nav|content|card|list|grid|cta|footer|form|stats|filters|tabs",
      "label": "Human-readable section label",
      "description": "What this block contains and its purpose",
      "layout": "VERTICAL|HORIZONTAL",
      "estimatedHeight": 120,
      "children": [
        {
          "id": "header-title",
          "role": "text|icon|image|button|input|divider|badge|avatar|rating",
          "label": "Section title",
          "description": "Main heading text"
        }
      ]
    }
  ],
  "rootWidth": 390,
  "rootLayout": "VERTICAL",
  "theme": "light|dark",
  "density": "compact|normal|spacious"
}

═══ PLANNING RULES ═══
1. Decompose the screen into 4-8 major semantic blocks.
2. Each block should have 2-6 children describing its internal structure.
3. Think about visual hierarchy: what draws the eye first? What is secondary?
4. Consider spacing rhythm: use alternating tight/loose spacing between blocks.
5. For lists/grids, specify the number of items and their card structure.
6. For mobile (390px), plan for single-column vertical scroll.
7. For desktop (1440px), plan for multi-column layouts with sidebars or split panels.
8. Every block must have a clear role and purpose — no generic "container" blocks.
9. Aim for 30-80 total leaf nodes across all blocks.

═══ ROLE DEFINITIONS ═══
- header: Top bar with title, navigation, actions
- hero: Large visual section with primary message
- nav: Navigation bar or tab bar
- content: Generic content area
- card: Individual card component
- list: Vertical list of items
- grid: Grid layout of items
- cta: Call-to-action section
- footer: Bottom section
- form: Input form
- stats: Statistics/metrics display
- filters: Filter controls
- tabs: Tab navigation

Generate the layout plan JSON now.`;

export function buildPlanPrompt(
  prompt: string,
  dsSummary?: any
): string {
  const parts: string[] = [
    "## User Request",
    prompt,
  ];

  if (dsSummary) {
    parts.push("", "## Design System Context");
    if (dsSummary.surfaces?.length > 0) {
      parts.push("Available surface colors: " + dsSummary.surfaces.map((c: any) => c.name).join(", "));
    }
    if (dsSummary.typeRoles && Object.keys(dsSummary.typeRoles).length > 0) {
      parts.push("Typography roles: " + Object.keys(dsSummary.typeRoles).join(", "));
    }
    if (dsSummary.spacingScale?.length > 0) {
      parts.push("Spacing scale: " + dsSummary.spacingScale.join(", "));
    }
  }

  parts.push("", "Generate the layout plan JSON now.");
  return parts.join("\n");
}

// ── Refine System Prompt (Multi-Step Pipeline Step 3) ───────────────

export const REFINE_SYSTEM_PROMPT = `You are a senior design QA reviewer examining a generated Figma frame.
You receive a screenshot of the frame and its node ID tree.
Your job is to identify visual problems and return EDIT OPERATIONS to fix them.

Return ONLY valid JSON — no markdown, no prose, no explanation.

═══ OUTPUT FORMAT ═══
{
  "operations": [
    { "type": "SET_LAYOUT_PROPS", "nodeId": "...", "paddingTop": 16, ... },
    { "type": "RESIZE_NODE", "nodeId": "...", "width": 390 },
    { "type": "SET_TEXT", "nodeId": "...", "text": "..." },
    { "type": "SET_FILL_COLOR", "nodeId": "...", "color": "#..." },
    { "type": "SET_SIZE_MODE", "nodeId": "...", "horizontal": "FILL" }
  ]
}

═══ WHAT TO CHECK ═══
1. Text clipping or overflow — fix with RESIZE_NODE or SET_SIZE_MODE (HUG/FILL).
2. Insufficient padding — fix with SET_LAYOUT_PROPS.
3. Inconsistent spacing — fix with SET_LAYOUT_PROPS (itemSpacing).
4. Elements too small (buttons < 44px height, text < 10px) — fix with RESIZE_NODE.
5. Poor contrast (light text on light bg or dark on dark) — fix with SET_FILL_COLOR.
6. Misaligned elements — fix with SET_LAYOUT_PROPS or SET_SIZE_MODE.
7. Excessive whitespace or cramped sections — fix spacing.
8. Missing visual hierarchy — ensure heading/body/caption text sizes differ.

═══ OPERATION TYPES AVAILABLE ═══
- SET_LAYOUT_PROPS: { nodeId, paddingTop?, paddingRight?, paddingBottom?, paddingLeft?, itemSpacing?, counterAxisSpacing? }
- RESIZE_NODE: { nodeId, width?, height? }
- SET_TEXT: { nodeId, text }
- SET_FILL_COLOR: { nodeId, color: "#HEXHEX" }
- SET_SIZE_MODE: { nodeId, horizontal?: "FIXED"|"FILL"|"HUG", vertical?: "FIXED"|"FILL"|"HUG" }
- SET_LAYOUT_MODE: { nodeId, layoutMode: "HORIZONTAL"|"VERTICAL"|"NONE" }

═══ RULES ═══
- Only return operations for REAL problems visible in the screenshot.
- Use the node IDs from the provided tree — do NOT invent IDs.
- Prefer minimal changes — fix only what is broken.
- If the design looks good, return { "operations": [] }.
- Maximum 20 operations per response.

Return the operations JSON now.`;

export function buildRefinePrompt(
  nodeTree: string,
  prompt: string
): string {
  const parts: string[] = [
    "## Original Request",
    prompt,
    "",
    "## Node ID Tree (use these IDs in operations)",
    nodeTree,
    "",
    "Examine the screenshot carefully. Identify any visual problems and return fix operations.",
  ];
  return parts.join("\n");
}
