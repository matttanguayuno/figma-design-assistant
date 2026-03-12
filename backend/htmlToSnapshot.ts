// backend/htmlToSnapshot.ts
// Converts rendered HTML DOM tree into a NodeSnapshot structure
// that the Figma plugin can consume via createNodeFromSnapshot().
//
// This function runs inside page.evaluate() in Puppeteer, so it must
// be completely self-contained — no imports, no closures over external vars.
//
// Design-system style maps (fillStyleName, textStyleName) are parsed
// server-side from the raw HTML source and injected as arguments to
// page.evaluate(), because browsers strip CSS comments from the CSSOM.

// ── Types for the pre-parsed style maps ─────────────────────────

export interface FillStyleEntry {
  hex: string;
  fillStyleName: string;
  cssVar?: string;  // e.g. "--surface-bg"
}

export interface TextStyleEntry {
  selector: string;      // CSS selector string
  textStyleName: string;
}

/**
 * Parse the raw HTML source to extract fillStyleName mappings from CSS comments.
 * Pattern: \/\* fillStyleName: "Light/Surface" \*\/\n  --surface-bg: #FFFFFF;
 *
 * Returns a map of uppercase-hex → fillStyleName.
 */
export function extractFillStyleMap(htmlSource: string): FillStyleEntry[] {
  const entries: FillStyleEntry[] = [];
  // Match: /* fillStyleName: "Name" */  --var: #hex;
  const pattern = /\/\*\s*fillStyleName:\s*"([^"]+)"\s*\*\/\s*\n?\s*(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = pattern.exec(htmlSource)) !== null) {
    entries.push({
      fillStyleName: m[1],
      cssVar: m[2],
      hex: m[3].trim().toUpperCase(),
    });
  }
  return entries;
}

/**
 * Parse the raw HTML source to extract textStyleName mappings from CSS comments.
 * Pattern: \/\* textStyleName: "Heading/Large" \*\/\n  h1 { ... }
 *
 * Returns an array of { selector, textStyleName }.
 */
export function extractTextStyleMap(htmlSource: string): TextStyleEntry[] {
  const entries: TextStyleEntry[] = [];
  // Match: /* textStyleName: "Name" */\n  selector { ... }
  const pattern = /\/\*\s*textStyleName:\s*"([^"]+)"\s*\*\/\s*\n?\s*([\w\s.#\-\[\]=:>,*+~"'()]+?)\s*\{/g;
  let m;
  while ((m = pattern.exec(htmlSource)) !== null) {
    entries.push({
      textStyleName: m[1],
      selector: m[2].trim(),
    });
  }
  return entries;
}

/**
 * Parse data-component attributes from the HTML source.
 * These let the LLM hint which elements should become Figma component instances.
 */
export function extractComponentHints(htmlSource: string): boolean {
  return htmlSource.includes("data-component");
}

/**
 * The page.evaluate script that walks the rendered DOM and extracts
 * a NodeSnapshot-compatible JSON tree.
 *
 * Arguments are injected by page.evaluate():
 *   fillStyles: array of { hex, fillStyleName, cssVar }
 *   textStyles: array of { selector, textStyleName }
 *
 * Must be called as: page.evaluate(DOM_TO_SNAPSHOT_SCRIPT, fillStyles, textStyles)
 */
