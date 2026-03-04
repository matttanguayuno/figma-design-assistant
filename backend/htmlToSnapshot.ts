// backend/htmlToSnapshot.ts
// Converts rendered HTML DOM tree into a NodeSnapshot structure
// that the Figma plugin can consume via createNodeFromSnapshot().
//
// This function runs inside page.evaluate() in Puppeteer, so it must
// be completely self-contained — no imports, no closures over external vars.

/**
 * The page.evaluate script that walks the rendered DOM and extracts
 * a NodeSnapshot-compatible JSON tree.
 *
 * Must be called as: page.evaluate(DOM_TO_SNAPSHOT_SCRIPT)
 */
export const DOM_TO_SNAPSHOT_SCRIPT = () => {

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

  /** Parse :root CSS variables and map them to Figma style names via their comments */
  function extractCSSVariableMap(): Record<string, { hex: string; fillStyleName?: string; textStyleName?: string }> {
    const varMap: Record<string, { hex: string; fillStyleName?: string; textStyleName?: string }> = {};

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSStyleRule && rule.selectorText === ":root") {
            // Parse the raw CSS text to find /* fillStyleName: "..." */ comments
            const cssText = rule.cssText;
            // Match patterns like: /* fillStyleName: "Light/Surface" */\n  --surface-bg: #FFFFFF;
            const varPattern = /\/\*\s*(?:fillStyleName|textStyleName):\s*"([^"]+)"\s*\*\/\s*\n?\s*(--[\w-]+)\s*:\s*([^;]+);/g;
            let m;
            while ((m = varPattern.exec(cssText)) !== null) {
              const styleName = m[1];
              const varName = m[2];
              const value = m[3].trim();
              varMap[varName] = { hex: value, fillStyleName: styleName };
            }

            // Also grab all variables from computed style as fallback
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith("--")) {
                const val = rule.style.getPropertyValue(prop).trim();
                if (!varMap[prop]) {
                  varMap[prop] = { hex: val };
                }
              }
            }
          }
        }
      } catch (e) {
        // Cross-origin stylesheet, skip
      }
    }
    return varMap;
  }

  /** Find which CSS variable a computed color value maps to */
  function resolveColorToStyleName(
    hexColor: string | null,
    varMap: Record<string, { hex: string; fillStyleName?: string }>,
    rootStyle: CSSStyleDeclaration
  ): string | undefined {
    if (!hexColor) return undefined;
    // Check each CSS variable's resolved value against this color
    for (const [varName, info] of Object.entries(varMap)) {
      const resolvedHex = colorToHex(rootStyle.getPropertyValue(varName).trim());
      if (resolvedHex && resolvedHex.toUpperCase() === hexColor.toUpperCase() && info.fillStyleName) {
        return info.fillStyleName;
      }
    }
    return undefined;
  }

  /** Extract textStyleName from CSS comments in stylesheets for a given element */
  function resolveTextStyleName(element: Element): string | undefined {
    // We'll try to find a matching CSS rule with a textStyleName comment
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSStyleRule) {
            try {
              if (element.matches(rule.selectorText)) {
                const cssText = rule.cssText;
                const m = cssText.match(/\/\*\s*textStyleName:\s*"([^"]+)"\s*\*\//);
                if (m) return m[1];
              }
            } catch (e) {
              // Invalid selector, skip
            }
          }
        }
      } catch (e) {
        // Cross-origin stylesheet, skip
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
    varMap: Record<string, { hex: string; fillStyleName?: string }>,
    rootStyle: CSSStyleDeclaration,
    depth: number = 0
  ): any | null {
    const tag = el.tagName;
    const style = window.getComputedStyle(el);

    // Skip invisible elements
    if (style.display === "none" || style.visibility === "hidden") return null;
    if (style.opacity === "0") return null;

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
        node.fillStyleName = resolveColorToStyleName(bgColor, varMap, rootStyle);
      }
      const cr = parseFloat(style.borderRadius);
      if (cr > 0) node.cornerRadius = Math.round(cr);
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
        fillStyleName: resolveColorToStyleName(bgColor, varMap, rootStyle),
        layoutSizingHorizontal: "FILL",
        childrenCount: 0,
      };
    }

    // ── Text-leaf elements ──
    if (isTextElement(el) && el.children.length === 0) {
      const text = el.textContent?.trim();
      if (!text) return null;

      const fillColor = colorToHex(style.color);
      const node: any = {
        id: nodeId,
        name: el.className ? (el as HTMLElement).className.split(/\s+/)[0] : tag.toLowerCase(),
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
      node.fillStyleName = resolveColorToStyleName(fillColor, varMap, rootStyle);
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
        fillStyleName: resolveColorToStyleName(textColor, varMap, rootStyle),
        textStyleName: resolveTextStyleName(el),
        textAlignHorizontal: "CENTER",
        layoutSizingVertical: "HUG",
        childrenCount: 0,
      };

      const node: any = {
        id: nodeId,
        name: el.className ? (el as HTMLElement).className.split(/\s+/)[0] : "button",
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
        fillStyleName: resolveColorToStyleName(bgColor, varMap, rootStyle),
        layoutSizingHorizontal: "FILL",
        childrenCount: 1,
        children: [textNode],
      };

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
        fillStyleName: resolveColorToStyleName(textColor, varMap, rootStyle),
        layoutSizingHorizontal: "FILL",
        layoutSizingVertical: "HUG",
        childrenCount: 0,
      };

      const node: any = {
        id: nodeId,
        name: el.className ? (el as HTMLElement).className.split(/\s+/)[0] : "input",
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
        fillStyleName: resolveColorToStyleName(bgColor, varMap, rootStyle),
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
        const childSnapshot = walkElement(child as Element, varMap, rootStyle, depth + 1);
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
            fillStyleName: resolveColorToStyleName(colorToHex(style.color), varMap, rootStyle),
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
    const node: any = {
      id: nodeId,
      name: el.className
        ? (el as HTMLElement).className.split(/\s+/)[0]
        : (el.id || tag.toLowerCase()),
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

    // Fill color
    if (bgColor) {
      node.fillColor = bgColor;
      node.fillStyleName = resolveColorToStyleName(bgColor, varMap, rootStyle);
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

    // Sizing hints based on flex properties
    const flexGrow = parseFloat(style.flexGrow);
    if (flexGrow > 0) {
      node.layoutSizingHorizontal = layoutMode === "VERTICAL" ? "FILL" : "FILL";
    }
    if (depth === 0) {
      // Root element gets FIXED sizing
      node.layoutSizingHorizontal = "FIXED";
      node.layoutSizingVertical = "HUG";
    }

    return node;
  }

  // ── Entry point ────────────────────────────────────────────────

  const root = document.getElementById("root") || document.body.firstElementChild || document.body;
  const varMap = extractCSSVariableMap();
  const rootStyle = window.getComputedStyle(document.documentElement);

  const snapshot = walkElement(root, varMap, rootStyle, 0);

  if (snapshot) {
    // Ensure root has a sensible name
    snapshot.name = document.title || "Generated Screen";
  }

  return snapshot;
};

/**
 * Post-process a snapshot that came from the DOM walker:
 * - Parse CSS variable comments from the original HTML to rebuild style name bindings
 * - Clean up empty/duplicate nodes
 */
export function postProcessHTMLSnapshot(
  snapshot: any,
  htmlSource: string
): any {
  if (!snapshot) return snapshot;

  // Extract fillStyleName and textStyleName from CSS comments in the HTML source
  // Pattern: /* fillStyleName: "StyleName" */\n  --var-name: #hex;
  const fillStyleMap = new Map<string, string>();
  const textStyleMap = new Map<string, string>();

  // Build hex → styleName map from CSS variable comments
  const fillPattern = /\/\*\s*fillStyleName:\s*"([^"]+)"\s*\*\/\s*\n?\s*--[\w-]+\s*:\s*([^;]+);/g;
  let m;
  while ((m = fillPattern.exec(htmlSource)) !== null) {
    const styleName = m[1];
    const hexRaw = m[2].trim().toUpperCase();
    fillStyleMap.set(hexRaw, styleName);
  }

  const textPattern = /\/\*\s*textStyleName:\s*"([^"]+)"\s*\*\//g;
  while ((m = textPattern.exec(htmlSource)) !== null) {
    // For text styles we just collect the names — binding is harder from computed CSS
    textStyleMap.set(m[1], m[1]);
  }

  // Walk the snapshot tree and ensure fillStyleName bindings are present
  function enrichNode(node: any): void {
    if (!node) return;

    // If we have a fillColor but no fillStyleName, try to resolve from our map
    if (node.fillColor && !node.fillStyleName) {
      const styleName = fillStyleMap.get(node.fillColor.toUpperCase());
      if (styleName) node.fillStyleName = styleName;
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