export const DOM_TO_SNAPSHOT_SCRIPT = (
  fillStyles: { hex: string; fillStyleName: string; cssVar?: string }[],
  textStyles: { selector: string; textStyleName: string }[]
) => {

  // ── Helpers ────────────────────────────────────────────────────

  /** Parse a CSS color string (rgb, rgba, hex) into a hex string */
  function colorToHex(color: string): string | null {
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") return null;
    // Already hex
    if (color.startsWith("#")) return color.toUpperCase();
    // rgb(r, g, b) or rgba(r, g, b, a)
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return null;
    const r = parseInt(match[1]);
    const g = parseInt(match[2]);
    const b = parseInt(match[3]);
    return "#" + [r, g, b].map(c => c.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  /** Parse box-shadow into a Figma-compatible effect */
  function parseBoxShadow(shadow: string): any | null {
    if (!shadow || shadow === "none") return null;
    // Format: Xpx Ypx Rpx Spx rgba(r,g,b,a)  or  Xpx Ypx Rpx color
    const match = shadow.match(
      /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s*(-?\d+(?:\.\d+)?)?\s*(?:px\s+)?(.+)/
    );
    if (!match) return null;
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const radius = parseFloat(match[3]);
    const spread = match[4] ? parseFloat(match[4]) : 0;
    const colorStr = match[5].trim();

    // Parse shadow color
    let r = 0, g = 0, b = 0, a = 0.08;
    const rgbaMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (rgbaMatch) {
      r = parseInt(rgbaMatch[1]) / 255;
      g = parseInt(rgbaMatch[2]) / 255;
      b = parseInt(rgbaMatch[3]) / 255;
      a = rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1;
    }

    return {
      type: "DROP_SHADOW" as const,
      radius,
      spread,
      offset: { x, y },
      color: { r, g, b, a },
    };
  }

  /** Map CSS font-weight to Figma fontStyle */
  function fontWeightToStyle(weight: string): string {
    const w = parseInt(weight) || 400;
    if (w >= 800) return "Extra Bold";
    if (w >= 700) return "Bold";
    if (w >= 600) return "Semi Bold";
    if (w >= 500) return "Medium";
    if (w >= 300) return "Light";
    return "Regular";
  }

  /** Map CSS text-align to Figma textAlignHorizontal */
  function textAlignToFigma(align: string): string {
    switch (align) {
      case "center": return "CENTER";
      case "right":
      case "end": return "RIGHT";
      case "justify": return "JUSTIFIED";
      default: return "LEFT";
    }
  }

  /** Map CSS justify-content to Figma primaryAxisAlignItems */
  function justifyToFigma(justify: string): string {
    switch (justify) {
      case "center": return "CENTER";
      case "flex-end":
      case "end": return "MAX";
      case "space-between": return "SPACE_BETWEEN";
      default: return "MIN";
    }
  }

  /** Map CSS align-items to Figma counterAxisAlignItems */
  function alignToFigma(align: string): string {
    switch (align) {
      case "center": return "CENTER";
      case "flex-end":
      case "end": return "MAX";
      default: return "MIN";
    }
  }

  /** 
   * Build a hex→fillStyleName lookup from the pre-parsed fill styles.
   * Also resolves CSS variable values from the computed root style.
   */
  function buildFillStyleLookup(
    rootStyle: CSSStyleDeclaration
  ): Map<string, string> {
    const hexToStyle = new Map<string, string>();

    for (const entry of fillStyles) {
      // Direct hex match
      if (entry.hex) {
        hexToStyle.set(entry.hex.toUpperCase(), entry.fillStyleName);
      }
      // Also resolve the CSS variable to get the computed value
      if (entry.cssVar) {
        const resolved = rootStyle.getPropertyValue(entry.cssVar).trim();
        if (resolved) {
          const hex = colorToHex(resolved);
          if (hex) hexToStyle.set(hex, entry.fillStyleName);
        }
      }
    }

    return hexToStyle;
  }

  /** Find fillStyleName for a computed color */
  function resolveColorToStyleName(
    hexColor: string | null,
    hexToStyle: Map<string, string>
  ): string | undefined {
    if (!hexColor) return undefined;
    return hexToStyle.get(hexColor.toUpperCase());
  }

  /** 
   * Find textStyleName for an element using the pre-parsed text style selectors.
   * Uses element.matches() to test if the element matches any of the selectors
   * that had a textStyleName CSS comment above them.
   */
  function resolveTextStyleName(element: Element): string | undefined {
    for (const entry of textStyles) {
      try {
        if (element.matches(entry.selector)) {
          return entry.textStyleName;
        }
      } catch (e) {
        // Invalid selector, try splitting compound selectors
        const parts = entry.selector.split(",").map(s => s.trim());
        for (const part of parts) {
          try {
            if (element.matches(part)) return entry.textStyleName;
          } catch {}
        }
      }
    }
    return undefined;
  }

  // ── Text element tags ──
  const TEXT_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "SPAN", "LABEL", "A", "LI", "STRONG", "EM", "B", "I", "SMALL",
    "FIGCAPTION", "BLOCKQUOTE", "CITE", "TIME", "ABBR",
  ]);

  // ── Frame/container element tags ──
  const FRAME_TAGS = new Set([
    "DIV", "SECTION", "HEADER", "FOOTER", "NAV", "MAIN", "ASIDE",
    "FORM", "UL", "OL", "ARTICLE", "DETAILS", "SUMMARY", "FIELDSET",
    "FIGURE", "DL", "TABLE",
  ]);

  /** Determine if an element is a text-leaf (renders as TEXT in Figma) */
  function isTextElement(el: Element): boolean {
    if (TEXT_TAGS.has(el.tagName)) return true;
    // Also treat elements that only contain text content as text
    if (el.children.length === 0 && el.textContent?.trim()) return true;
    return false;
  }

  let _nodeCounter = 0;

  // ── Main walker ────────────────────────────────────────────────

  function walkElement(
    el: Element,
    hexToStyle: Map<string, string>,
    depth: number = 0
  ): any | null {
    const tag = el.tagName;
    const style = window.getComputedStyle(el);

    // Skip invisible elements
    if (style.display === "none" || style.visibility === "hidden") return null;
    if (style.opacity === "0") return null;

    // Skip position:absolute/fixed elements — they break auto-layout conversion.
    // These elements are out of normal flow; when converted to auto-layout children
    // they stack sequentially instead of overlapping, causing text to appear
    // outside/below frames instead of overlaying images.
    if (depth > 0 && (style.position === "absolute" || style.position === "fixed")) {
      console.log(`[DOM walker] Skipping position:${style.position} element: <${tag}> (breaks auto-layout)`);
      return null;
    }

    // Skip elements with CSS mask/mask-image (these can't be converted to Figma)
    const maskImage = style.getPropertyValue("mask-image") || style.getPropertyValue("-webkit-mask-image");
    if (maskImage && maskImage !== "none") return null;

    const rect = el.getBoundingClientRect();
    // Skip zero-size elements (unless they're text with content)
    if (rect.width === 0 && rect.height === 0 && !el.textContent?.trim()) return null;

    _nodeCounter++;
    const nodeId = `html_${_nodeCounter}`;

    // ── Images ──
    if (tag === "IMG") {
      const node: any = {
        id: nodeId,
        name: (el as HTMLImageElement).alt || "image",
        type: "RECTANGLE",
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        childrenCount: 0,
      };
      const bgColor = colorToHex(style.backgroundColor);
      if (bgColor) {
        node.fillColor = bgColor;
        node.fillStyleName = resolveColorToStyleName(bgColor, hexToStyle);
      }
      const cr = parseFloat(style.borderRadius);
      if (cr > 0) node.cornerRadius = Math.round(cr);
      // Extract data-image-prompt for stock photo resolution
      const imgPrompt = (el as HTMLElement).getAttribute?.("data-image-prompt");
      if (imgPrompt) {
        node.imagePrompt = imgPrompt;
      } else {
        // Fallback: use alt text as image search query if no data-image-prompt
        const altText = (el as HTMLImageElement).alt;
        if (altText && altText.length > 2 && altText.toLowerCase() !== "image") {
          node.imagePrompt = altText;
        }
      }
      return node;
    }

    // ── HR → thin rectangle divider ──
    if (tag === "HR") {
      const bgColor = colorToHex(style.borderTopColor) || colorToHex(style.backgroundColor);
      return {
        id: nodeId,
        name: "divider",
        type: "RECTANGLE",
        width: Math.round(rect.width),
        height: Math.max(1, Math.round(rect.height)),
        fillColor: bgColor || "#E0E0E0",
        fillStyleName: resolveColorToStyleName(bgColor, hexToStyle),
        layoutSizingHorizontal: "FILL",
        childrenCount: 0,
      };
    }

    // ── Text-leaf elements ──
    if (isTextElement(el) && el.children.length === 0) {
      const text = el.textContent?.trim();
      if (!text) return null;

      const fillColor = colorToHex(style.color);
      const cn = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
      const node: any = {
        id: nodeId,
        name: cn ? cn.split(/\s+/)[0] : tag.toLowerCase(),
        type: "TEXT",
        characters: text,
        fontSize: Math.round(parseFloat(style.fontSize)),
        fontFamily: style.fontFamily.replace(/["']/g, "").split(",")[0].trim(),
        fontStyle: fontWeightToStyle(style.fontWeight),
        fillColor: fillColor,
        textAlignHorizontal: textAlignToFigma(style.textAlign),
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
        childrenCount: 0,
      };

      // Line height
      const lh = parseFloat(style.lineHeight);
      if (!isNaN(lh) && lh > 0) {
        node.lineHeight = Math.round(lh);
      }

      // Letter spacing
      const ls = parseFloat(style.letterSpacing);
      if (!isNaN(ls) && ls !== 0) {
        node.letterSpacing = Math.round(ls * 100) / 100;
      }

      // Text decoration
      if (style.textDecorationLine === "underline") {
        node.textDecoration = "UNDERLINE";
      } else if (style.textDecorationLine === "line-through") {
        node.textDecoration = "STRIKETHROUGH";
      }

      // Text transform
      if (style.textTransform === "uppercase") {
        node.textCase = "UPPER";
      } else if (style.textTransform === "lowercase") {
        node.textCase = "LOWER";
      }

      // Style binding
      node.fillStyleName = resolveColorToStyleName(fillColor, hexToStyle);
      node.textStyleName = resolveTextStyleName(el);

      return node;
    }

    // ── Button → FRAME with TEXT child ──
    if (tag === "BUTTON") {
      const text = el.textContent?.trim() || "Button";
      const bgColor = colorToHex(style.backgroundColor);
      const textColor = colorToHex(style.color);

      const textNode: any = {
        id: `html_${++_nodeCounter}`,
        name: "label",
        type: "TEXT",
        characters: text,
        fontSize: Math.round(parseFloat(style.fontSize)),
        fontFamily: style.fontFamily.replace(/["']/g, "").split(",")[0].trim(),
        fontStyle: fontWeightToStyle(style.fontWeight),
        fillColor: textColor,
        fillStyleName: resolveColorToStyleName(textColor, hexToStyle),
        textStyleName: resolveTextStyleName(el),
        textAlignHorizontal: "CENTER",
        layoutSizingVertical: "HUG",
        childrenCount: 0,
      };

      const cnBtn = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
      const node: any = {
        id: nodeId,
        name: cnBtn ? cnBtn.split(/\s+/)[0] : "button",
        type: "FRAME",
        width: Math.round(rect.width),
        height: Math.max(44, Math.round(rect.height)),
        layoutMode: "HORIZONTAL",
        primaryAxisAlignItems: "CENTER",
        counterAxisAlignItems: "CENTER",
        paddingTop: Math.round(parseFloat(style.paddingTop)),
        paddingRight: Math.round(parseFloat(style.paddingRight)),
        paddingBottom: Math.round(parseFloat(style.paddingBottom)),
        paddingLeft: Math.round(parseFloat(style.paddingLeft)),
        fillColor: bgColor,
        fillStyleName: resolveColorToStyleName(bgColor, hexToStyle),
        layoutSizingHorizontal: "FILL",
        childrenCount: 1,
        children: [textNode],
      };

      // data-component for buttons
      const btnComp = (el as HTMLElement).getAttribute?.("data-component");
      if (btnComp) node.componentName = btnComp;

      const cr = parseFloat(style.borderRadius);
      if (cr > 0) node.cornerRadius = Math.round(cr);

      // Border
      const bw = parseFloat(style.borderWidth);
      if (bw > 0) {
        node.strokeWeight = Math.round(bw);
        const bc = colorToHex(style.borderColor);
        if (bc) {
          node.strokeColor = bc;
        }
      }

      return node;
    }

    // ── Input/textarea/select → FRAME styled as input ──
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const bgColor = colorToHex(style.backgroundColor);
      const textColor = colorToHex(style.color);
      const placeholder = (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || "Input";

      const textNode: any = {
        id: `html_${++_nodeCounter}`,
        name: "placeholder",
        type: "TEXT",
        characters: placeholder,
        fontSize: Math.round(parseFloat(style.fontSize)),
        fontFamily: style.fontFamily.replace(/["']/g, "").split(",")[0].trim(),
        fontStyle: "Regular",
        fillColor: textColor || "#999999",
        fillStyleName: resolveColorToStyleName(textColor, hexToStyle),
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
        childrenCount: 0,
      };

      const cnInp = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
      const node: any = {
        id: nodeId,
        name: cnInp ? cnInp.split(/\s+/)[0] : "input",
        type: "FRAME",
        width: Math.round(rect.width),
        height: Math.max(44, Math.round(rect.height)),
        layoutMode: "HORIZONTAL",
        counterAxisAlignItems: "CENTER",
        paddingTop: Math.round(parseFloat(style.paddingTop)),
        paddingRight: Math.round(parseFloat(style.paddingRight)),
        paddingBottom: Math.round(parseFloat(style.paddingBottom)),
        paddingLeft: Math.round(parseFloat(style.paddingLeft)),
        fillColor: bgColor,
        fillStyleName: resolveColorToStyleName(bgColor, hexToStyle),
        layoutSizingHorizontal: "FILL",
        childrenCount: 1,
        children: [textNode],
      };

      const cr = parseFloat(style.borderRadius);
      if (cr > 0) node.cornerRadius = Math.round(cr);

      const bw = parseFloat(style.borderWidth);
      if (bw > 0) {
        node.strokeWeight = Math.round(bw);
        const bc = colorToHex(style.borderColor);
        if (bc) node.strokeColor = bc;
      }

      return node;
    }

    // ── Container elements → FRAME ──
    // Recurse into children
    const children: any[] = [];

    // If this element has mixed text + element children, wrap text runs as TEXT nodes
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childSnapshot = walkElement(child as Element, hexToStyle, depth + 1);
        if (childSnapshot) children.push(childSnapshot);
      } else if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent?.trim();
        if (text) {
          _nodeCounter++;
          children.push({
            id: `html_${_nodeCounter}`,
            name: "text",
            type: "TEXT",
            characters: text,
            fontSize: Math.round(parseFloat(style.fontSize)),
            fontFamily: style.fontFamily.replace(/["']/g, "").split(",")[0].trim(),
            fontStyle: fontWeightToStyle(style.fontWeight),
            fillColor: colorToHex(style.color),
            fillStyleName: resolveColorToStyleName(colorToHex(style.color), hexToStyle),
            layoutSizingHorizontal: "FILL",
            layoutSizingVertical: "HUG",
            childrenCount: 0,
          });
        }
      }
    }

    // Determine layout direction
    const flexDir = style.flexDirection;
    const display = style.display;
    let layoutMode: "VERTICAL" | "HORIZONTAL" = "VERTICAL";
    if (display === "flex" || display === "inline-flex") {
      layoutMode = (flexDir === "row" || flexDir === "row-reverse") ? "HORIZONTAL" : "VERTICAL";
    }

    const bgColor = colorToHex(style.backgroundColor);
    const cnFrame = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
    const node: any = {
      id: nodeId,
      name: cnFrame ? cnFrame.split(/\s+/)[0] : (el.id || tag.toLowerCase()),
      type: "FRAME",
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      layoutMode,
      primaryAxisAlignItems: justifyToFigma(style.justifyContent),
      counterAxisAlignItems: alignToFigma(style.alignItems),
      paddingTop: Math.round(parseFloat(style.paddingTop)),
      paddingRight: Math.round(parseFloat(style.paddingRight)),
      paddingBottom: Math.round(parseFloat(style.paddingBottom)),
      paddingLeft: Math.round(parseFloat(style.paddingLeft)),
      childrenCount: children.length,
      children: children.length > 0 ? children : undefined,
    };

    // data-component → componentName for DS component instantiation
    const compAttr = (el as HTMLElement).getAttribute?.("data-component");
    if (compAttr) {
      node.componentName = compAttr;
    }

    // data-image-prompt → imagePrompt for stock photo resolution
    // Used on divs that act as image containers (hero backgrounds, thumbnails)
    const imgPromptAttr = (el as HTMLElement).getAttribute?.("data-image-prompt");
    if (imgPromptAttr) {
      node.imagePrompt = imgPromptAttr;
    }

    // Fill color
    if (bgColor) {
      node.fillColor = bgColor;
      node.fillStyleName = resolveColorToStyleName(bgColor, hexToStyle);
    }

    // Gap → itemSpacing
    const gap = parseFloat(style.gap || style.rowGap || "0");
    if (gap > 0) node.itemSpacing = Math.round(gap);

    // Column gap for wrap layouts
    const colGap = parseFloat(style.columnGap || "0");
    if (colGap > 0 && colGap !== gap) node.counterAxisSpacing = Math.round(colGap);

    // Flex wrap
    if (style.flexWrap === "wrap") node.layoutWrap = "WRAP";

    // Corner radius
    const cr = parseFloat(style.borderRadius);
    if (cr > 0) node.cornerRadius = Math.round(cr);

    // Clipping
    if (style.overflow === "hidden" || style.overflow === "clip") {
      node.clipsContent = true;
    }

    // Border / stroke
    const bw = parseFloat(style.borderWidth);
    if (bw > 0) {
      node.strokeWeight = Math.round(bw);
      const bc = colorToHex(style.borderColor);
      if (bc) node.strokeColor = bc;
    }

    // Box shadow → effects
    const shadow = parseBoxShadow(style.boxShadow);
    if (shadow) node.effects = [shadow];

    // Opacity
    const opacity = parseFloat(style.opacity);
    if (!isNaN(opacity) && opacity < 1) node.opacity = opacity;

    // Sizing hints based on flex properties and parent direction
    const flexGrow = parseFloat(style.flexGrow);
    if (depth === 0) {
      // Root element gets FIXED sizing
      node.layoutSizingHorizontal = "FIXED";
      node.layoutSizingVertical = "HUG";
    } else {
      // Child elements: in a VERTICAL layout, children fill horizontal by default
      // (CSS align-items defaults to stretch). In HORIZONTAL, same for vertical.
      // Also handle explicit flex-grow.
      const parentAlignItems = style.alignSelf || "auto"; // "auto" means inherit parent's align-items
      if (layoutMode === "VERTICAL") {
        // Items in a column fill width (stretch is CSS default)
        node.layoutSizingHorizontal = "FILL";
        node.layoutSizingVertical = "HUG";
        if (flexGrow > 0) node.layoutSizingVertical = "FILL";
      } else {
        // Items in a row
        node.layoutSizingVertical = "HUG";
        if (flexGrow > 0) node.layoutSizingHorizontal = "FILL";
      }
    }

    // Post-process children's sizing based on THIS container's layout direction.
    // layoutSizingHorizontal/Vertical describe how a child behaves inside its parent,
    // so children's sizing must match the parent's layout mode, not the child's own.
    if (children.length > 0) {
      for (const child of children) {
        if (layoutMode === "HORIZONTAL") {
          // In a row, children should HUG along the primary (horizontal) axis
          // so justify-content (SPACE_BETWEEN, etc.) can distribute space.
          // Exception: children with flex-grow already have FILL set above.
          if (child.type === "TEXT") {
            child.layoutSizingHorizontal = "HUG";
          }
          if (child.type === "FRAME" && !child.layoutSizingHorizontal) {
            child.layoutSizingHorizontal = "HUG";
          }
        } else {
          // In a column, children should FILL horizontally (CSS stretch default).
          if (child.type === "FRAME" && !child.layoutSizingHorizontal) {
            child.layoutSizingHorizontal = "FILL";
          }
          // TEXT children already default to FILL from their construction.
        }
      }
    }

    return node;
  }

  // ── Entry point ────────────────────────────────────────────────

  const root = document.getElementById("root") || document.body.firstElementChild || document.body;
  const rootStyle = window.getComputedStyle(document.documentElement);
  const hexToStyle = buildFillStyleLookup(rootStyle);

  const snapshot = walkElement(root, hexToStyle, 0);

  if (snapshot) {
    // Ensure root has a sensible name
    snapshot.name = document.title || "Generated Screen";
  }

  return snapshot;
};

/**
 * Post-process a snapshot that came from the DOM walker:
 * - Fill any missing fillStyleName bindings by matching hex colors
 * - Fill any missing textStyleName bindings using dsSummary type roles
 * - Clean up empty/duplicate nodes
 */
export function postProcessHTMLSnapshot(
  snapshot: any,
  htmlSource: string,
  dsSummary?: any
): any {
  if (!snapshot) return snapshot;

  // Build hex → styleName map from the pre-parsed entries (belt-and-suspenders)
  const fillEntries = extractFillStyleMap(htmlSource);
  const hexToStyleName = new Map<string, string>();
  for (const e of fillEntries) {
    hexToStyleName.set(e.hex.toUpperCase(), e.fillStyleName);
  }

  // Build a simple textStyleName fallback map from dsSummary typeRoles
  // e.g. { heading: "Heading/Large", body: "Body/Medium", ... }
  const typeRoleFallbacks = new Map<string, string>();
  const typeRoleSizes = new Map<string, number>();
  if (dsSummary?.typeRoles) {
    for (const [role, styleName] of Object.entries(dsSummary.typeRoles)) {
      typeRoleFallbacks.set(role.toLowerCase(), styleName as string);
    }
  }
  if (dsSummary?.typeRoleFontSizes) {
    for (const [role, size] of Object.entries(dsSummary.typeRoleFontSizes)) {
      typeRoleSizes.set(role.toLowerCase(), size as number);
    }
  }

  // Build a sorted array of [role, fontSize] for closest-match assignment
  const roleSizeEntries = [...typeRoleSizes.entries()].sort((a, b) => b[1] - a[1]);

  // Walk the snapshot tree and fill missing bindings
  function enrichNode(node: any): void {
    if (!node) return;

    // If we have a fillColor but no fillStyleName, try to resolve from our map
    if (node.fillColor && !node.fillStyleName) {
      const styleName = hexToStyleName.get(node.fillColor.toUpperCase());
      if (styleName) node.fillStyleName = styleName;
    }

    // If TEXT node has no textStyleName, find the closest matching role by font size
    if (node.type === "TEXT" && !node.textStyleName && typeRoleFallbacks.size > 0) {
      const fontSize = node.fontSize || 16;

      if (roleSizeEntries.length > 0) {
        // Find the role whose font size is closest to this node's font size
        let bestRole = roleSizeEntries[0][0];
        let bestDiff = Math.abs(fontSize - roleSizeEntries[0][1]);
        for (const [role, size] of roleSizeEntries) {
          const diff = Math.abs(fontSize - size);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestRole = role;
          }
        }
        node.textStyleName = typeRoleFallbacks.get(bestRole);
      } else {
        // Fallback: hardcoded thresholds when no DS font sizes available
        if (fontSize >= 28 && typeRoleFallbacks.has("headline")) {
          node.textStyleName = typeRoleFallbacks.get("headline");
        } else if (fontSize >= 22 && typeRoleFallbacks.has("title")) {
          node.textStyleName = typeRoleFallbacks.get("title");
        } else if (fontSize >= 14 && typeRoleFallbacks.has("body")) {
          node.textStyleName = typeRoleFallbacks.get("body");
        } else if (typeRoleFallbacks.has("caption")) {
          node.textStyleName = typeRoleFallbacks.get("caption");
        } else if (typeRoleFallbacks.has("label")) {
          node.textStyleName = typeRoleFallbacks.get("label");
        }
      }
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        enrichNode(child);
      }
    }
  }

  enrichNode(snapshot);
  return snapshot;
}
