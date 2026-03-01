"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __objRest = (source, exclude) => {
    var target = {};
    for (var prop in source)
      if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
        target[prop] = source[prop];
    if (source != null && __getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(source)) {
        if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
          target[prop] = source[prop];
      }
    return target;
  };

  // figma-plugin/code.ts
  var CHANGE_LOG_FRAME_NAME = "AI Change Log";
  var lastRevertState = null;
  var _skipResizePropagation = false;
  var _cancelled = false;
  var _working = false;
  var _userApiKey = "";
  var _selectedProvider = "anthropic";
  var _selectedModel = "claude-sonnet-4-20250514";
  var CACHE_TTL_MS = 6e4;
  var _designSystemCache = null;
  var _rawTokenCache = null;
  var _fullDesignSystem = null;
  var _extractDSCancelled = false;
  function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  var _fetchSeq = 0;
  var _pendingFetch = null;
  function fetchViaUI(endpoint, body) {
    const seq = ++_fetchSeq;
    return new Promise((resolve, reject) => {
      _pendingFetch = { resolve, reject, seq };
      const safeBody = JSON.parse(JSON.stringify(body));
      sendToUI({ type: "do-fetch", endpoint, body: safeBody, seq });
    });
  }
  var _nextJobId = 0;
  var _activeJobs = /* @__PURE__ */ new Map();
  var _pendingFetches = /* @__PURE__ */ new Map();
  function fetchViaUIForJob(endpoint, body, jobId) {
    const seq = ++_fetchSeq;
    return new Promise((resolve, reject) => {
      _pendingFetches.set(seq, { resolve, reject, jobId });
      const safeBody = JSON.parse(JSON.stringify(body));
      sendToUI({ type: "do-fetch", endpoint, body: safeBody, seq, jobId });
    });
  }
  var _nextPlaceX = null;
  var MIN_WIDTH = 340;
  var MIN_HEIGHT = 280;
  figma.showUI(__html__, { width: MIN_WIDTH, height: MIN_HEIGHT, title: "Uno Design Assistant" });
  clearAuditBadges();
  function sendToUI(msg) {
    figma.ui.postMessage(msg);
  }
  var MAX_SNAPSHOT_DEPTH = 15;
  var _tempIdCounter = 0;
  function assignTempIds(snap) {
    if (!snap) return;
    snap.id = `gen_${++_tempIdCounter}`;
    if (Array.isArray(snap.children)) {
      for (const child of snap.children) assignTempIds(child);
    }
  }
  async function extractStyleTokens(userPrompt) {
    const hasFreshRawCache = _rawTokenCache && Date.now() - _rawTokenCache.ts < CACHE_TTL_MS;
    if (hasFreshRawCache) {
      console.log("[extractStyleTokens] Using cached raw data (age: " + Math.round((Date.now() - _rawTokenCache.ts) / 1e3) + "s), recomputing reference for prompt");
      return _buildFinalTokens(
        _rawTokenCache.colors,
        _rawTokenCache.cornerRadii,
        _rawTokenCache.fontSizes,
        _rawTokenCache.fontFamilies,
        _rawTokenCache.spacings,
        _rawTokenCache.paddings,
        _rawTokenCache.buttonStyles,
        _rawTokenCache.inputStyles,
        _rawTokenCache.rootFrameLayouts,
        _rawTokenCache.designFramesMeta,
        userPrompt
      );
    }
    const colors = /* @__PURE__ */ new Set();
    const cornerRadii = /* @__PURE__ */ new Set();
    const fontSizes = /* @__PURE__ */ new Set();
    const fontFamilies = /* @__PURE__ */ new Set();
    const spacings = /* @__PURE__ */ new Set();
    const paddings = /* @__PURE__ */ new Set();
    const buttonStyles = [];
    const inputStyles = [];
    const validTopLevelTypes = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"]);
    const pageFrames = figma.currentPage.children.filter(
      (c) => validTopLevelTypes.has(c.type) && c.name !== CHANGE_LOG_FRAME_NAME
    );
    console.log("[extractStyleTokens] Top-level nodes:", figma.currentPage.children.map((c) => `${c.name} (${c.type})`).join(", "));
    function solidToHex(fills) {
      const s = Array.isArray(fills) ? fills.find((f) => f.type === "SOLID" && f.visible !== false) : void 0;
      if (s && s.type === "SOLID") {
        const c = s.color;
        return "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
      }
      return void 0;
    }
    function findTextChild(node, maxDepth = 4) {
      if (!("children" in node)) return null;
      function search(n, depth) {
        if (depth > maxDepth) return null;
        if (!("children" in n)) return null;
        for (const child of n.children) {
          if (child.type === "TEXT") return child;
          const deeper = search(child, depth + 1);
          if (deeper) return deeper;
        }
        return null;
      }
      return search(node, 0);
    }
    function countTextDescendants(node) {
      let count = 0;
      if (node.type === "TEXT") count++;
      if ("children" in node) {
        for (const child of node.children) {
          count += countTextDescendants(child);
        }
      }
      return count;
    }
    function extractTextProps(tn) {
      const props = {};
      try {
        const tFills = tn.fills;
        const tHex = solidToHex(tFills);
        if (tHex) props.textColor = tHex;
      } catch (_) {
      }
      if (typeof tn.fontSize === "number") props.textFontSize = tn.fontSize;
      if (typeof tn.fontName !== "symbol" && tn.fontName) {
        props.textFontFamily = tn.fontName.family;
        props.textFontStyle = tn.fontName.style;
      }
      if (tn.textDecoration && tn.textDecoration !== "NONE") {
        props.textDecoration = tn.textDecoration;
      }
      if (tn.textAlignHorizontal) props.textAlignHorizontal = tn.textAlignHorizontal;
      return props;
    }
    let currentRootFrameName = "";
    function walkNode(node, depth) {
      if (depth > 6) return;
      if ("fills" in node && Array.isArray(node.fills)) {
        const hex = solidToHex(node.fills);
        if (hex) colors.add(hex);
      }
      if ("cornerRadius" in node && typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
        cornerRadii.add(node.cornerRadius);
      }
      if (node.type === "TEXT") {
        const textNode = node;
        if (typeof textNode.fontSize === "number") fontSizes.add(textNode.fontSize);
        if (typeof textNode.fontName !== "symbol" && textNode.fontName) {
          fontFamilies.add(textNode.fontName.family);
        }
      }
      if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
        const frame = node;
        if (frame.layoutMode && frame.layoutMode !== "NONE") {
          if (frame.itemSpacing > 0) spacings.add(frame.itemSpacing);
          if (frame.paddingTop > 0) paddings.add(frame.paddingTop);
          if (frame.paddingRight > 0) paddings.add(frame.paddingRight);
          if (frame.paddingBottom > 0) paddings.add(frame.paddingBottom);
          if (frame.paddingLeft > 0) paddings.add(frame.paddingLeft);
        }
        const nameLower = frame.name.toLowerCase();
        const isInputByName = /textbox|passwordbox|\binput\b|searchbox|text.?field/.test(nameLower);
        const isButtonByName = /^button$/i.test(frame.name) || /\bbutton\b/i.test(frame.name);
        const isExcludedFromButton = /navigationbar|\btab|tabbar|tabsstack|personpicture|avatar|chipgroup|template\//.test(nameLower);
        const nonButtonFills = /* @__PURE__ */ new Set(["#FFFFFF", "#FCFBFF", "#F5F5F5", "#F0F0F0", "#F3EFF5", "#E5DEFF", "#1C1B1F"]);
        if (isInputByName && frame.height >= 35 && frame.height <= 70) {
          const textChild = findTextChild(node);
          if (textChild) {
            const fillHex = solidToHex(frame.fills);
            const strokeHex = solidToHex(frame.strokes);
            const inputStyle = {
              name: frame.name,
              cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : void 0,
              height: Math.round(frame.height),
              width: Math.round(frame.width)
            };
            if (fillHex) inputStyle.fillColor = fillHex;
            if (strokeHex) {
              inputStyle.strokeColor = strokeHex;
              if (typeof frame.strokeWeight === "number") inputStyle.strokeWeight = frame.strokeWeight;
            }
            const stw = {
              top: frame.strokeTopWeight || 0,
              right: frame.strokeRightWeight || 0,
              bottom: frame.strokeBottomWeight || 0,
              left: frame.strokeLeftWeight || 0
            };
            if (stw.bottom > 0 && stw.top === 0 && stw.left === 0 && stw.right === 0) {
              inputStyle.bottomBorderOnly = true;
              inputStyle.bottomBorderWeight = stw.bottom;
            }
            if (frame.layoutMode && frame.layoutMode !== "NONE") {
              inputStyle.layoutMode = frame.layoutMode;
              inputStyle.paddingTop = frame.paddingTop;
              inputStyle.paddingBottom = frame.paddingBottom;
              inputStyle.paddingLeft = frame.paddingLeft;
              inputStyle.paddingRight = frame.paddingRight;
              inputStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
              inputStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
            }
            Object.assign(inputStyle, extractTextProps(textChild));
            inputStyle._sourceFrame = currentRootFrameName;
            inputStyles.push(inputStyle);
          }
        } else if (!isInputByName && !isExcludedFromButton && (isButtonByName || frame.height >= 30 && frame.height <= 75)) {
          const fillHex = solidToHex(frame.fills);
          const textChild = findTextChild(node);
          if (fillHex && textChild && !nonButtonFills.has(fillHex)) {
            const textCount = countTextDescendants(node);
            if (textCount <= 3) {
              const btnStyle = {
                name: frame.name,
                cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : void 0,
                fillColor: fillHex,
                height: Math.round(frame.height),
                width: Math.round(frame.width)
              };
              if (frame.layoutMode && frame.layoutMode !== "NONE") {
                btnStyle.layoutMode = frame.layoutMode;
                btnStyle.paddingTop = frame.paddingTop;
                btnStyle.paddingBottom = frame.paddingBottom;
                btnStyle.paddingLeft = frame.paddingLeft;
                btnStyle.paddingRight = frame.paddingRight;
                btnStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
                btnStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
              }
              if (frame.layoutSizingHorizontal) btnStyle.layoutSizingHorizontal = frame.layoutSizingHorizontal;
              if (frame.layoutSizingVertical) btnStyle.layoutSizingVertical = frame.layoutSizingVertical;
              Object.assign(btnStyle, extractTextProps(textChild));
              btnStyle._sourceFrame = currentRootFrameName;
              buttonStyles.push(btnStyle);
            }
          }
          if (!fillHex || nonButtonFills.has(fillHex)) {
            const strokeHex = solidToHex(frame.strokes);
            if (strokeHex && textChild && isButtonByName) {
              const textCount = countTextDescendants(node);
              if (textCount <= 3) {
                const btnStyle = {
                  name: frame.name,
                  cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : void 0,
                  fillColor: fillHex || "#FFFFFF",
                  strokeColor: strokeHex,
                  strokeWeight: typeof frame.strokeWeight === "number" ? frame.strokeWeight : 1,
                  height: Math.round(frame.height),
                  width: Math.round(frame.width)
                };
                if (frame.layoutMode && frame.layoutMode !== "NONE") {
                  btnStyle.layoutMode = frame.layoutMode;
                  btnStyle.paddingTop = frame.paddingTop;
                  btnStyle.paddingBottom = frame.paddingBottom;
                  btnStyle.paddingLeft = frame.paddingLeft;
                  btnStyle.paddingRight = frame.paddingRight;
                  btnStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
                  btnStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
                }
                if (frame.layoutSizingHorizontal) btnStyle.layoutSizingHorizontal = frame.layoutSizingHorizontal;
                if (frame.layoutSizingVertical) btnStyle.layoutSizingVertical = frame.layoutSizingVertical;
                Object.assign(btnStyle, extractTextProps(textChild));
                btnStyle._sourceFrame = currentRootFrameName;
                buttonStyles.push(btnStyle);
              }
            }
          }
        } else if (frame.height >= 35 && frame.height <= 70 && !isInputByName && !isButtonByName && !isExcludedFromButton) {
          const textChild = findTextChild(node);
          const textSize = textChild && typeof textChild.fontSize === "number" ? textChild.fontSize : 0;
          if (textChild && countTextDescendants(node) <= 3 && textSize <= 16) {
            const fillHex = solidToHex(frame.fills);
            const strokeHex = solidToHex(frame.strokes);
            let bottomBorderWeight = 0;
            let strokeInfo = {};
            const stw = {
              top: frame.strokeTopWeight || 0,
              right: frame.strokeRightWeight || 0,
              bottom: frame.strokeBottomWeight || 0,
              left: frame.strokeLeftWeight || 0
            };
            if (stw.bottom > 0 && stw.top === 0 && stw.left === 0 && stw.right === 0) {
              bottomBorderWeight = stw.bottom;
              strokeInfo.bottomBorderOnly = true;
              strokeInfo.bottomBorderWeight = bottomBorderWeight;
            }
            const isInput = fillHex && nonButtonFills.has(fillHex) || strokeHex || bottomBorderWeight > 0;
            if (isInput) {
              const inputStyle = {
                name: frame.name,
                cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : void 0,
                height: Math.round(frame.height),
                width: Math.round(frame.width)
              };
              if (fillHex) inputStyle.fillColor = fillHex;
              if (strokeHex) {
                inputStyle.strokeColor = strokeHex;
                if (typeof frame.strokeWeight === "number") inputStyle.strokeWeight = frame.strokeWeight;
              }
              Object.assign(inputStyle, strokeInfo);
              if (frame.layoutMode && frame.layoutMode !== "NONE") {
                inputStyle.layoutMode = frame.layoutMode;
                inputStyle.paddingTop = frame.paddingTop;
                inputStyle.paddingBottom = frame.paddingBottom;
                inputStyle.paddingLeft = frame.paddingLeft;
                inputStyle.paddingRight = frame.paddingRight;
                inputStyle.primaryAxisAlignItems = frame.primaryAxisAlignItems;
                inputStyle.counterAxisAlignItems = frame.counterAxisAlignItems;
              }
              Object.assign(inputStyle, extractTextProps(textChild));
              inputStyle._sourceFrame = currentRootFrameName;
              inputStyles.push(inputStyle);
            }
          }
        }
      }
      if ("children" in node) {
        for (const child of node.children) {
          walkNode(child, depth + 1);
        }
      }
    }
    const designFrames = pageFrames.filter((f) => {
      if (f.name.startsWith("Generation ") || f.name.startsWith("Try the plugin")) return false;
      if ("getPluginData" in f && f.getPluginData("generated") === "true") return false;
      return true;
    });
    console.log("[extractStyleTokens] Walking", designFrames.length, "design frames (skipping generated):", designFrames.map((f) => `${f.name} (${f.type})`).join(", "));
    for (let i = 0; i < designFrames.length; i++) {
      currentRootFrameName = designFrames[i].name;
      walkNode(designFrames[i], 0);
      if (i % 3 === 2) await yieldToUI();
    }
    console.log("[extractStyleTokens] Found", buttonStyles.length, "buttons:", JSON.stringify(buttonStyles));
    console.log("[extractStyleTokens] Found", inputStyles.length, "inputs:", JSON.stringify(inputStyles));
    const rootFrameLayouts = [];
    for (const frame of designFrames.slice(0, 5)) {
      if ("layoutMode" in frame) {
        const f = frame;
        const layout = {
          name: f.name,
          width: Math.round(f.width),
          height: Math.round(f.height)
        };
        if (f.layoutMode && f.layoutMode !== "NONE") {
          layout.layoutMode = f.layoutMode;
          layout.paddingTop = f.paddingTop;
          layout.paddingRight = f.paddingRight;
          layout.paddingBottom = f.paddingBottom;
          layout.paddingLeft = f.paddingLeft;
          layout.itemSpacing = f.itemSpacing;
          layout.primaryAxisAlignItems = f.primaryAxisAlignItems;
          layout.counterAxisAlignItems = f.counterAxisAlignItems;
        }
        const fills = f.fills;
        const solidFill = Array.isArray(fills) ? fills.find((fl) => fl.type === "SOLID" && fl.visible !== false) : void 0;
        if (solidFill && solidFill.type === "SOLID") {
          const c = solidFill.color;
          layout.fillColor = "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
        }
        rootFrameLayouts.push(layout);
      }
    }
    const designFramesMeta = designFrames.filter((f) => "children" in f && f.height >= 500 && f.children.length >= 3).map((f) => ({
      name: f.name,
      height: Math.round(f.height),
      childrenCount: f.children.length,
      nodeId: f.id
    }));
    _rawTokenCache = {
      ts: Date.now(),
      colors: [...colors],
      cornerRadii: [...cornerRadii].sort((a, b) => a - b),
      fontSizes: [...fontSizes].sort((a, b) => a - b),
      fontFamilies: [...fontFamilies],
      spacings: [...spacings].sort((a, b) => a - b),
      paddings: [...paddings].sort((a, b) => a - b),
      buttonStyles: buttonStyles.map((b) => __spreadValues({}, b)),
      // preserve _sourceFrame
      inputStyles: inputStyles.map((i) => __spreadValues({}, i)),
      // preserve _sourceFrame
      rootFrameLayouts,
      designFramesMeta
    };
    return _buildFinalTokens(
      _rawTokenCache.colors,
      _rawTokenCache.cornerRadii,
      _rawTokenCache.fontSizes,
      _rawTokenCache.fontFamilies,
      _rawTokenCache.spacings,
      _rawTokenCache.paddings,
      _rawTokenCache.buttonStyles,
      _rawTokenCache.inputStyles,
      _rawTokenCache.rootFrameLayouts,
      _rawTokenCache.designFramesMeta,
      userPrompt
    );
  }
  function _compactSnapshot(node, depth, maxDepth) {
    if (depth > maxDepth) return null;
    const snap = { name: node.name, type: node.type };
    snap.width = Math.round(node.width);
    snap.height = Math.round(node.height);
    if ("layoutMode" in node) {
      const frame = node;
      const lm = frame.layoutMode;
      if (lm === "HORIZONTAL" || lm === "VERTICAL") {
        snap.layoutMode = lm;
        if (frame.paddingTop > 0) snap.paddingTop = frame.paddingTop;
        if (frame.paddingRight > 0) snap.paddingRight = frame.paddingRight;
        if (frame.paddingBottom > 0) snap.paddingBottom = frame.paddingBottom;
        if (frame.paddingLeft > 0) snap.paddingLeft = frame.paddingLeft;
        if (frame.itemSpacing > 0) snap.itemSpacing = frame.itemSpacing;
        snap.primaryAxisAlignItems = frame.primaryAxisAlignItems;
        snap.counterAxisAlignItems = frame.counterAxisAlignItems;
        if ("layoutSizingHorizontal" in frame) {
          snap.layoutSizingHorizontal = frame.layoutSizingHorizontal;
          snap.layoutSizingVertical = frame.layoutSizingVertical;
        }
      }
    }
    if ("fills" in node) {
      try {
        const fills = node.fills;
        if (Array.isArray(fills) && fills.length > 0) {
          const sf = fills.find((f) => f.type === "SOLID" && f.visible !== false);
          if (sf) {
            const toH = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
            snap.fillColor = `#${toH(sf.color.r)}${toH(sf.color.g)}${toH(sf.color.b)}`.toUpperCase();
          }
        }
      } catch (_) {
      }
    }
    if ("cornerRadius" in node) {
      const cr = node.cornerRadius;
      if (typeof cr === "number" && cr > 0) snap.cornerRadius = cr;
    }
    if ("strokes" in node) {
      try {
        const strokes = node.strokes;
        if (Array.isArray(strokes) && strokes.length > 0) {
          const ss = strokes.find((s) => s.type === "SOLID" && s.visible !== false);
          if (ss) {
            const toH = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
            snap.strokeColor = `#${toH(ss.color.r)}${toH(ss.color.g)}${toH(ss.color.b)}`.toUpperCase();
            const sw = node.strokeWeight;
            if (typeof sw === "number" && sw > 0) snap.strokeWeight = sw;
            const stw = node.strokeTopWeight;
            if (typeof stw === "number") {
              const top = stw || 0, right = node.strokeRightWeight || 0;
              const bottom = node.strokeBottomWeight || 0, left = node.strokeLeftWeight || 0;
              if (top !== bottom || left !== right || top !== left) {
                snap.strokeTopWeight = top;
                snap.strokeRightWeight = right;
                snap.strokeBottomWeight = bottom;
                snap.strokeLeftWeight = left;
              }
            }
          }
        }
      } catch (_) {
      }
    }
    if (node.type === "TEXT") {
      const tn = node;
      snap.characters = tn.characters;
      if (typeof tn.fontSize === "number") snap.fontSize = tn.fontSize;
      if (typeof tn.fontName !== "symbol" && tn.fontName) {
        snap.fontFamily = tn.fontName.family;
        snap.fontStyle = tn.fontName.style;
      }
      snap.textAlignHorizontal = tn.textAlignHorizontal;
      try {
        const tFills = tn.fills;
        if (Array.isArray(tFills)) {
          const sf = tFills.find((f) => f.type === "SOLID" && f.visible !== false);
          if (sf) {
            const toH = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
            snap.fillColor = `#${toH(sf.color.r)}${toH(sf.color.g)}${toH(sf.color.b)}`.toUpperCase();
          }
        }
      } catch (_) {
      }
      const td = tn.textDecoration;
      if (typeof td === "string" && td !== "NONE") snap.textDecoration = td;
    }
    if ("children" in node && depth < maxDepth) {
      const children = node.children;
      if (children.length > 0) {
        const mapped = children.map((c) => _compactSnapshot(c, depth + 1, maxDepth)).filter(Boolean);
        if (mapped.length > 0) snap.children = mapped;
      }
    }
    return snap;
  }
  function _buildFinalTokens(colors, cornerRadii, fontSizes, fontFamilies, spacings, paddings, rawButtonStyles, rawInputStyles, rootFrameLayouts, designFramesMeta, userPrompt) {
    const referenceSnapshots = [];
    const detectedNames = /* @__PURE__ */ new Set([
      ...rawButtonStyles.map((b) => b.name),
      ...rawInputStyles.map((i) => i.name)
    ]);
    function countDetectedDescendants(node) {
      let count = 0;
      if (detectedNames.has(node.name)) count++;
      if ("children" in node) {
        for (const c of node.children) count += countDetectedDescendants(c);
      }
      return count;
    }
    const promptWords = (userPrompt || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    let bestFrameNode = null;
    let bestFrameName = "";
    let bestScore = -1;
    for (const meta of designFramesMeta) {
      let score = 0;
      const frameNameLower = meta.name.toLowerCase();
      for (const word of promptWords) {
        if (frameNameLower.includes(word)) {
          score += 100;
          break;
        }
      }
      const frameNode = figma.currentPage.findOne((n) => n.id === meta.nodeId);
      if (frameNode) {
        score += countDetectedDescendants(frameNode);
        score += Math.min(meta.childrenCount, 10) * 0.1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestFrameNode = frameNode;
        bestFrameName = meta.name;
      }
    }
    if (!bestFrameNode) {
      for (const meta of designFramesMeta) {
        const frameNode = figma.currentPage.findOne((n) => n.id === meta.nodeId);
        if (frameNode) {
          bestFrameNode = frameNode;
          bestFrameName = meta.name;
          break;
        }
      }
    }
    if (bestFrameNode) {
      console.log("[extractStyleTokens] Reference snapshot from:", bestFrameName, "(score:", bestScore, ")");
      referenceSnapshots.push(_compactSnapshot(bestFrameNode, 0, 4));
    }
    const refFrameName = bestFrameName;
    const sortBySource = (a, b) => {
      const aMatch = a._sourceFrame === refFrameName ? 0 : 1;
      const bMatch = b._sourceFrame === refFrameName ? 0 : 1;
      return aMatch - bMatch;
    };
    const sortedButtons = [...rawButtonStyles].sort(sortBySource);
    const sortedInputs = [...rawInputStyles].sort(sortBySource);
    const finalButtonStyles = sortedButtons.slice(0, 3).map((_a) => {
      var _b = _a, { _sourceFrame } = _b, rest = __objRest(_b, ["_sourceFrame"]);
      return rest;
    });
    const finalInputStyles = sortedInputs.slice(0, 3).map((_c) => {
      var _d = _c, { _sourceFrame } = _d, rest = __objRest(_d, ["_sourceFrame"]);
      return rest;
    });
    console.log("[extractStyleTokens] Final buttons (ref=" + refFrameName + "):", JSON.stringify(finalButtonStyles));
    console.log("[extractStyleTokens] Final inputs (ref=" + refFrameName + "):", JSON.stringify(finalInputStyles));
    return {
      colors,
      cornerRadii,
      fontSizes,
      fontFamilies,
      spacings,
      paddings,
      buttonStyles: finalButtonStyles,
      inputStyles: finalInputStyles,
      rootFrameLayouts,
      referenceSnapshots
    };
  }
  var GENERATE_SNAPSHOT_MAX_CHARS = 2e5;
  var SKELETON_KEYS = /* @__PURE__ */ new Set([
    "name",
    "type",
    "width",
    "height",
    "fillColor",
    "characters",
    "fontSize",
    "fontFamily",
    "fontStyle",
    "layoutMode",
    "children",
    "cornerRadius",
    "strokeColor",
    "strokeWeight",
    "strokeTopWeight",
    "strokeRightWeight",
    "strokeBottomWeight",
    "strokeLeftWeight",
    "textAlignHorizontal",
    "textDecoration",
    "primaryAxisAlignItems",
    "counterAxisAlignItems",
    "layoutSizingHorizontal",
    "layoutSizingVertical",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "itemSpacing",
    "counterAxisSpacing",
    "opacity",
    "effects",
    "clipsContent",
    "id",
    "x",
    "y"
  ]);
  function _trimSnapshotTwoTier(snap, currentDepth, fullDetailDepth, maxDepth, maxChildren) {
    if (!snap) return snap;
    const isSkeleton = currentDepth >= fullDetailDepth;
    const copy = {};
    for (const key of Object.keys(snap)) {
      if (key === "children") {
        if (currentDepth < maxDepth && Array.isArray(snap.children)) {
          const limited = snap.children.length > maxChildren ? snap.children.slice(0, maxChildren) : snap.children;
          copy.children = limited.map(
            (c) => _trimSnapshotTwoTier(c, currentDepth + 1, fullDetailDepth, maxDepth, maxChildren)
          );
          if (snap.children.length > maxChildren) {
            copy._truncatedChildren = snap.children.length;
          }
        }
      } else if (!isSkeleton || SKELETON_KEYS.has(key)) {
        copy[key] = snap[key];
      }
    }
    return copy;
  }
  function truncateSnapshotForGenerate(snap, maxChars = GENERATE_SNAPSHOT_MAX_CHARS) {
    const configs = [
      { fullDetail: 6, maxDepth: 15, maxChildren: 40 },
      { fullDetail: 5, maxDepth: 12, maxChildren: 35 },
      { fullDetail: 4, maxDepth: 12, maxChildren: 30 },
      { fullDetail: 3, maxDepth: 10, maxChildren: 25 },
      { fullDetail: 3, maxDepth: 8, maxChildren: 20 },
      { fullDetail: 2, maxDepth: 8, maxChildren: 15 },
      { fullDetail: 2, maxDepth: 6, maxChildren: 12 },
      { fullDetail: 2, maxDepth: 5, maxChildren: 10 },
      { fullDetail: 1, maxDepth: 4, maxChildren: 8 }
    ];
    for (const cfg of configs) {
      const trimmed = _trimSnapshotTwoTier(snap, 0, cfg.fullDetail, cfg.maxDepth, cfg.maxChildren);
      const size = JSON.stringify(trimmed).length;
      if (size <= maxChars) {
        console.log(`[truncate] Snapshot fit: fullDetail=${cfg.fullDetail}, maxDepth=${cfg.maxDepth}, maxChildren=${cfg.maxChildren} (${size} chars)`);
        return trimmed;
      }
    }
    const minimal = _trimSnapshotTwoTier(snap, 0, 0, 3, 6);
    console.log(`[truncate] Snapshot forced to skeleton-only depth 3 (${JSON.stringify(minimal).length} chars)`);
    return minimal;
  }
  function snapshotNode(node, depth, siblingIndex) {
    const snap = {
      id: node.id,
      name: node.name,
      type: node.type,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
      childrenCount: "children" in node ? node.children.length : 0
    };
    if (siblingIndex !== void 0) {
      snap.siblingIndex = siblingIndex;
    }
    if ("layoutMode" in node) {
      const frame = node;
      const lm = frame.layoutMode;
      snap.layoutMode = lm === "HORIZONTAL" || lm === "VERTICAL" ? lm : "NONE";
      if ("layoutWrap" in frame && frame.layoutWrap) {
        snap.layoutWrap = frame.layoutWrap;
      }
      if (lm === "HORIZONTAL" || lm === "VERTICAL") {
        if (frame.paddingTop > 0) snap.paddingTop = frame.paddingTop;
        if (frame.paddingRight > 0) snap.paddingRight = frame.paddingRight;
        if (frame.paddingBottom > 0) snap.paddingBottom = frame.paddingBottom;
        if (frame.paddingLeft > 0) snap.paddingLeft = frame.paddingLeft;
        if (frame.itemSpacing > 0) snap.itemSpacing = frame.itemSpacing;
        if ("counterAxisSpacing" in frame) {
          const cas = frame.counterAxisSpacing;
          if (typeof cas === "number" && cas > 0) snap.counterAxisSpacing = cas;
        }
      }
      if ("layoutSizingHorizontal" in frame) {
        snap.layoutSizingHorizontal = frame.layoutSizingHorizontal;
        snap.layoutSizingVertical = frame.layoutSizingVertical;
      }
      if (lm === "HORIZONTAL" || lm === "VERTICAL") {
        snap.primaryAxisAlignItems = frame.primaryAxisAlignItems;
        snap.counterAxisAlignItems = frame.counterAxisAlignItems;
      }
    }
    if ("strokes" in node) {
      try {
        const strokes = node.strokes;
        if (Array.isArray(strokes) && strokes.length > 0) {
          const solidStroke = strokes.find((s) => s.type === "SOLID" && s.visible !== false);
          if (solidStroke) {
            const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
            snap.strokeColor = `#${toHex(solidStroke.color.r)}${toHex(solidStroke.color.g)}${toHex(solidStroke.color.b)}`.toUpperCase();
            const sw = node.strokeWeight;
            if (typeof sw === "number" && sw > 0) snap.strokeWeight = sw;
            const stw = node.strokeTopWeight;
            if (typeof stw === "number") {
              const top = stw || 0;
              const right = node.strokeRightWeight || 0;
              const bottom = node.strokeBottomWeight || 0;
              const left = node.strokeLeftWeight || 0;
              if (top !== bottom || left !== right || top !== left) {
                snap.strokeTopWeight = top;
                snap.strokeRightWeight = right;
                snap.strokeBottomWeight = bottom;
                snap.strokeLeftWeight = left;
              }
            }
          }
        }
      } catch (_e) {
      }
    }
    if (node.type === "TEXT") {
      const textNode = node;
      snap.characters = textNode.characters;
      if (typeof textNode.textStyleId === "string" && textNode.textStyleId) {
        snap.appliedTextStyleId = textNode.textStyleId;
      }
      const fs = textNode.fontSize;
      if (typeof fs === "number") snap.fontSize = fs;
      const fn = textNode.fontName;
      if (fn && typeof fn !== "symbol" && "family" in fn) {
        snap.fontFamily = fn.family;
        snap.fontStyle = fn.style;
      }
      snap.textAlignHorizontal = textNode.textAlignHorizontal;
      snap.textAlignVertical = textNode.textAlignVertical;
      snap.textAutoResize = textNode.textAutoResize;
      const ls = textNode.letterSpacing;
      if (ls && typeof ls !== "symbol" && ls.value !== 0) {
        snap.letterSpacing = ls.value;
        snap.letterSpacingUnit = ls.unit;
      }
      const lh = textNode.lineHeight;
      if (lh && typeof lh !== "symbol") {
        if (lh.unit === "AUTO") {
          snap.lineHeight = "AUTO";
          snap.lineHeightUnit = "AUTO";
        } else {
          snap.lineHeight = lh.value;
          snap.lineHeightUnit = lh.unit;
        }
      }
      const tc = textNode.textCase;
      if (typeof tc === "string" && tc !== "ORIGINAL") snap.textCase = tc;
      const td = textNode.textDecoration;
      if (typeof td === "string" && td !== "NONE") snap.textDecoration = td;
    }
    if ("fillStyleId" in node) {
      const fid = node.fillStyleId;
      if (typeof fid === "string" && fid) {
        snap.appliedFillStyleId = fid;
      }
    }
    if ("cornerRadius" in node) {
      const cr = node.cornerRadius;
      if (typeof cr === "number" && cr > 0) snap.cornerRadius = Math.round(cr);
    }
    if ("fills" in node) {
      try {
        const fills = node.fills;
        if (Array.isArray(fills) && fills.length > 0) {
          snap.fillTypes = fills.map((f) => f.type);
          const solidFill = fills.find((f) => f.type === "SOLID");
          if (solidFill) {
            const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
            snap.fillColor = `#${toHex(solidFill.color.r)}${toHex(solidFill.color.g)}${toHex(solidFill.color.b)}`.toUpperCase();
          }
        }
      } catch (_e) {
      }
    }
    if ("clipsContent" in node) {
      snap.clipsContent = node.clipsContent;
    }
    if ("opacity" in node) {
      const op = node.opacity;
      if (op < 1) snap.opacity = op;
    }
    if ("effects" in node) {
      try {
        const effects = node.effects;
        if (Array.isArray(effects) && effects.length > 0) {
          snap.effects = effects.map((e) => {
            const eff = { type: e.type, radius: e.radius };
            if (e.visible === false) eff.visible = false;
            if (e.spread != null && e.spread !== 0) eff.spread = e.spread;
            if (e.color) eff.color = { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a };
            if (e.offset) eff.offset = { x: e.offset.x, y: e.offset.y };
            if (e.blendMode && e.blendMode !== "NORMAL") eff.blendMode = e.blendMode;
            return eff;
          });
        }
      } catch (_e) {
      }
    }
    if ("children" in node && depth < MAX_SNAPSHOT_DEPTH) {
      const childNodes = node.children;
      if (childNodes.length > 0) {
        snap.children = childNodes.map((child, idx) => snapshotNode(child, depth + 1, idx));
      }
    }
    return snap;
  }
  function extractSelectionSnapshot() {
    const nodes = figma.currentPage.selection.map(
      (node) => snapshotNode(node, 0)
    );
    return { nodes };
  }
  function uint8ToBase64(bytes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      const triplet = a << 16 | b << 8 | c;
      result += chars[triplet >> 18 & 63];
      result += chars[triplet >> 12 & 63];
      result += i + 1 < bytes.length ? chars[triplet >> 6 & 63] : "=";
      result += i + 2 < bytes.length ? chars[triplet & 63] : "=";
    }
    return result;
  }
  function base64ToUint8(base64) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = new Uint8Array(128);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
    let len = base64.length;
    if (base64[len - 1] === "=") len--;
    if (base64[len - 1] === "=") len--;
    const byteLen = len * 3 >> 2;
    const bytes = new Uint8Array(byteLen);
    let p = 0;
    for (let i = 0; i < len; i += 4) {
      const a = lookup[base64.charCodeAt(i)];
      const b = lookup[base64.charCodeAt(i + 1)];
      const c = i + 2 < len ? lookup[base64.charCodeAt(i + 2)] : 0;
      const d = i + 3 < len ? lookup[base64.charCodeAt(i + 3)] : 0;
      bytes[p++] = a << 2 | b >> 4;
      if (p < byteLen) bytes[p++] = (b & 15) << 4 | c >> 2;
      if (p < byteLen) bytes[p++] = (c & 3) << 6 | d;
    }
    return bytes;
  }
  async function embedImagesInSnapshot(snap, node) {
    const isShapeNode = [
      "VECTOR",
      "BOOLEAN_OPERATION",
      "STAR",
      "POLYGON",
      "LINE",
      "ELLIPSE",
      "RECTANGLE"
    ].includes(node.type);
    const isIconGroup = node.type === "GROUP" && "children" in node && node.children.every(
      (c) => ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE", "ELLIPSE", "RECTANGLE", "GROUP"].includes(c.type)
    );
    let hasImageFill = false;
    if ("fills" in node) {
      try {
        const fills = node.fills;
        if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) {
          hasImageFill = true;
        }
      } catch (_e) {
      }
    }
    if (isShapeNode || isIconGroup || hasImageFill) {
      try {
        const bytes = await node.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: 2 }
          // 2x for crisp icons
        });
        snap.imageData = uint8ToBase64(bytes);
      } catch (_e) {
      }
      if (isShapeNode || isIconGroup) {
        snap.children = [];
        return;
      }
    }
    if (snap.children && "children" in node) {
      const childNodes = node.children;
      for (let i = 0; i < snap.children.length; i++) {
        if (i < childNodes.length) {
          await embedImagesInSnapshot(snap.children[i], childNodes[i]);
        }
      }
    }
  }
  var AUDIT_BADGE_FRAME_NAME = "A11y Audit Badges";
  function extractFillColor(node) {
    if (!("fills" in node)) return null;
    const fills = node.fills;
    if (!Array.isArray(fills)) return null;
    for (const f of fills) {
      if (f.type === "SOLID" && f.visible !== false) {
        return { r: f.color.r, g: f.color.g, b: f.color.b };
      }
    }
    return null;
  }
  function resolveBackgroundColor(node) {
    let current = node.parent;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      const col = extractFillColor(current);
      if (col) return col;
      current = current.parent;
    }
    return { r: 1, g: 1, b: 1 };
  }
  function auditLuminance(r, g, b) {
    const srgb = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  }
  function auditContrastRatio(l1, l2) {
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function isInternalTemplateName(name) {
    return name.startsWith("Template/") || name.startsWith(".Template") || name.startsWith("_");
  }
  function isDecorativeLayer(name) {
    const lower = name.toLowerCase();
    return /^(tint|overlay|shade|mask|divider|separator|spacer|background|bg|shadow|border|stroke)(\s|$|[-_ ])/i.test(lower);
  }
  function isBackgroundSimple(node) {
    let current = node.parent;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if ("fills" in current) {
        const fills = current.fills;
        if (Array.isArray(fills) && fills.length > 0) {
          const visibleFills = fills.filter((f) => f.visible !== false);
          if (visibleFills.length > 0) {
            return visibleFills.every((f) => f.type === "SOLID");
          }
        }
      }
      current = current.parent;
    }
    return true;
  }
  function isTouchTargetAutoLayout(node) {
    if ("layoutMode" in node && node.layoutMode !== "NONE") return true;
    if ("layoutSizingHorizontal" in node) {
      const h = node.layoutSizingHorizontal;
      const v = node.layoutSizingVertical;
      if (h === "HUG" || v === "HUG" || h === "FILL" || v === "FILL") return true;
    }
    if (node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE") return true;
    return false;
  }
  function computeCompliantColor(fg, bg, targetRatio) {
    const bgLum = auditLuminance(bg.r, bg.g, bg.b);
    const blackLum = auditLuminance(0, 0, 0);
    const whiteLum = auditLuminance(1, 1, 1);
    const blackRatio = auditContrastRatio(bgLum, blackLum);
    const whiteRatio = auditContrastRatio(bgLum, whiteLum);
    const target = blackRatio >= whiteRatio ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 };
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const mixed = {
        r: fg.r * (1 - mid) + target.r * mid,
        g: fg.g * (1 - mid) + target.g * mid,
        b: fg.b * (1 - mid) + target.b * mid
      };
      const mixedLum = auditLuminance(mixed.r, mixed.g, mixed.b);
      const ratio = auditContrastRatio(bgLum, mixedLum);
      if (ratio >= targetRatio) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return {
      r: fg.r * (1 - hi) + target.r * hi,
      g: fg.g * (1 - hi) + target.g * hi,
      b: fg.b * (1 - hi) + target.b * hi
    };
  }
  async function loadAllFontsForTextNode(textNode) {
    const fontName = textNode.fontName;
    if (fontName === figma.mixed) {
      const len = textNode.characters.length || 1;
      const loaded = /* @__PURE__ */ new Set();
      for (let i = 0; i < len; i++) {
        const f = textNode.getRangeFontName(i, i + 1);
        if (f !== figma.mixed) {
          const key = f.family + "::" + f.style;
          if (!loaded.has(key)) {
            loaded.add(key);
            await figma.loadFontAsync(f);
          }
        }
      }
    } else {
      await figma.loadFontAsync(fontName);
    }
  }
  function applyTouchTargetFix(node, minW, minH) {
    const extraW = Math.max(0, minW - node.width);
    const extraH = Math.max(0, minH - node.height);
    if (extraW === 0 && extraH === 0) return `Already meets ${minW}\xD7${minH}px minimum.`;
    const targetW = Math.max(node.width, minW);
    const targetH = Math.max(node.height, minH);
    if ("layoutMode" in node && node.layoutMode !== "NONE") {
      const frame = node;
      const padL = typeof frame.paddingLeft === "number" ? frame.paddingLeft : 0;
      const padR = typeof frame.paddingRight === "number" ? frame.paddingRight : 0;
      const padT = typeof frame.paddingTop === "number" ? frame.paddingTop : 0;
      const padB = typeof frame.paddingBottom === "number" ? frame.paddingBottom : 0;
      const addH = Math.ceil(extraW / 2);
      const addV = Math.ceil(extraH / 2);
      frame.paddingLeft = padL + addH;
      frame.paddingRight = padR + (extraW - addH);
      frame.paddingTop = padT + addV;
      frame.paddingBottom = padB + (extraH - addV);
      frame.primaryAxisAlignItems = "CENTER";
      frame.counterAxisAlignItems = "CENTER";
      frame.minWidth = targetW;
      frame.minHeight = targetH;
      return `Added padding to reach ${Math.round(targetW)}\xD7${Math.round(targetH)}px touch area (content centred).`;
    }
    if ("children" in node) {
      const container = node;
      container.clipsContent = true;
      container.resize(targetW, targetH);
      const children = container.children;
      for (const child of children) {
        if ("x" in child && "y" in child) {
          child.x = child.x + extraW / 2;
          child.y = child.y + extraH / 2;
        }
      }
      return `Resized to ${Math.round(targetW)}\xD7${Math.round(targetH)}px with content centred.`;
    }
    node.resize(targetW, targetH);
    return `Resized to ${Math.round(targetW)}\xD7${Math.round(targetH)}px.`;
  }
  async function applyAutoFix(finding) {
    const node = figma.getNodeById(finding.nodeId);
    if (!node) throw new Error(`Node "${finding.nodeName}" no longer exists.`);
    switch (finding.checkType) {
      case "contrast": {
        if (node.type !== "TEXT") throw new Error("Node is not a text layer.");
        const textNode = node;
        const d = finding.details;
        if (!d || !d.fgColor || !d.bgColor) throw new Error("Missing colour data for auto-fix.");
        await loadAllFontsForTextNode(textNode);
        const compliant = computeCompliantColor(d.fgColor, d.bgColor, d.threshold);
        const newFills = [{ type: "SOLID", color: { r: compliant.r, g: compliant.g, b: compliant.b } }];
        textNode.fills = newFills;
        const hex = "#" + [compliant.r, compliant.g, compliant.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
        return `Text colour changed to ${hex} for ${d.threshold}:1 contrast.`;
      }
      case "font-size": {
        if (node.type !== "TEXT") throw new Error("Node is not a text layer.");
        const textNode = node;
        await loadAllFontsForTextNode(textNode);
        textNode.fontSize = 12;
        return "Font size increased to 12px.";
      }
      case "touch-target": {
        if (!("resize" in node)) throw new Error("Node cannot be resized.");
        return applyTouchTargetFix(node, 44, 44);
      }
      case "low-opacity": {
        if (!("opacity" in node)) throw new Error("Node has no opacity property.");
        node.opacity = 1;
        return "Opacity set to 100%.";
      }
      default:
        throw new Error(`No auto-fix available for "${finding.checkType}".`);
    }
  }
  async function applyLLMFix(finding) {
    const fixBody = {
      finding: {
        nodeId: finding.nodeId,
        nodeName: finding.nodeName,
        checkType: finding.checkType,
        message: finding.message,
        details: finding.details,
        suggestion: finding.suggestion
      },
      apiKey: _userApiKey,
      provider: _selectedProvider,
      model: _selectedModel
    };
    const result = await fetchViaUI("/audit-fix", fixBody);
    if (!result) throw new Error("No response from server. Check your API key and network.");
    if (result.error) throw new Error(`Server error: ${result.error}`);
    if (!result.fix) throw new Error("LLM did not return a valid fix structure.");
    const node = figma.getNodeById(finding.nodeId);
    if (!node) throw new Error(`Node "${finding.nodeName}" no longer exists.`);
    const fix = result.fix;
    switch (fix.property) {
      case "fill-color": {
        if (node.type !== "TEXT") throw new Error("Node is not a text layer.");
        const textNode = node;
        await loadAllFontsForTextNode(textNode);
        const hex = fix.value.replace("#", "");
        if (hex.length < 6) throw new Error(`Invalid colour value: "${fix.value}".`);
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        textNode.fills = [{ type: "SOLID", color: { r, g, b } }];
        return fix.explanation || `Text colour changed to #${hex}.`;
      }
      case "font-size": {
        if (node.type !== "TEXT") throw new Error("Node is not a text layer.");
        const textNode = node;
        await loadAllFontsForTextNode(textNode);
        textNode.fontSize = Number(fix.value) || 12;
        return fix.explanation || `Font size set to ${fix.value}px.`;
      }
      case "resize": {
        if (!("resize" in node)) throw new Error("Node cannot be resized.");
        const w = Number(fix.width) || 44;
        const h = Number(fix.height) || 44;
        return applyTouchTargetFix(node, w, h);
      }
      case "opacity": {
        if (!("opacity" in node)) throw new Error("Node has no opacity property.");
        node.opacity = Number(fix.value) || 1;
        return fix.explanation || `Opacity set to ${fix.value}.`;
      }
      default:
        throw new Error(`Unknown fix property "${fix.property}".`);
    }
  }
  function runAccessibilityAudit(nodes) {
    const findings = [];
    function walk(node, insideInstance = false) {
      if (node.name === AUDIT_BADGE_FRAME_NAME || node.name === CHANGE_LOG_FRAME_NAME) return;
      if ("visible" in node && node.visible === false) return;
      if (isInternalTemplateName(node.name)) return;
      if (node.type === "TEXT" && !insideInstance) {
        const textNode = node;
        const fg = extractFillColor(textNode);
        if (fg) {
          const bg = resolveBackgroundColor(textNode);
          const fgLum = auditLuminance(fg.r, fg.g, fg.b);
          const bgLum = auditLuminance(bg.r, bg.g, bg.b);
          const ratio = auditContrastRatio(fgLum, bgLum);
          const fontSize2 = typeof textNode.fontSize === "number" ? textNode.fontSize : 16;
          const isLargeText = fontSize2 >= 18 || fontSize2 >= 14 && textNode.fontWeight >= 700;
          const threshold = isLargeText ? 3 : 4.5;
          if (ratio < threshold) {
            const fgHex = "#" + [fg.r, fg.g, fg.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
            const bgHex = "#" + [bg.r, bg.g, bg.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
            const bgSimple = isBackgroundSimple(textNode);
            findings.push({
              nodeId: node.id,
              nodeName: node.name,
              severity: ratio < 3 ? "error" : "warning",
              checkType: "contrast",
              message: `Low contrast ratio ${ratio.toFixed(2)}:1 (needs ${threshold}:1). Text "${(textNode.characters || "").slice(0, 30)}" (${fgHex}) on background (${bgHex}).`,
              fixType: bgSimple ? "auto" : "llm",
              details: { fgColor: fg, bgColor: bg, ratio, threshold, fgHex, bgHex, bgSimple }
            });
          }
        }
        const fontSize = typeof textNode.fontSize === "number" ? textNode.fontSize : 0;
        if (fontSize > 0 && fontSize < 12) {
          findings.push({
            nodeId: node.id,
            nodeName: node.name,
            severity: "warning",
            checkType: "font-size",
            message: `Font size ${fontSize}px is below 12px minimum for readability.`,
            fixType: "auto",
            details: { currentSize: fontSize }
          });
        }
        if (!textNode.characters || textNode.characters.trim() === "") {
          findings.push({
            nodeId: node.id,
            nodeName: node.name,
            severity: "warning",
            checkType: "empty-text",
            message: `Text node "${node.name}" has no visible content. Check if a label is missing.`,
            fixType: "manual"
          });
        }
      }
      if (!insideInstance && (node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT")) {
        const nameLower = node.name.toLowerCase();
        const isInteractive = /button|btn|link|tab|toggle|switch|checkbox|radio|input|search|icon[-_ ]?btn|cta/i.test(nameLower);
        if (isInteractive && (node.width < 44 || node.height < 44)) {
          const isAL = isTouchTargetAutoLayout(node);
          findings.push({
            nodeId: node.id,
            nodeName: node.name,
            severity: "warning",
            checkType: "touch-target",
            message: `Touch target "${node.name}" is ${Math.round(node.width)}\xD7${Math.round(node.height)}px \u2014 minimum 44\xD744px recommended (WCAG 2.5.5).`,
            fixType: isAL ? "llm" : "auto",
            details: { currentWidth: Math.round(node.width), currentHeight: Math.round(node.height), isAutoLayout: isAL }
          });
        }
      }
      if ("opacity" in node && typeof node.opacity === "number" && !insideInstance) {
        const opacity = node.opacity;
        if (opacity > 0 && opacity < 0.4 && !isDecorativeLayer(node.name)) {
          findings.push({
            nodeId: node.id,
            nodeName: node.name,
            severity: "warning",
            checkType: "low-opacity",
            message: `Node "${node.name}" has opacity ${(opacity * 100).toFixed(0)}% which may be hard to perceive.`,
            fixType: "auto",
            details: { currentOpacity: opacity }
          });
        }
      }
      if ("children" in node) {
        const nowInsideInstance = insideInstance || node.type === "INSTANCE";
        for (const child of node.children) {
          walk(child, nowInsideInstance);
        }
      }
    }
    for (const node of nodes) {
      walk(node);
    }
    const seen = /* @__PURE__ */ new Set();
    const deduped = [];
    for (const f of findings) {
      const key = `${f.nodeId}||${f.checkType}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(f);
      }
    }
    return deduped;
  }
  function createAuditBadges(findings) {
    clearAuditBadges();
    if (findings.length === 0) return;
    const capped = findings.slice(0, 30);
    for (const finding of capped) {
      try {
        const targetNode = figma.getNodeById(finding.nodeId);
        if (!targetNode) continue;
        const abs = targetNode.absoluteTransform;
        const nodeX = abs[0][2];
        const nodeY = abs[1][2];
        const badge = figma.createFrame();
        badge.name = `a11y-badge: ${finding.nodeName}`;
        badge.resize(20, 20);
        badge.cornerRadius = 10;
        badge.fills = [
          {
            type: "SOLID",
            color: finding.severity === "error" ? { r: 0.84, g: 0.19, b: 0.19 } : { r: 0.95, g: 0.61, b: 0.07 }
            // orange
          }
        ];
        badge.x = nodeX + targetNode.width - 10;
        badge.y = nodeY - 10;
        const iconText = figma.createText();
        figma.loadFontAsync({ family: "Inter", style: "Bold" }).then(() => {
          iconText.characters = "!";
          iconText.fontSize = 12;
          iconText.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
          iconText.textAlignHorizontal = "CENTER";
          iconText.textAlignVertical = "CENTER";
          iconText.resize(20, 20);
          badge.appendChild(iconText);
        });
        figma.currentPage.appendChild(badge);
      } catch (e) {
        console.warn("[a11y] Badge creation failed for", finding.nodeId, e);
      }
    }
  }
  function clearAuditBadges() {
    const badges = figma.currentPage.findAll(
      (n) => n.name === AUDIT_BADGE_FRAME_NAME || n.name.startsWith("a11y-badge:")
    );
    for (const b of badges) {
      b.remove();
    }
  }
  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return {
      r: parseInt(h.substring(0, 2), 16) / 255,
      g: parseInt(h.substring(2, 4), 16) / 255,
      b: parseInt(h.substring(4, 6), 16) / 255
    };
  }
  var _importStats = { texts: 0, frames: 0, images: 0, failed: 0, errors: [] };
  var _lightStyleMap = null;
  var _darkStyleMap = null;
  var _unscopedStyleMap = null;
  var _textStyleMap = null;
  var _currentThemeMode = "auto";
  function ensurePaintStyleMaps() {
    if (_lightStyleMap) return;
    _lightStyleMap = /* @__PURE__ */ new Map();
    _darkStyleMap = /* @__PURE__ */ new Map();
    _unscopedStyleMap = /* @__PURE__ */ new Map();
    try {
      for (const s of figma.getLocalPaintStyles()) {
        const paints = s.paints;
        if (!Array.isArray(paints)) continue;
        const solid = paints.find((p) => p.type === "SOLID" && p.visible !== false);
        if (solid) {
          const hex = `#${[solid.color.r, solid.color.g, solid.color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
          const nameLower = s.name.toLowerCase();
          if (nameLower.startsWith("light/") || nameLower.startsWith("light ")) {
            if (!_lightStyleMap.has(hex)) _lightStyleMap.set(hex, s.id);
          } else if (nameLower.startsWith("dark/") || nameLower.startsWith("dark ")) {
            if (!_darkStyleMap.has(hex)) _darkStyleMap.set(hex, s.id);
          } else {
            if (!_unscopedStyleMap.has(hex)) _unscopedStyleMap.set(hex, s.id);
          }
        }
      }
      console.log(`[styleBinding] Paint style maps: light=${_lightStyleMap.size}, dark=${_darkStyleMap.size}, unscoped=${_unscopedStyleMap.size}`);
    } catch (e) {
      console.warn("[styleBinding] Failed to build paint style maps:", e);
    }
  }
  function ensureTextStyleMap() {
    if (_textStyleMap) return _textStyleMap;
    _textStyleMap = /* @__PURE__ */ new Map();
    try {
      for (const s of figma.getLocalTextStyles()) {
        const fn = s.fontName;
        if (!fn) continue;
        const size = typeof s.fontSize === "number" ? s.fontSize : 0;
        const key = `${fn.family}|${fn.style}|${size}`.toLowerCase();
        if (!_textStyleMap.has(key)) {
          _textStyleMap.set(key, s.id);
        }
      }
      console.log(`[styleBinding] Built text style map: ${_textStyleMap.size} entries`);
    } catch (e) {
      console.warn("[styleBinding] Failed to build text style map:", e);
    }
    return _textStyleMap;
  }
  function tryBindFillStyle(node, hex) {
    try {
      ensurePaintStyleMaps();
      const normalized = hex.toUpperCase();
      let styleId;
      if (_currentThemeMode === "dark") {
        styleId = _darkStyleMap.get(normalized) || _unscopedStyleMap.get(normalized) || _lightStyleMap.get(normalized);
      } else if (_currentThemeMode === "light") {
        styleId = _lightStyleMap.get(normalized) || _unscopedStyleMap.get(normalized) || _darkStyleMap.get(normalized);
      } else {
        styleId = _unscopedStyleMap.get(normalized) || _lightStyleMap.get(normalized) || _darkStyleMap.get(normalized);
      }
      if (styleId && "fillStyleId" in node) {
        node.fillStyleId = styleId;
      }
    } catch (_) {
    }
  }
  function tryBindTextStyle(node, fontFamily, fontStyle, fontSize) {
    try {
      const map = ensureTextStyleMap();
      const key = `${fontFamily}|${fontStyle}|${fontSize}`.toLowerCase();
      const styleId = map.get(key);
      if (styleId) {
        node.textStyleId = styleId;
      }
    } catch (_) {
    }
  }
  function detectThemeMode(text) {
    const lower = text.toLowerCase();
    if (/\bdark\b/.test(lower)) return "dark";
    if (/\blight\b/.test(lower)) return "light";
    return "auto";
  }
  var _paintStyleNameMap = null;
  var _textStyleNameMap = null;
  function ensurePaintStyleNameMap() {
    if (_paintStyleNameMap) return _paintStyleNameMap;
    _paintStyleNameMap = /* @__PURE__ */ new Map();
    try {
      for (const s of figma.getLocalPaintStyles()) {
        const key = s.name.toLowerCase().trim();
        if (!_paintStyleNameMap.has(key)) {
          _paintStyleNameMap.set(key, s.id);
        }
      }
      console.log(`[styleBinding] Paint style name map: ${_paintStyleNameMap.size} entries`);
    } catch (e) {
      console.warn("[styleBinding] Failed to build paint style name map:", e);
    }
    return _paintStyleNameMap;
  }
  function ensureTextStyleNameMap() {
    if (_textStyleNameMap) return _textStyleNameMap;
    _textStyleNameMap = /* @__PURE__ */ new Map();
    try {
      for (const s of figma.getLocalTextStyles()) {
        const key = s.name.toLowerCase().trim();
        if (!_textStyleNameMap.has(key)) {
          _textStyleNameMap.set(key, s.id);
        }
      }
      console.log(`[styleBinding] Text style name map: ${_textStyleNameMap.size} entries`);
    } catch (e) {
      console.warn("[styleBinding] Failed to build text style name map:", e);
    }
    return _textStyleNameMap;
  }
  function tryBindFillStyleByName(node, styleName) {
    try {
      const map = ensurePaintStyleNameMap();
      const styleId = map.get(styleName.toLowerCase().trim());
      if (styleId && "fillStyleId" in node) {
        node.fillStyleId = styleId;
        return true;
      }
    } catch (_) {
    }
    return false;
  }
  function tryBindTextStyleByName(node, styleName) {
    try {
      const map = ensureTextStyleNameMap();
      const key = styleName.toLowerCase().trim();
      let styleId = map.get(key);
      if (!styleId) {
        const normalize = (s) => s.replace(/[-_ ]/g, "");
        const normalizedKey = normalize(key);
        for (const [mapKey, mapVal] of map.entries()) {
          if (normalize(mapKey) === normalizedKey) {
            styleId = mapVal;
            console.log(`[styleBinding] Text style fuzzy-matched: "${styleName}" -> "${mapKey}"`);
            break;
          }
        }
      }
      if (styleId) {
        node.textStyleId = styleId;
        console.log(`[styleBinding] Text style bound: "${styleName}"`);
        return true;
      } else {
        console.warn(`[styleBinding] Text style NOT FOUND: "${styleName}" (${map.size} styles available)`);
      }
    } catch (_) {
    }
    return false;
  }
  function clearStyleMaps() {
    _lightStyleMap = null;
    _darkStyleMap = null;
    _unscopedStyleMap = null;
    _textStyleMap = null;
    _paintStyleNameMap = null;
    _textStyleNameMap = null;
    _currentThemeMode = "auto";
  }
  async function createNodeFromSnapshot(snap, parent) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C;
    let node;
    const parentIsAutoLayout = "layoutMode" in parent && (parent.layoutMode === "HORIZONTAL" || parent.layoutMode === "VERTICAL");
    if (snap.type === "TEXT") {
      const textNode = figma.createText();
      let loadedFamily = "Inter";
      let loadedStyle = "Regular";
      let fontReady = false;
      const wantFamily = snap.fontFamily || "Inter";
      const wantStyle = snap.fontStyle || "Regular";
      try {
        await figma.loadFontAsync({ family: wantFamily, style: wantStyle });
        loadedFamily = wantFamily;
        loadedStyle = wantStyle;
        fontReady = true;
      } catch (_) {
      }
      if (!fontReady && wantStyle !== "Regular") {
        try {
          await figma.loadFontAsync({ family: wantFamily, style: "Regular" });
          loadedFamily = wantFamily;
          loadedStyle = "Regular";
          fontReady = true;
        } catch (_) {
        }
      }
      if (!fontReady) {
        try {
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          fontReady = true;
        } catch (_) {
        }
      }
      try {
        textNode.fontName = { family: loadedFamily, style: loadedStyle };
      } catch (_) {
      }
      try {
        if (snap.fontSize && typeof snap.fontSize === "number") textNode.fontSize = snap.fontSize;
      } catch (_) {
      }
      try {
        if (snap.textAlignHorizontal) textNode.textAlignHorizontal = snap.textAlignHorizontal;
      } catch (_) {
      }
      try {
        if (snap.textAlignVertical) textNode.textAlignVertical = snap.textAlignVertical;
      } catch (_) {
      }
      try {
        if (snap.textAutoResize) textNode.textAutoResize = snap.textAutoResize;
      } catch (_) {
      }
      try {
        if (snap.letterSpacing != null) textNode.letterSpacing = { value: snap.letterSpacing, unit: snap.letterSpacingUnit || "PIXELS" };
      } catch (_) {
      }
      try {
        if (snap.lineHeight != null) {
          if (snap.lineHeight === "AUTO" || snap.lineHeightUnit === "AUTO") {
            textNode.lineHeight = { unit: "AUTO" };
          } else {
            textNode.lineHeight = { value: Number(snap.lineHeight), unit: snap.lineHeightUnit || "PIXELS" };
          }
        }
      } catch (_) {
      }
      try {
        if (snap.textCase) textNode.textCase = snap.textCase;
      } catch (_) {
      }
      try {
        if (snap.textDecoration) textNode.textDecoration = snap.textDecoration;
      } catch (_) {
      }
      try {
        textNode.characters = snap.characters || "";
      } catch (charErr) {
        try {
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          textNode.fontName = { family: "Inter", style: "Regular" };
          textNode.characters = snap.characters || "";
        } catch (_) {
        }
      }
      try {
        if (snap.fillStyleName) {
          if (snap.fillColor) textNode.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
          tryBindFillStyleByName(textNode, snap.fillStyleName);
        } else if (snap.fillColor) {
          textNode.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
          tryBindFillStyle(textNode, snap.fillColor);
        }
      } catch (_) {
      }
      try {
        if (snap.textStyleName) {
          tryBindTextStyleByName(textNode, snap.textStyleName);
        } else {
          console.warn(`[styleBinding] TEXT node "${snap.characters || snap.name}" has NO textStyleName in snapshot`);
          const fn = textNode.fontName;
          if (fn && fn.family && fn.style) {
            tryBindTextStyle(textNode, fn.family, fn.style, textNode.fontSize);
          }
        }
      } catch (_) {
      }
      node = textNode;
      _importStats.texts++;
    } else if (snap.type === "ELLIPSE") {
      const ellipse = figma.createEllipse();
      ellipse.resize((_a = snap.width) != null ? _a : 100, (_b = snap.height) != null ? _b : 100);
      if (snap.imageData) {
        try {
          const bytes = base64ToUint8(snap.imageData);
          const img = figma.createImage(bytes);
          ellipse.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
          _importStats.images++;
        } catch (_e2) {
          if (snap.fillColor) {
            ellipse.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
            tryBindFillStyle(ellipse, snap.fillColor);
          } else ellipse.fills = [];
        }
      } else if (snap.fillStyleName) {
        ellipse.fills = snap.fillColor ? [{ type: "SOLID", color: hexToRgb(snap.fillColor) }] : [];
        tryBindFillStyleByName(ellipse, snap.fillStyleName);
      } else if (snap.fillColor) {
        ellipse.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        tryBindFillStyle(ellipse, snap.fillColor);
      } else {
        ellipse.fills = [];
      }
      node = ellipse;
      _importStats.frames++;
    } else if (snap.type === "RECTANGLE") {
      const rect = figma.createRectangle();
      rect.resize((_c = snap.width) != null ? _c : 100, (_d = snap.height) != null ? _d : 100);
      if (snap.cornerRadius != null && snap.cornerRadius > 0) rect.cornerRadius = snap.cornerRadius;
      if (snap.imageData) {
        try {
          const bytes = base64ToUint8(snap.imageData);
          const img = figma.createImage(bytes);
          rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
          _importStats.images++;
        } catch (_e2) {
          if (snap.fillColor) {
            rect.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
            tryBindFillStyle(rect, snap.fillColor);
          } else rect.fills = [];
        }
      } else if (snap.fillStyleName) {
        rect.fills = snap.fillColor ? [{ type: "SOLID", color: hexToRgb(snap.fillColor) }] : [];
        tryBindFillStyleByName(rect, snap.fillStyleName);
      } else if (snap.fillColor) {
        rect.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        tryBindFillStyle(rect, snap.fillColor);
      } else {
        rect.fills = [];
      }
      node = rect;
      _importStats.frames++;
    } else if (snap.imageData && (!snap.children || snap.children.length === 0)) {
      const frame = figma.createFrame();
      frame.resize((_e = snap.width) != null ? _e : 100, (_f = snap.height) != null ? _f : 100);
      frame.fills = [];
      try {
        const bytes = base64ToUint8(snap.imageData);
        const img = figma.createImage(bytes);
        frame.fills = [{ type: "IMAGE", scaleMode: "FIT", imageHash: img.hash }];
        _importStats.images++;
      } catch (_e2) {
        if (snap.fillColor) {
          frame.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
          tryBindFillStyle(frame, snap.fillColor);
        }
      }
      if (snap.cornerRadius != null && snap.cornerRadius > 0) frame.cornerRadius = snap.cornerRadius;
      if (snap.clipsContent != null) frame.clipsContent = snap.clipsContent;
      node = frame;
      _importStats.frames++;
    } else if (snap.type === "COMPONENT") {
      const comp = figma.createComponent();
      comp.resize((_g = snap.width) != null ? _g : 100, (_h = snap.height) != null ? _h : 100);
      if (snap.layoutMode === "HORIZONTAL" || snap.layoutMode === "VERTICAL") {
        comp.layoutMode = snap.layoutMode;
        if (snap.paddingTop != null) comp.paddingTop = snap.paddingTop;
        if (snap.paddingRight != null) comp.paddingRight = snap.paddingRight;
        if (snap.paddingBottom != null) comp.paddingBottom = snap.paddingBottom;
        if (snap.paddingLeft != null) comp.paddingLeft = snap.paddingLeft;
        if (snap.itemSpacing != null) comp.itemSpacing = snap.itemSpacing;
        if (snap.counterAxisSpacing != null) comp.counterAxisSpacing = snap.counterAxisSpacing;
        const validPrimary = ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"];
        const validCounter = ["MIN", "CENTER", "MAX", "BASELINE"];
        if (snap.primaryAxisAlignItems && validPrimary.indexOf(snap.primaryAxisAlignItems) !== -1) {
          comp.primaryAxisAlignItems = snap.primaryAxisAlignItems;
        }
        if (snap.counterAxisAlignItems && validCounter.indexOf(snap.counterAxisAlignItems) !== -1) {
          comp.counterAxisAlignItems = snap.counterAxisAlignItems;
        }
        if (snap.layoutWrap === "WRAP") comp.layoutWrap = "WRAP";
        if (snap.layoutSizingVertical === "FIXED" || snap.layoutSizingHorizontal === "FIXED") {
          try {
            if (snap.layoutMode === "VERTICAL") {
              if (snap.layoutSizingVertical === "FIXED") comp.primaryAxisSizingMode = "FIXED";
              if (snap.layoutSizingHorizontal === "FIXED") comp.counterAxisSizingMode = "FIXED";
            } else {
              if (snap.layoutSizingHorizontal === "FIXED") comp.primaryAxisSizingMode = "FIXED";
              if (snap.layoutSizingVertical === "FIXED") comp.counterAxisSizingMode = "FIXED";
            }
            comp.resize((_i = snap.width) != null ? _i : 100, (_j = snap.height) != null ? _j : 100);
          } catch (_) {
          }
        }
      }
      if (snap.cornerRadius != null && snap.cornerRadius > 0) comp.cornerRadius = snap.cornerRadius;
      if (snap.clipsContent != null) comp.clipsContent = snap.clipsContent;
      if (snap.strokeColor) {
        try {
          comp.strokes = [{ type: "SOLID", color: hexToRgb(snap.strokeColor) }];
          comp.strokeWeight = (_k = snap.strokeWeight) != null ? _k : 1;
          comp.strokeAlign = "INSIDE";
          if (snap.strokeBottomWeight != null) {
            comp.strokeTopWeight = (_l = snap.strokeTopWeight) != null ? _l : 0;
            comp.strokeRightWeight = (_m = snap.strokeRightWeight) != null ? _m : 0;
            comp.strokeBottomWeight = snap.strokeBottomWeight;
            comp.strokeLeftWeight = (_n = snap.strokeLeftWeight) != null ? _n : 0;
          }
        } catch (_) {
        }
      }
      if (snap.fillStyleName) {
        comp.fills = snap.fillColor ? [{ type: "SOLID", color: hexToRgb(snap.fillColor) }] : [];
        tryBindFillStyleByName(comp, snap.fillStyleName);
      } else if (snap.fillColor) {
        comp.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        tryBindFillStyle(comp, snap.fillColor);
      } else {
        comp.fills = [];
      }
      if (snap.children && snap.children.length > 0) {
        for (const childSnap of snap.children) {
          try {
            await createNodeFromSnapshot(childSnap, comp);
          } catch (childErr) {
            _importStats.failed++;
            _importStats.errors.push(`"${childSnap.name}": ${childErr.message}`);
          }
        }
      }
      node = comp;
      _importStats.frames++;
    } else if (snap.type === "COMPONENT_SET") {
      console.log(`[createNodeFromSnapshot] COMPONENT_SET "${snap.name}" \u2014 ${((_o = snap.children) == null ? void 0 : _o.length) || 0} children`);
      const components = [];
      if (snap.children && snap.children.length > 0) {
        for (let ci = 0; ci < snap.children.length; ci++) {
          const childSnap = snap.children[ci];
          try {
            childSnap.type = "COMPONENT";
            if (childSnap.name && childSnap.name.indexOf("=") === -1) {
              childSnap.name = `Property 1=${childSnap.name}`;
            } else if (!childSnap.name) {
              childSnap.name = `Property 1=Variant ${ci + 1}`;
            }
            const childNode = await createNodeFromSnapshot(childSnap, parent);
            if (childNode && childNode.type === "COMPONENT") {
              components.push(childNode);
              console.log(`[createNodeFromSnapshot] COMPONENT_SET child ${ci}: "${childNode.name}" (${childNode.width}x${childNode.height}, ${((_p = childNode.children) == null ? void 0 : _p.length) || 0} inner children)`);
            } else {
              console.warn(`[createNodeFromSnapshot] COMPONENT_SET child ${ci} was not a COMPONENT:`, childNode == null ? void 0 : childNode.type);
            }
          } catch (childErr) {
            _importStats.failed++;
            _importStats.errors.push(`"${childSnap.name}": ${childErr.message}`);
            console.error(`[createNodeFromSnapshot] COMPONENT_SET child ${ci} error:`, childErr.message);
          }
        }
      }
      if (components.length >= 2) {
        try {
          const componentSet = figma.combineAsVariants(components, parent);
          componentSet.name = snap.name || "Component Set";
          console.log(`[createNodeFromSnapshot] combineAsVariants succeeded: "${componentSet.name}" (${componentSet.children.length} variants)`);
          componentSet.layoutMode = snap.layoutMode === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
          componentSet.primaryAxisSizingMode = "AUTO";
          componentSet.counterAxisSizingMode = "AUTO";
          componentSet.itemSpacing = (_q = snap.itemSpacing) != null ? _q : 16;
          componentSet.paddingTop = (_r = snap.paddingTop) != null ? _r : 40;
          componentSet.paddingRight = (_s = snap.paddingRight) != null ? _s : 40;
          componentSet.paddingBottom = (_t = snap.paddingBottom) != null ? _t : 40;
          componentSet.paddingLeft = (_u = snap.paddingLeft) != null ? _u : 40;
          componentSet.fills = [];
          _importStats.frames++;
          return componentSet;
        } catch (combineErr) {
          console.error(`[createNodeFromSnapshot] combineAsVariants FAILED:`, combineErr.message);
          for (const orphan of components) {
            try {
              orphan.remove();
            } catch (_) {
            }
          }
          return null;
        }
      } else if (components.length === 1) {
        console.warn("[createNodeFromSnapshot] COMPONENT_SET had only 1 child, returning as standalone component");
        _importStats.frames++;
        return components[0];
      } else {
        console.warn("[createNodeFromSnapshot] COMPONENT_SET had no valid children");
        return null;
      }
    } else {
      const frame = figma.createFrame();
      frame.resize(
        (_v = snap.width) != null ? _v : 100,
        (_w = snap.height) != null ? _w : 100
      );
      if (snap.layoutMode === "HORIZONTAL" || snap.layoutMode === "VERTICAL") {
        frame.layoutMode = snap.layoutMode;
        if (snap.paddingTop != null) frame.paddingTop = snap.paddingTop;
        if (snap.paddingRight != null) frame.paddingRight = snap.paddingRight;
        if (snap.paddingBottom != null) frame.paddingBottom = snap.paddingBottom;
        if (snap.paddingLeft != null) frame.paddingLeft = snap.paddingLeft;
        if (snap.itemSpacing != null) frame.itemSpacing = snap.itemSpacing;
        if (snap.counterAxisSpacing != null) {
          frame.counterAxisSpacing = snap.counterAxisSpacing;
        }
        const validPrimary = ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"];
        const validCounter = ["MIN", "CENTER", "MAX", "BASELINE"];
        if (snap.primaryAxisAlignItems && validPrimary.indexOf(snap.primaryAxisAlignItems) !== -1) {
          frame.primaryAxisAlignItems = snap.primaryAxisAlignItems;
        }
        if (snap.counterAxisAlignItems && validCounter.indexOf(snap.counterAxisAlignItems) !== -1) {
          frame.counterAxisAlignItems = snap.counterAxisAlignItems;
        }
        if (snap.layoutWrap === "WRAP") {
          frame.layoutWrap = "WRAP";
        }
        if (snap.layoutSizingVertical === "FIXED" || snap.layoutSizingHorizontal === "FIXED") {
          try {
            if (snap.layoutMode === "VERTICAL") {
              if (snap.layoutSizingVertical === "FIXED") frame.primaryAxisSizingMode = "FIXED";
              if (snap.layoutSizingHorizontal === "FIXED") frame.counterAxisSizingMode = "FIXED";
            } else {
              if (snap.layoutSizingHorizontal === "FIXED") frame.primaryAxisSizingMode = "FIXED";
              if (snap.layoutSizingVertical === "FIXED") frame.counterAxisSizingMode = "FIXED";
            }
            frame.resize((_x = snap.width) != null ? _x : 100, (_y = snap.height) != null ? _y : 100);
          } catch (_) {
          }
        }
      }
      if (snap.cornerRadius != null && snap.cornerRadius > 0) {
        frame.cornerRadius = snap.cornerRadius;
      }
      if (snap.clipsContent != null) {
        frame.clipsContent = snap.clipsContent;
      }
      if (snap.strokeColor) {
        try {
          frame.strokes = [{ type: "SOLID", color: hexToRgb(snap.strokeColor) }];
          frame.strokeWeight = (_z = snap.strokeWeight) != null ? _z : 1;
          frame.strokeAlign = "INSIDE";
          if (snap.strokeBottomWeight != null) {
            frame.strokeTopWeight = (_A = snap.strokeTopWeight) != null ? _A : 0;
            frame.strokeRightWeight = (_B = snap.strokeRightWeight) != null ? _B : 0;
            frame.strokeBottomWeight = snap.strokeBottomWeight;
            frame.strokeLeftWeight = (_C = snap.strokeLeftWeight) != null ? _C : 0;
          }
        } catch (_) {
        }
      }
      if (snap.imageData) {
        try {
          const bytes = base64ToUint8(snap.imageData);
          const img = figma.createImage(bytes);
          frame.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
          _importStats.images++;
        } catch (_e2) {
          if (snap.fillColor) {
            frame.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
            tryBindFillStyle(frame, snap.fillColor);
          } else {
            frame.fills = [];
          }
        }
      } else if (snap.fillStyleName) {
        frame.fills = snap.fillColor ? [{ type: "SOLID", color: hexToRgb(snap.fillColor) }] : [];
        tryBindFillStyleByName(frame, snap.fillStyleName);
      } else if (snap.fillColor) {
        frame.fills = [{ type: "SOLID", color: hexToRgb(snap.fillColor) }];
        tryBindFillStyle(frame, snap.fillColor);
      } else {
        frame.fills = [];
      }
      if (snap.children && snap.children.length > 0) {
        for (const childSnap of snap.children) {
          try {
            await createNodeFromSnapshot(childSnap, frame);
          } catch (childErr) {
            _importStats.failed++;
            _importStats.errors.push(`"${childSnap.name}": ${childErr.message}`);
          }
        }
      }
      node = frame;
      _importStats.frames++;
    }
    node.name = snap.name || "Imported Node";
    if (snap.opacity != null && snap.opacity < 1) node.opacity = snap.opacity;
    if (snap.effects && snap.effects.length > 0 && "effects" in node) {
      try {
        node.effects = snap.effects.map((e) => {
          const eff = {
            type: e.type,
            radius: e.radius,
            visible: e.visible !== false
            // default true
          };
          if (e.color) eff.color = { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a };
          if (e.offset) eff.offset = { x: e.offset.x, y: e.offset.y };
          if (e.spread != null) eff.spread = e.spread;
          eff.blendMode = e.blendMode || "NORMAL";
          return eff;
        });
      } catch (_e2) {
      }
    }
    parent.appendChild(node);
    if (!parentIsAutoLayout) {
      if (snap.x != null) node.x = snap.x;
      if (snap.y != null) node.y = snap.y;
    }
    if (parentIsAutoLayout) {
      const sizing = snap.layoutSizingHorizontal;
      const sizingV = snap.layoutSizingVertical;
      if (sizing) {
        try {
          node.layoutSizingHorizontal = sizing;
        } catch (_e2) {
        }
      }
      if (sizingV) {
        try {
          node.layoutSizingVertical = sizingV;
        } catch (_e2) {
        }
      }
    }
    if (!parentIsAutoLayout && "primaryAxisSizingMode" in node) {
      const sizingV = snap.layoutSizingVertical;
      const sizingH = snap.layoutSizingHorizontal;
      const mode = snap.layoutMode;
      try {
        if (mode === "VERTICAL") {
          if (sizingV === "FIXED") node.primaryAxisSizingMode = "FIXED";
          if (sizingH === "FIXED") node.counterAxisSizingMode = "FIXED";
        } else if (mode === "HORIZONTAL") {
          if (sizingH === "FIXED") node.primaryAxisSizingMode = "FIXED";
          if (sizingV === "FIXED") node.counterAxisSizingMode = "FIXED";
        }
      } catch (_) {
      }
    }
    if (snap.type === "TEXT" && snap.width && snap.height) {
      try {
        node.resize(snap.width, snap.height);
      } catch (_) {
      }
    }
    return node;
  }
  async function extractDesignSystemSnapshot() {
    if (_designSystemCache && Date.now() - _designSystemCache.ts < CACHE_TTL_MS) {
      console.log("[extractDesignSystemSnapshot] Using cached result (age: " + Math.round((Date.now() - _designSystemCache.ts) / 1e3) + "s)");
      return _designSystemCache.data;
    }
    const textStyles = figma.getLocalTextStyles().map((s) => {
      const entry = {
        id: s.id,
        name: s.name
      };
      if (s.fontName && typeof s.fontName !== "symbol") {
        entry.fontFamily = s.fontName.family;
        entry.fontStyle = s.fontName.style;
      }
      if (typeof s.fontSize === "number") entry.fontSize = s.fontSize;
      if (s.lineHeight && typeof s.lineHeight !== "symbol") {
        const lh = s.lineHeight;
        if (lh.unit === "AUTO") entry.lineHeight = "AUTO";
        else if (lh.value) entry.lineHeight = lh.value;
      }
      if (typeof s.letterSpacing !== "symbol" && s.letterSpacing) {
        const ls = s.letterSpacing;
        if (ls.value) entry.letterSpacing = ls.value;
      }
      return entry;
    });
    const fillStyles = figma.getLocalPaintStyles().map((s) => {
      const entry = { id: s.id, name: s.name };
      try {
        const paints = s.paints;
        if (Array.isArray(paints)) {
          const solid = paints.find((p) => p.type === "SOLID" && p.visible !== false);
          if (solid) {
            const toH = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
            entry.hex = `#${toH(solid.color.r)}${toH(solid.color.g)}${toH(solid.color.b)}`.toUpperCase();
            if (typeof solid.opacity === "number" && solid.opacity < 1) {
              entry.opacity = Math.round(solid.opacity * 100);
            }
          }
        }
      } catch (_) {
      }
      return entry;
    });
    const components = [];
    try {
      const compNodes = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT"] });
      for (const c of compNodes) {
        const comp = c;
        components.push({ key: comp.key, name: comp.name });
      }
    } catch (_) {
      figma.currentPage.findAll((n) => n.type === "COMPONENT").forEach((c) => {
        const comp = c;
        components.push({ key: comp.key, name: comp.name });
      });
    }
    let variables = [];
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      for (const col of collections) {
        for (const varId of col.variableIds) {
          const v = await figma.variables.getVariableByIdAsync(varId);
          if (v) {
            variables.push({ id: v.id, name: v.name });
          }
        }
      }
    } catch (_e) {
    }
    const result = { textStyles, fillStyles, components, variables };
    _designSystemCache = { data: result, ts: Date.now() };
    return result;
  }
  function computeDocumentHash() {
    return figma.root.children.map((p) => `${p.name}:${p.children.length}`).join("|");
  }
  function inferColorRole(name) {
    const lower = name.toLowerCase().replace(/[\/_\-\s]+/g, " ");
    const roleMap = [
      [/\bprimary\b/, "primary"],
      [/\bsecondary\b/, "secondary"],
      [/\btertiary\b/, "tertiary"],
      [/\bsurface\b/, "surface"],
      [/\bbackground\b/, "background"],
      [/\bon[ -]?primary\b/, "on-primary"],
      [/\bon[ -]?secondary\b/, "on-secondary"],
      [/\bon[ -]?surface\b/, "on-surface"],
      [/\bon[ -]?background\b/, "on-background"],
      [/\berror\b/, "error"],
      [/\bon[ -]?error\b/, "on-error"],
      [/\bwarning\b/, "warning"],
      [/\bsuccess\b/, "success"],
      [/\binfo\b/, "info"],
      [/\boutline\b/, "outline"],
      [/\bdivider\b/, "divider"],
      [/\baccent\b/, "accent"],
      [/\bneutral\b/, "neutral"],
      [/\binverse\b/, "inverse"],
      [/\bscrim\b/, "scrim"],
      [/\bshadow\b/, "shadow"]
    ];
    for (const [re, role] of roleMap) {
      if (re.test(lower)) return role;
    }
    return void 0;
  }
  function inferTypographyRole(name, fontSize) {
    const lower = name.toLowerCase();
    if (/display|hero/i.test(lower)) return "display";
    if (/h1|heading.?1|title.?large/i.test(lower)) return "heading1";
    if (/h2|heading.?2|title.?medium/i.test(lower)) return "heading2";
    if (/h3|heading.?3|title.?small/i.test(lower)) return "heading3";
    if (/h4|heading.?4/i.test(lower)) return "heading4";
    if (/h5|heading.?5/i.test(lower)) return "heading5";
    if (/h6|heading.?6/i.test(lower)) return "heading6";
    if (/subtitle|subhead/i.test(lower)) return "subtitle";
    if (/body.?large/i.test(lower)) return "body-large";
    if (/body.?small/i.test(lower)) return "body-small";
    if (/\bbody\b/i.test(lower)) return "body";
    if (/caption/i.test(lower)) return "caption";
    if (/overline/i.test(lower)) return "overline";
    if (/label.?large/i.test(lower)) return "label-large";
    if (/label.?small/i.test(lower)) return "label-small";
    if (/\blabel\b/i.test(lower)) return "label";
    if (/button/i.test(lower)) return "button";
    if (fontSize >= 32) return "heading1";
    if (fontSize >= 24) return "heading2";
    if (fontSize >= 20) return "heading3";
    if (fontSize >= 16) return "body";
    if (fontSize >= 12) return "body-small";
    if (fontSize < 12) return "caption";
    return void 0;
  }
  function paintToHex(paint) {
    if (paint.type === "SOLID" && paint.visible !== false) {
      const c = paint.color;
      const toH = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
      return `#${toH(c.r)}${toH(c.g)}${toH(c.b)}`.toUpperCase();
    }
    return void 0;
  }
  async function extractFullDocumentDesignSystem() {
    _extractDSCancelled = false;
    const pages = figma.root.children;
    const totalPages = pages.length;
    const documentHash = computeDocumentHash();
    console.log(`[extractFullDS] Starting full document scan: ${totalPages} pages`);
    const colorPalette = [];
    const typographyScale = [];
    const spacingSet = /* @__PURE__ */ new Set();
    const cornerRadiusSet = /* @__PURE__ */ new Set();
    const allComponents = [];
    const allVariables = [];
    const allButtonStyles = [];
    const allInputStyles = [];
    const pageList = [];
    const seenColorHexes = /* @__PURE__ */ new Set();
    const textStyles = figma.getLocalTextStyles();
    for (const s of textStyles) {
      const entry = {
        name: s.name,
        fontFamily: typeof s.fontName !== "symbol" ? s.fontName.family : "Unknown",
        fontStyle: typeof s.fontName !== "symbol" ? s.fontName.style : void 0,
        fontSize: typeof s.fontSize === "number" ? s.fontSize : 16
      };
      if (s.lineHeight && typeof s.lineHeight !== "symbol") {
        const lh = s.lineHeight;
        entry.lineHeight = lh.unit === "AUTO" ? "AUTO" : lh.value;
      }
      if (typeof s.letterSpacing !== "symbol" && s.letterSpacing) {
        const ls = s.letterSpacing;
        if (ls.value) entry.letterSpacing = ls.value;
      }
      entry.role = inferTypographyRole(s.name, entry.fontSize);
      typographyScale.push(entry);
    }
    const paintStyles = figma.getLocalPaintStyles();
    for (const s of paintStyles) {
      try {
        const paints = s.paints;
        if (Array.isArray(paints)) {
          const solid = paints.find((p) => p.type === "SOLID" && p.visible !== false);
          if (solid) {
            const hex = paintToHex(solid);
            const role = inferColorRole(s.name);
            const mode = /dark/i.test(s.name) ? "dark" : /light/i.test(s.name) ? "light" : void 0;
            colorPalette.push({
              name: s.name,
              hex,
              role,
              mode,
              source: "paintStyle",
              opacity: typeof solid.opacity === "number" && solid.opacity < 1 ? Math.round(solid.opacity * 100) : void 0
            });
            seenColorHexes.add(hex);
          }
        }
      } catch (_) {
      }
    }
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      for (const col of collections) {
        const modeNameMap = {};
        for (const mode of col.modes) {
          modeNameMap[mode.modeId] = mode.name;
        }
        for (const varId of col.variableIds) {
          const v = await figma.variables.getVariableByIdAsync(varId);
          if (!v) continue;
          const valuesByMode = {};
          for (const [modeId, value] of Object.entries(v.valuesByMode)) {
            const modeName = modeNameMap[modeId] || modeId;
            if (v.resolvedType === "COLOR" && typeof value === "object" && value !== null && "r" in value) {
              const c = value;
              const toH = (val) => Math.round(val * 255).toString(16).padStart(2, "0");
              const hex = `#${toH(c.r)}${toH(c.g)}${toH(c.b)}`.toUpperCase();
              valuesByMode[modeName] = hex;
              const role = inferColorRole(v.name);
              if (!seenColorHexes.has(hex + ":" + modeName)) {
                colorPalette.push({
                  name: v.name,
                  hex,
                  role,
                  mode: modeName.toLowerCase().includes("dark") ? "dark" : modeName.toLowerCase().includes("light") ? "light" : modeName,
                  source: `variable:${col.name}`
                });
                seenColorHexes.add(hex + ":" + modeName);
              }
            } else {
              valuesByMode[modeName] = value;
            }
          }
          allVariables.push({
            id: v.id,
            name: v.name,
            collection: col.name,
            type: v.resolvedType,
            valuesByMode
          });
        }
      }
    } catch (_e) {
      console.warn("[extractFullDS] Variables API not available:", _e);
    }
    let themingStatus = "none";
    const colorVars = allVariables.filter((v) => v.type === "COLOR");
    if (colorVars.length > 0) {
      const hasMultiMode = colorVars.some((v) => Object.keys(v.valuesByMode).length >= 2);
      themingStatus = hasMultiMode ? "complete" : "partial";
    }
    console.log(`[extractFullDS] Theming status: ${themingStatus} (${colorVars.length} color variables)`);
    await yieldToUI();
    if (_extractDSCancelled) throw new Error("Extraction cancelled");
    const BATCH_NODE_COUNT = 150;
    for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
      if (_extractDSCancelled) throw new Error("Extraction cancelled");
      const page = pages[pageIdx];
      pageList.push({ name: page.name, id: page.id });
      sendToUI({ type: "extract-ds-progress", page: page.name, pageIndex: pageIdx, totalPages });
      console.log(`[extractFullDS] Scanning page ${pageIdx + 1}/${totalPages}: "${page.name}"`);
      try {
        await page.loadAsync();
      } catch (e) {
        console.warn(`[extractFullDS] Could not load page "${page.name}":`, e);
        continue;
      }
      let nodeCount = 0;
      const pageChildren = page.children;
      for (const topNode of pageChildren) {
        if (_extractDSCancelled) throw new Error("Extraction cancelled");
        const walkStack = [{ node: topNode, depth: 0 }];
        while (walkStack.length > 0) {
          const { node, depth } = walkStack.pop();
          if (depth > 6) continue;
          nodeCount++;
          if (nodeCount % BATCH_NODE_COUNT === 0) {
            await yieldToUI();
            if (_extractDSCancelled) throw new Error("Extraction cancelled");
          }
          if (node.type === "COMPONENT") {
            const comp = node;
            allComponents.push({
              key: comp.key,
              name: comp.name,
              page: page.name,
              description: comp.description || void 0
            });
          } else if (node.type === "COMPONENT_SET") {
            const compSet = node;
            const variantProps = {};
            for (const child of compSet.children) {
              if (child.type === "COMPONENT") {
                const comp = child;
                const parts = comp.name.split(",").map((s) => s.trim());
                for (const part of parts) {
                  const eq = part.indexOf("=");
                  if (eq > 0) {
                    const propName = part.slice(0, eq).trim();
                    const propVal = part.slice(eq + 1).trim();
                    if (!variantProps[propName]) variantProps[propName] = /* @__PURE__ */ new Set();
                    variantProps[propName].add(propVal);
                  }
                }
              }
            }
            allComponents.push({
              key: compSet.key,
              name: compSet.name,
              page: page.name,
              description: compSet.description || void 0,
              variants: Object.fromEntries(
                Object.entries(variantProps).map(([k, v]) => [k, [...v]])
              )
            });
            continue;
          }
          if (themingStatus !== "complete" && "fills" in node && Array.isArray(node.fills)) {
            try {
              const fills = node.fills;
              for (const f of fills) {
                const hex = paintToHex(f);
                if (hex && !seenColorHexes.has(hex)) {
                  colorPalette.push({ hex, source: `page:${page.name}` });
                  seenColorHexes.add(hex);
                }
              }
            } catch (_) {
            }
          }
          if ("cornerRadius" in node && typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
            cornerRadiusSet.add(node.cornerRadius);
          }
          if (node.type === "TEXT") {
            const tn = node;
            if (typeof tn.fontSize === "number") {
              const exists = typographyScale.some((t) => t.fontSize === tn.fontSize && t.fontFamily === (typeof tn.fontName !== "symbol" ? tn.fontName.family : ""));
              if (!exists && typeof tn.fontName !== "symbol") {
              }
            }
          }
          if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
            const frame = node;
            if (frame.layoutMode && frame.layoutMode !== "NONE") {
              if (frame.itemSpacing > 0 && frame.itemSpacing <= 200) spacingSet.add(frame.itemSpacing);
              if (frame.paddingTop > 0 && frame.paddingTop <= 200) spacingSet.add(frame.paddingTop);
              if (frame.paddingRight > 0 && frame.paddingRight <= 200) spacingSet.add(frame.paddingRight);
              if (frame.paddingBottom > 0 && frame.paddingBottom <= 200) spacingSet.add(frame.paddingBottom);
              if (frame.paddingLeft > 0 && frame.paddingLeft <= 200) spacingSet.add(frame.paddingLeft);
            }
            const nameLower = frame.name.toLowerCase();
            const isButtonByName = /\bbutton\b/i.test(frame.name);
            const isInputByName = /textbox|passwordbox|\binput\b|searchbox|text.?field/i.test(nameLower);
            if (isButtonByName && frame.height >= 30 && frame.height <= 75) {
              const fillHex = (() => {
                try {
                  const fills = frame.fills;
                  for (const f of fills) {
                    const h = paintToHex(f);
                    if (h) return h;
                  }
                } catch (_) {
                }
                return void 0;
              })();
              if (fillHex) {
                const btnStyle = {
                  name: frame.name,
                  page: page.name,
                  cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : void 0,
                  fillColor: fillHex,
                  height: Math.round(frame.height),
                  width: Math.round(frame.width)
                };
                if (frame.layoutMode && frame.layoutMode !== "NONE") {
                  btnStyle.layoutMode = frame.layoutMode;
                  btnStyle.paddingTop = frame.paddingTop;
                  btnStyle.paddingBottom = frame.paddingBottom;
                  btnStyle.paddingLeft = frame.paddingLeft;
                  btnStyle.paddingRight = frame.paddingRight;
                }
                allButtonStyles.push(btnStyle);
              }
            }
            if (isInputByName && frame.height >= 35 && frame.height <= 70) {
              const fillHex = (() => {
                try {
                  const fills = frame.fills;
                  for (const f of fills) {
                    const h = paintToHex(f);
                    if (h) return h;
                  }
                } catch (_) {
                }
                return void 0;
              })();
              const strokeHex = (() => {
                try {
                  const strokes = frame.strokes;
                  for (const s of strokes) {
                    const h = paintToHex(s);
                    if (h) return h;
                  }
                } catch (_) {
                }
                return void 0;
              })();
              const inputStyle = {
                name: frame.name,
                page: page.name,
                cornerRadius: typeof frame.cornerRadius === "number" ? frame.cornerRadius : void 0,
                height: Math.round(frame.height),
                width: Math.round(frame.width)
              };
              if (fillHex) inputStyle.fillColor = fillHex;
              if (strokeHex) inputStyle.strokeColor = strokeHex;
              allInputStyles.push(inputStyle);
            }
          }
          if ("children" in node) {
            const children = node.children;
            for (let i = children.length - 1; i >= 0; i--) {
              walkStack.push({ node: children[i], depth: depth + 1 });
            }
          }
        }
      }
      console.log(`[extractFullDS] Page "${page.name}": scanned ${nodeCount} nodes, ${allComponents.length} components total`);
      await yieldToUI();
    }
    const seenBtnNames = /* @__PURE__ */ new Set();
    const dedupedButtons = allButtonStyles.filter((b) => {
      if (seenBtnNames.has(b.name)) return false;
      seenBtnNames.add(b.name);
      return true;
    });
    const seenInputNames = /* @__PURE__ */ new Set();
    const dedupedInputs = allInputStyles.filter((i) => {
      if (seenInputNames.has(i.name)) return false;
      seenInputNames.add(i.name);
      return true;
    });
    const fullDS = {
      extractedAt: Date.now(),
      documentHash,
      themingStatus,
      pages: pageList,
      colorPalette,
      typographyScale,
      spacingScale: [...spacingSet].sort((a, b) => a - b),
      cornerRadiusScale: [...cornerRadiusSet].sort((a, b) => a - b),
      components: allComponents,
      variables: allVariables,
      buttonStyles: dedupedButtons.slice(0, 20),
      inputStyles: dedupedInputs.slice(0, 20)
    };
    console.log(`[extractFullDS] Complete! ${colorPalette.length} colors, ${typographyScale.length} typography, ${allComponents.length} components, ${allVariables.length} variables`);
    await saveDSToCache(fullDS);
    _fullDesignSystem = fullDS;
    return fullDS;
  }
  function buildDSSummary(ds) {
    var _a, _b, _c, _d;
    const paintStyleColors = ds.colorPalette.filter((c) => c.source === "paintStyle").length;
    const variableColors = ds.colorPalette.filter((c) => {
      var _a2;
      return (_a2 = c.source) == null ? void 0 : _a2.startsWith("variable:");
    }).length;
    const scrapedColors = ds.colorPalette.filter((c) => {
      var _a2;
      return (_a2 = c.source) == null ? void 0 : _a2.startsWith("page:");
    }).length;
    const componentSets = ds.components.filter((c) => c.variants).length;
    const individualComponents = ds.components.length - componentSets;
    return {
      colors: ds.colorPalette.length,
      typography: ds.typographyScale.length,
      components: ds.components.length,
      variables: ds.variables.length,
      pages: ds.pages.length,
      pageNames: ds.pages.map((p) => p.name),
      colorBreakdown: { paintStyles: paintStyleColors, variables: variableColors, scraped: scrapedColors },
      componentBreakdown: { sets: componentSets, individual: individualComponents },
      spacingCount: ((_a = ds.spacingScale) == null ? void 0 : _a.length) || 0,
      cornerRadiusCount: ((_b = ds.cornerRadiusScale) == null ? void 0 : _b.length) || 0,
      buttonStyles: ((_c = ds.buttonStyles) == null ? void 0 : _c.length) || 0,
      inputStyles: ((_d = ds.inputStyles) == null ? void 0 : _d.length) || 0,
      themingStatus: ds.themingStatus || "none"
    };
  }
  var DS_CACHE_MAX_FILES = 5;
  function generateFileUUID() {
    const hex = "0123456789abcdef";
    let uuid = "";
    for (let i = 0; i < 16; i++) uuid += hex[Math.floor(Math.random() * 16)];
    return uuid;
  }
  function getStableFileId() {
    let id = figma.root.getPluginData("designops_fileId");
    if (!id) {
      id = generateFileUUID();
      figma.root.setPluginData("designops_fileId", id);
      console.log(`[DS Cache] Generated new stable file ID: ${id}`);
    }
    return id;
  }
  function getDSCacheKey() {
    const fileId = getStableFileId();
    return "fullDS_" + fileId;
  }
  function getLegacyCacheKey() {
    const fileId = figma.fileKey || computeDocumentHash();
    return "fullDS_" + fileId.replace(/[^a-zA-Z0-9_|-]/g, "_");
  }
  async function saveDSToCache(ds) {
    const cacheKey = getDSCacheKey();
    try {
      await figma.clientStorage.setAsync(cacheKey, JSON.stringify(ds));
      let index = [];
      try {
        const raw = await figma.clientStorage.getAsync("fullDS_index");
        if (raw) index = JSON.parse(raw);
      } catch (_) {
      }
      index = index.filter((k) => k !== cacheKey);
      index.unshift(cacheKey);
      while (index.length > DS_CACHE_MAX_FILES) {
        const evicted = index.pop();
        await figma.clientStorage.deleteAsync(evicted).catch(() => {
        });
        console.log(`[extractFullDS] Evicted old cache: ${evicted}`);
      }
      await figma.clientStorage.setAsync("fullDS_index", JSON.stringify(index));
      console.log(`[extractFullDS] Saved to per-file cache: ${cacheKey}`);
    } catch (e) {
      console.warn("[extractFullDS] Failed to persist:", e);
    }
  }
  async function loadCachedFullDesignSystem() {
    try {
      const cacheKey = getDSCacheKey();
      console.log(`[DS Cache] Looking up cache key: ${cacheKey}`);
      let cached = await figma.clientStorage.getAsync(cacheKey);
      let source = cacheKey;
      if (!cached) {
        const legacyKey = getLegacyCacheKey();
        console.log(`[DS Cache] Primary miss, trying legacy key: ${legacyKey}`);
        cached = await figma.clientStorage.getAsync(legacyKey);
        if (cached) source = legacyKey;
      }
      if (!cached) {
        console.log(`[DS Cache] Legacy miss, trying single-file key: fullDesignSystem`);
        cached = await figma.clientStorage.getAsync("fullDesignSystem");
        if (cached) source = "fullDesignSystem";
      }
      if (!cached) {
        try {
          const rawIdx = await figma.clientStorage.getAsync("fullDS_index");
          if (rawIdx) {
            const index = JSON.parse(rawIdx);
            console.log(`[DS Cache] Trying ${index.length} indexed keys: ${index.join(", ")}`);
            for (const key of index) {
              const candidate = await figma.clientStorage.getAsync(key);
              if (candidate) {
                cached = candidate;
                source = key;
                console.log(`[DS Cache] Found cached DS under indexed key: ${key}`);
                break;
              }
            }
          }
        } catch (_) {
        }
      }
      if (!cached) {
        console.log(`[DS Cache] No cached design system found for this file`);
        return;
      }
      const parsed = JSON.parse(cached);
      const currentHash = computeDocumentHash();
      const isStale = parsed.documentHash !== currentHash;
      console.log(`[DS Cache] Loaded DS from "${source}" (${parsed.colorPalette.length} colors, stale=${isStale})`);
      _fullDesignSystem = parsed;
      if (source !== cacheKey) {
        await saveDSToCache(parsed);
        if (source === "fullDesignSystem") {
          await figma.clientStorage.deleteAsync("fullDesignSystem").catch(() => {
          });
        }
        console.log(`[DS Cache] Migrated from "${source}" to "${cacheKey}"`);
      }
      sendToUI({
        type: "extract-ds-cached",
        summary: buildDSSummary(parsed),
        extractedAt: parsed.extractedAt,
        stale: isStale
      });
    } catch (e) {
      console.warn("[DS Cache] Error loading cached design system:", e);
    }
  }
  async function generateDesignDocs() {
    const tokens = await extractStyleTokens();
    const ds = await extractDesignSystemSnapshot();
    const pageName = figma.currentPage.name;
    const now = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const STATE_KEYWORDS = /Hover|Focus|Press|Drag|Select|Disable|Medium\s*Brush|Low\s*Brush/i;
    const FIGMA_INTERNAL = /^Figma\s*\(/i;
    const MAX_TOKEN_VALUE = 64;
    function dedupeComponents(items) {
      const seen = /* @__PURE__ */ new Set();
      return items.filter((item) => {
        const sig = [item.fillColor || "", item.strokeColor || "", item.cornerRadius || 0].join("|");
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
    }
    function stripGroupPrefix(name) {
      const slash = name.indexOf("/");
      if (slash === -1) return name;
      return name.substring(slash + 1);
    }
    function round(v, decimals) {
      const m = Math.pow(10, decimals);
      return Math.round(v * m) / m;
    }
    const validTopLevelTypes = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"]);
    const designFrames = figma.currentPage.children.filter((c) => {
      if (!validTopLevelTypes.has(c.type)) return false;
      if (c.name === CHANGE_LOG_FRAME_NAME) return false;
      if (c.name.startsWith("Generation ") || c.name.startsWith("Try the plugin")) return false;
      if ("getPluginData" in c && c.getPluginData("generated") === "true") return false;
      return true;
    });
    const lines = [];
    lines.push("---");
    lines.push(`applyTo: "**"`);
    lines.push("---");
    lines.push("");
    lines.push(`# Design System \u2014 ${pageName}`);
    lines.push("");
    lines.push(`> Auto-extracted from Figma on ${now}. Use these tokens and component specs as the`);
    lines.push(`> single source of truth when generating UI code for this project.`);
    lines.push("");
    lines.push("## Color Palette");
    lines.push("");
    if (tokens.colors && tokens.colors.length > 0) {
      lines.push("| Hex | Role |");
      lines.push("|-----|------|");
      const knownPrimary = /* @__PURE__ */ new Set();
      const knownError = /* @__PURE__ */ new Set();
      for (const s of ds.fillStyles || []) {
        const lower = (s.name || "").toLowerCase();
        if (s.hex) {
          if (lower.includes("error") && !lower.includes("on error")) knownError.add(s.hex);
          else if (lower.includes("primary") && !lower.includes("on primary")) knownPrimary.add(s.hex);
        }
      }
      for (const hex of tokens.colors) {
        let role = "\u2014";
        if (knownPrimary.has(hex)) role = "Primary";
        else if (knownError.has(hex)) role = "Error / Danger";
        else if (hex === "#FFFFFF" || hex === "#FCFBFF") role = "Background / Surface";
        else if (hex === "#000000" || hex === "#1C1B1F") role = "On Surface (text)";
        lines.push(`| \`${hex}\` | ${role} |`);
      }
    } else {
      lines.push("_No colors detected._");
    }
    lines.push("");
    const filteredFillStyles = (ds.fillStyles || []).filter(
      (s) => !STATE_KEYWORDS.test(s.name) && !FIGMA_INTERNAL.test(s.name)
    );
    if (filteredFillStyles.length > 0) {
      const lightStyles = filteredFillStyles.filter((s) => s.name.startsWith("Light/"));
      const darkStyles = filteredFillStyles.filter((s) => s.name.startsWith("Dark/"));
      const otherStyles = filteredFillStyles.filter((s) => !s.name.startsWith("Light/") && !s.name.startsWith("Dark/"));
      const renderStyleTable = (styles, themePrefix) => {
        lines.push("| Token | Hex |");
        lines.push("|-------|-----|");
        for (const s of styles) {
          let name = themePrefix ? s.name.replace(new RegExp("^" + themePrefix + "/"), "") : s.name;
          name = stripGroupPrefix(name);
          const hex = s.hex ? `\`${s.hex}\`` : "\u2014";
          lines.push(`| ${name} | ${hex} |`);
        }
        lines.push("");
      };
      if (lightStyles.length > 0) {
        lines.push("### Light Theme Tokens");
        lines.push("");
        renderStyleTable(lightStyles, "Light");
      }
      if (darkStyles.length > 0) {
        lines.push("### Dark Theme Tokens");
        lines.push("");
        renderStyleTable(darkStyles, "Dark");
      }
      if (otherStyles.length > 0) {
        lines.push("### Other Color Tokens");
        lines.push("");
        renderStyleTable(otherStyles, "");
      }
    }
    lines.push("## Typography");
    lines.push("");
    if (tokens.fontFamilies && tokens.fontFamilies.length > 0) {
      lines.push("### Font Families");
      lines.push("");
      for (const ff of tokens.fontFamilies) {
        lines.push(`- ${ff}`);
      }
      lines.push("");
    }
    if (tokens.fontSizes && tokens.fontSizes.length > 0) {
      lines.push("### Type Scale (px)");
      lines.push("");
      lines.push(tokens.fontSizes.join(", "));
      lines.push("");
    }
    const filteredTextStyles = (ds.textStyles || []).filter(
      (s) => !FIGMA_INTERNAL.test(s.name)
    );
    if (filteredTextStyles.length > 0) {
      lines.push("### Named Text Styles");
      lines.push("");
      lines.push("| Name | Font | Size | Line Height | Letter Spacing |");
      lines.push("|------|------|------|-------------|----------------|");
      for (const s of filteredTextStyles) {
        const font = s.fontFamily ? `${s.fontFamily} ${s.fontStyle || ""}`.trim() : "\u2014";
        const size = s.fontSize ? `${s.fontSize}px` : "\u2014";
        const lh = s.lineHeight !== void 0 ? s.lineHeight === "AUTO" ? "Auto" : `${s.lineHeight}` : "\u2014";
        const ls = s.letterSpacing !== void 0 ? `${round(s.letterSpacing, 2)}` : "\u2014";
        lines.push(`| ${s.name} | ${font} | ${size} | ${lh} | ${ls} |`);
      }
      lines.push("");
    }
    lines.push("## Spacing Scale (px)");
    lines.push("");
    if (tokens.spacings && tokens.spacings.length > 0) {
      const capped = tokens.spacings.filter((v) => v <= MAX_TOKEN_VALUE);
      lines.push(capped.length > 0 ? capped.join(", ") : "_No spacing values detected._");
    } else {
      lines.push("_No spacing values detected._");
    }
    lines.push("");
    if (tokens.paddings && tokens.paddings.length > 0) {
      const capped = tokens.paddings.filter((v) => v <= MAX_TOKEN_VALUE);
      if (capped.length > 0) {
        lines.push("### Padding Values (px)");
        lines.push("");
        lines.push(capped.join(", "));
        lines.push("");
      }
    }
    lines.push("## Corner Radii (px)");
    lines.push("");
    if (tokens.cornerRadii && tokens.cornerRadii.length > 0) {
      lines.push(tokens.cornerRadii.join(", "));
    } else {
      lines.push("_No corner radii detected._");
    }
    lines.push("");
    lines.push("## Components");
    lines.push("");
    if (tokens.buttonStyles && tokens.buttonStyles.length > 0) {
      const buttons = dedupeComponents(tokens.buttonStyles);
      lines.push("### Buttons");
      lines.push("");
      for (const btn of buttons) {
        let label = btn.name || "Button";
        if (btn.strokeColor && (!btn.fillColor || btn.fillColor === "#FFFFFF")) label = "Outline Button";
        else if (btn.fillColor && btn.fillColor !== "#FFFFFF") label = "Filled Button";
        lines.push(`**${label}**`);
        lines.push("");
        const props = [];
        if (btn.fillColor) props.push(`- Fill: \`${btn.fillColor}\``);
        if (btn.strokeColor) props.push(`- Border: \`${btn.strokeColor}\` (${typeof btn.strokeWeight === "number" ? btn.strokeWeight : 1}px)`);
        if (btn.cornerRadius !== void 0) props.push(`- Corner radius: ${btn.cornerRadius}px`);
        if (btn.height) props.push(`- Height: ${btn.height}px`);
        if (btn.textFontSize) props.push(`- Font size: ${btn.textFontSize}px`);
        if (btn.textFontFamily) props.push(`- Font: ${btn.textFontFamily} ${btn.textFontStyle || ""}`.trim());
        if (btn.textColor) props.push(`- Text color: \`${btn.textColor}\``);
        if (btn.layoutMode) {
          props.push(`- Layout: ${btn.layoutMode}`);
          const pad = [btn.paddingTop, btn.paddingRight, btn.paddingBottom, btn.paddingLeft].filter((v) => v !== void 0);
          if (pad.length > 0) props.push(`- Padding: ${pad.join(" / ")}px`);
        }
        if (btn.layoutSizingHorizontal) props.push(`- Horizontal sizing: ${btn.layoutSizingHorizontal}`);
        lines.push(props.join("\n"));
        lines.push("");
      }
    }
    if (tokens.inputStyles && tokens.inputStyles.length > 0) {
      const inputs = dedupeComponents(tokens.inputStyles);
      lines.push("### Text Inputs");
      lines.push("");
      for (const inp of inputs) {
        lines.push(`**${inp.name || "Input"}**`);
        lines.push("");
        const props = [];
        if (inp.fillColor) props.push(`- Fill: \`${inp.fillColor}\``);
        if (inp.strokeColor) props.push(`- Border: \`${inp.strokeColor}\` (${typeof inp.strokeWeight === "number" ? inp.strokeWeight : 1}px)`);
        if (inp.bottomBorderOnly) props.push(`- Bottom border only: ${typeof inp.bottomBorderWeight === "number" ? inp.bottomBorderWeight : 1}px`);
        if (inp.cornerRadius !== void 0) props.push(`- Corner radius: ${inp.cornerRadius}px`);
        if (inp.height) props.push(`- Height: ${inp.height}px`);
        if (inp.textFontSize) props.push(`- Font size: ${inp.textFontSize}px`);
        if (inp.textFontFamily) props.push(`- Font: ${inp.textFontFamily} ${inp.textFontStyle || ""}`.trim());
        if (inp.textColor) props.push(`- Text color: \`${inp.textColor}\``);
        if (inp.layoutMode) {
          props.push(`- Layout: ${inp.layoutMode}`);
          const pad = [inp.paddingTop, inp.paddingRight, inp.paddingBottom, inp.paddingLeft].filter((v) => v !== void 0);
          if (pad.length > 0) props.push(`- Padding: ${pad.join(" / ")}px`);
        }
        lines.push(props.join("\n"));
        lines.push("");
      }
    }
    if (ds.components && ds.components.length > 0) {
      lines.push("### Named Components");
      lines.push("");
      lines.push("| Name | Key |");
      lines.push("|------|-----|");
      for (const c of ds.components) {
        lines.push(`| ${c.name} | \`${c.key}\` |`);
      }
      lines.push("");
    }
    if (ds.variables && ds.variables.length > 0) {
      lines.push("## Design Variables");
      lines.push("");
      lines.push("| Name | ID |");
      lines.push("|------|----|");
      for (const v of ds.variables) {
        lines.push(`| ${v.name} | \`${v.id}\` |`);
      }
      lines.push("");
    }
    if (tokens.rootFrameLayouts && tokens.rootFrameLayouts.length > 0) {
      lines.push("## Layout Patterns");
      lines.push("");
      for (const layout of tokens.rootFrameLayouts) {
        lines.push(`**${layout.name}** \u2014 ${layout.width}\xD7${layout.height}`);
        const props = [];
        if (layout.layoutMode) props.push(`Layout: ${layout.layoutMode}`);
        if (layout.fillColor) props.push(`Background: \`${layout.fillColor}\``);
        if (layout.paddingTop !== void 0) {
          props.push(`Padding: ${layout.paddingTop} / ${layout.paddingRight} / ${layout.paddingBottom} / ${layout.paddingLeft}`);
        }
        if (layout.itemSpacing) props.push(`Gap: ${layout.itemSpacing}px`);
        if (props.length > 0) lines.push(props.map((p) => `- ${p}`).join("\n"));
        lines.push("");
      }
    }
    const layoutNames = new Set((tokens.rootFrameLayouts || []).map((l) => l.name));
    const unlisted = designFrames.filter((f) => !layoutNames.has(f.name));
    if (unlisted.length > 0) {
      lines.push("## Additional Screens");
      lines.push("");
      for (const f of unlisted) {
        const w = Math.round(f.width);
        const h = Math.round(f.height);
        lines.push(`- **${f.name}** (${w}\xD7${h})`);
      }
      lines.push("");
    }
    const safeName = pageName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `design-system-${safeName}.md`;
    return { markdown: lines.join("\n"), filename };
  }
  async function applyInsertComponent(op) {
    const comp = await figma.importComponentByKeyAsync(op.componentKey);
    const instance = comp.createInstance();
    const parent = figma.getNodeById(op.parentId);
    if (parent && "appendChild" in parent) {
      parent.appendChild(instance);
    }
  }
  function applyCreateFrame(op) {
    const frame = figma.createFrame();
    frame.name = op.name;
    if (op.layout) {
      if (op.layout.direction) {
        frame.layoutMode = op.layout.direction;
      }
      if (op.layout.spacingToken) {
        const spacing = parseFloat(op.layout.spacingToken);
        if (!isNaN(spacing)) {
          frame.itemSpacing = spacing;
        }
      }
      if (op.layout.paddingToken) {
        const pad = parseFloat(op.layout.paddingToken);
        if (!isNaN(pad)) {
          frame.paddingTop = pad;
          frame.paddingRight = pad;
          frame.paddingBottom = pad;
          frame.paddingLeft = pad;
        }
      }
    }
    const parent = figma.getNodeById(op.parentId);
    if (parent && "appendChild" in parent) {
      parent.appendChild(frame);
    }
  }
  async function applySetText(op) {
    let node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (node.type !== "TEXT" && "findOne" in node) {
      const container = node;
      const textChild = container.findOne((n) => n.type === "TEXT");
      if (textChild) {
        node = textChild;
      } else {
        throw new Error(`Node ${op.nodeId} is not a TEXT node and contains no TEXT children`);
      }
    } else if (node.type !== "TEXT") {
      throw new Error(`Node ${op.nodeId} is not a TEXT node`);
    }
    const textNode = node;
    const fontName = textNode.fontName;
    if (fontName === figma.mixed) {
      const len = textNode.characters.length || 1;
      const loaded = /* @__PURE__ */ new Set();
      for (let i = 0; i < len; i++) {
        const f = textNode.getRangeFontName(i, i + 1);
        if (f !== figma.mixed) {
          const key = f.family + "::" + f.style;
          if (!loaded.has(key)) {
            loaded.add(key);
            await figma.loadFontAsync(f);
          }
        }
      }
    } else {
      await figma.loadFontAsync(fontName);
    }
    textNode.characters = op.text;
  }
  async function applyTextStyle(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node || node.type !== "TEXT") {
      throw new Error(`Node ${op.nodeId} is not a TEXT node`);
    }
    const textNode = node;
    const style = figma.getStyleById(op.styleId);
    if (style) {
      await figma.loadFontAsync(style.fontName);
    }
    textNode.textStyleId = op.styleId;
  }
  function applyFillStyle(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if ("fillStyleId" in node) {
      node.fillStyleId = op.styleId;
    } else {
      throw new Error(`Node ${op.nodeId} does not support fill styles`);
    }
  }
  function applyRenameNode(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    node.name = op.name;
  }
  async function applySetImage(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (!("fills" in node)) {
      throw new Error(`Node ${op.nodeId} (${node.type}) does not support fills`);
    }
    const base64 = op.imageBase64;
    if (!base64) {
      throw new Error(
        `No image data resolved for this SET_IMAGE (prompt: "${op.imagePrompt}"). Keys on op: ${Object.keys(op).join(", ")}`
      );
    }
    const lookup = new Uint8Array(128);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
    const b64 = base64.indexOf(",") >= 0 ? base64.split(",")[1] : base64;
    const cleanB64 = b64.replace(/[^A-Za-z0-9+/]/g, "");
    const rawLen = cleanB64.length * 3 / 4;
    const bytes = new Uint8Array(rawLen);
    let p = 0;
    for (let i = 0; i < cleanB64.length; i += 4) {
      const a = lookup[cleanB64.charCodeAt(i)];
      const b = lookup[cleanB64.charCodeAt(i + 1)];
      const c = lookup[cleanB64.charCodeAt(i + 2)];
      const d = lookup[cleanB64.charCodeAt(i + 3)];
      bytes[p++] = a << 2 | b >> 4;
      if (i + 2 < cleanB64.length) bytes[p++] = (b & 15) << 4 | c >> 2;
      if (i + 3 < cleanB64.length) bytes[p++] = (c & 3) << 6 | d;
    }
    const trimmed = bytes.slice(0, p);
    const image = figma.createImage(trimmed);
    node.fills = [
      {
        type: "IMAGE",
        scaleMode: "FILL",
        imageHash: image.hash
      }
    ];
  }
  function tightFitAutoLayout(node) {
    if (!("children" in node)) return;
    const r = node;
    const kids = r.children;
    for (const kid of kids) {
      tightFitAutoLayout(kid);
    }
    if (!("layoutMode" in node) || r.layoutMode === "NONE" || !("resize" in node)) return;
    const padTop = r.paddingTop || 0;
    const padBottom = r.paddingBottom || 0;
    const padLeft = r.paddingLeft || 0;
    const padRight = r.paddingRight || 0;
    const gap = r.itemSpacing || 0;
    const isHoriz = r.layoutMode === "HORIZONTAL";
    if (kids.length === 0) return;
    let neededH;
    let neededW;
    if (isHoriz) {
      neededH = padTop + Math.max(...kids.map((k) => k.height)) + padBottom;
      neededW = padLeft;
      for (let i = 0; i < kids.length; i++) {
        if (i > 0) neededW += gap;
        neededW += kids[i].width;
      }
      neededW += padRight;
    } else {
      neededH = padTop;
      for (let i = 0; i < kids.length; i++) {
        if (i > 0) neededH += gap;
        neededH += kids[i].height;
      }
      neededH += padBottom;
      neededW = padLeft + Math.max(...kids.map((k) => k.width)) + padRight;
    }
    const curW = node.width;
    const curH = node.height;
    const fitW = Math.min(curW, Math.round(neededW));
    const fitH = Math.min(curH, Math.round(neededH));
    if (fitH < curH || fitW < curW) {
      console.log(`[resize] Tight-fit "${node.name}" ${curW}x${curH} \u2192 ${fitW}x${fitH}`);
      if (r.minHeight !== void 0) r.minHeight = null;
      if (r.minWidth !== void 0) r.minWidth = null;
      node.resize(fitW, fitH);
      if (r.minHeight !== void 0) r.minHeight = fitH;
      if (r.minWidth !== void 0) r.minWidth = fitW;
    }
  }
  function normalizeGridCells(root, scaleX, scaleY) {
    if (!("children" in root)) return;
    const kids = root.children;
    const rootR = root;
    if ("layoutMode" in root && rootR.layoutMode === "GRID" && kids.length > 1) {
      console.log(`[resize] Normalizing GRID "${root.name}" with ${kids.length} cells`);
      const refCell = kids[0];
      for (let i = 1; i < kids.length; i++) {
        const cell = kids[i];
        if (!("children" in cell)) continue;
        const cellKids = cell.children;
        const refKids = "children" in refCell ? refCell.children : [];
        for (let j = 0; j < cellKids.length && j < refKids.length; j++) {
          const refKid = refKids[j];
          const cellKid = cellKids[j];
          if ("resize" in cellKid && "resize" in refKid) {
            const cellKidR = cellKid;
            const cellKidOldW = cellKid.width;
            const cellKidOldH = cellKid.height;
            if (Math.abs(cellKid.height - refKid.height) > 1 || Math.abs(cellKid.width - refKid.width) > 1) {
              const targetH = refKid.height;
              const targetW = refKid.width;
              console.log(`[resize] GRID cell ${i} child "${cellKid.name}" ${cellKidOldW}x${cellKidOldH} \u2192 ${targetW}x${targetH} (matching reference "${refKid.name}")`);
              if ("layoutSizingVertical" in cellKid && cellKidR.layoutSizingVertical !== "FIXED") {
                cellKidR.layoutSizingVertical = "FIXED";
              }
              if ("layoutSizingHorizontal" in cellKid && cellKidR.layoutSizingHorizontal !== "FIXED") {
                cellKidR.layoutSizingHorizontal = "FIXED";
              }
              cellKid.resize(targetW, targetH);
              const childScaleX = targetW / cellKidOldW;
              const childScaleY = targetH / cellKidOldH;
              if ("layoutMode" in cellKid && cellKidR.layoutMode !== "NONE") {
                cellKidR.paddingTop = Math.round((cellKidR.paddingTop || 0) * childScaleY);
                cellKidR.paddingBottom = Math.round((cellKidR.paddingBottom || 0) * childScaleY);
                cellKidR.paddingLeft = Math.round((cellKidR.paddingLeft || 0) * childScaleX);
                cellKidR.paddingRight = Math.round((cellKidR.paddingRight || 0) * childScaleX);
                const isHoriz = cellKidR.layoutMode === "HORIZONTAL";
                cellKidR.itemSpacing = Math.round((cellKidR.itemSpacing || 0) * (isHoriz ? childScaleX : childScaleY));
              }
              scaleSubtree(cellKid, childScaleX, childScaleY);
            }
          }
        }
      }
    }
    for (const kid of kids) {
      normalizeGridCells(kid, scaleX, scaleY);
    }
  }
  function scaleSubtree(node, scaleX, scaleY) {
    if (!("children" in node)) return;
    const kids = node.children;
    const parentLayout = "layoutMode" in node ? node.layoutMode : "NONE";
    for (const kid of kids) {
      const kidR = kid;
      if (kid.type === "TEXT") {
        if (parentLayout === "NONE" || parentLayout === void 0) {
          kid.x = Math.round(kid.x * scaleX);
          kid.y = Math.round(kid.y * scaleY);
        }
        continue;
      }
      const vectorTypes = ["VECTOR", "LINE", "STAR", "POLYGON", "BOOLEAN_OPERATION"];
      if (vectorTypes.includes(kid.type)) {
        if (parentLayout === "NONE" || parentLayout === void 0) {
          kid.x = Math.round(kid.x * scaleX);
          kid.y = Math.round(kid.y * scaleY);
        }
        console.log(`[resize] Skipping vector "${kid.name}" (${kid.type}) \u2014 reposition only`);
        continue;
      }
      const isSmallIconFrame = kid.width <= 48 && kid.height <= 48 && "children" in kid && kid.children.every(
        (c) => vectorTypes.includes(c.type) || c.type === "TEXT" || c.type === "ELLIPSE" || c.width <= 48 && c.height <= 48
      );
      if (isSmallIconFrame) {
        if (parentLayout === "NONE" || parentLayout === void 0) {
          kid.x = Math.round(kid.x * scaleX);
          kid.y = Math.round(kid.y * scaleY);
        }
        console.log(`[resize] Skipping icon frame "${kid.name}" ${kid.width}x${kid.height} \u2014 reposition only`);
        continue;
      }
      const kOldW = kid.width;
      const kOldH = kid.height;
      let kNewW = Math.round(kOldW * scaleX);
      let kNewH = Math.round(kOldH * scaleY);
      const hasRoundCorners = "cornerRadius" in kid && typeof kid.cornerRadius === "number" && kid.cornerRadius >= Math.min(kOldW, kOldH) / 2 - 2;
      const isCircular = kid.type === "ELLIPSE" || Math.abs(kOldW - kOldH) <= 5 && kOldW > 20 && hasRoundCorners;
      if (isCircular) {
        const maxDim = Math.max(kNewW, kNewH);
        kNewW = maxDim;
        kNewH = maxDim;
      }
      if ("layoutSizingHorizontal" in kid) {
        if (kidR.layoutSizingHorizontal !== "FIXED") kidR.layoutSizingHorizontal = "FIXED";
        if (kidR.layoutSizingVertical !== "FIXED") kidR.layoutSizingVertical = "FIXED";
      }
      if ("resize" in kid) {
        kid.resize(kNewW, kNewH);
        console.log(`[resize] Deep-scaled "${kid.name}" ${kOldW}x${kOldH} \u2192 ${kNewW}x${kNewH}${isCircular ? " (circle)" : ""}`);
      }
      if (parentLayout === "NONE" || parentLayout === void 0) {
        const origX = kid.x;
        const origY = kid.y;
        kid.x = Math.round(origX * scaleX);
        kid.y = Math.round(origY * scaleY);
        const proportionalW = Math.round(kOldW * scaleX);
        const proportionalH = Math.round(kOldH * scaleY);
        if (kNewW !== proportionalW) {
          const extraW = kNewW - proportionalW;
          kid.x -= Math.round(extraW / 2);
          console.log(`[resize] Centering "${kid.name}" x: shifted left by ${Math.round(extraW / 2)}px (circle grew ${extraW}px wider than proportional)`);
        }
        if (kNewH !== proportionalH) {
          const extraH = kNewH - proportionalH;
          kid.y -= Math.round(extraH / 2);
          console.log(`[resize] Centering "${kid.name}" y: shifted up by ${Math.round(extraH / 2)}px (circle grew ${extraH}px taller than proportional)`);
        }
        const parentW = node.width;
        const parentH = node.height;
        const parentOldW = scaleX !== 0 ? parentW / scaleX : parentW;
        const parentOldH = scaleY !== 0 ? parentH / scaleY : parentH;
        const origLeftMargin = origX;
        const origRightMargin = Math.max(0, parentOldW - origX - kOldW);
        const origTopMargin = origY;
        const origBottomMargin = Math.max(0, parentOldH - origY - kOldH);
        const minHPad = Math.round(Math.min(origLeftMargin, origRightMargin) * scaleX);
        const minVPad = Math.round(Math.min(origTopMargin, origBottomMargin) * scaleY);
        if (kid.x + kNewW > parentW - minHPad) {
          const clamped = Math.max(minHPad, parentW - kNewW - minHPad);
          console.log(`[resize] Clamping "${kid.name}" x: ${kid.x} \u2192 ${clamped} (preserving ${minHPad}px padding)`);
          kid.x = clamped;
        }
        if (kid.x < minHPad && kid.x + kNewW + minHPad <= parentW) {
          console.log(`[resize] Clamping "${kid.name}" x: ${kid.x} \u2192 ${minHPad} (left padding)`);
          kid.x = minHPad;
        }
        if (kid.x < 0) kid.x = 0;
        if (kid.y + kNewH > parentH - minVPad) {
          const clamped = Math.max(minVPad, parentH - kNewH - minVPad);
          console.log(`[resize] Clamping "${kid.name}" y: ${kid.y} \u2192 ${clamped} (preserving ${minVPad}px padding)`);
          kid.y = clamped;
        }
        if (kid.y < minVPad && kid.y + kNewH + minVPad <= parentH) {
          console.log(`[resize] Clamping "${kid.name}" y: ${kid.y} \u2192 ${minVPad} (top padding)`);
          kid.y = minVPad;
        }
        if (kid.y < 0) kid.y = 0;
      }
      if ("cornerRadius" in kid) {
        const cr = kidR.cornerRadius;
        if (typeof cr === "number" && cr > 0) {
          kidR.cornerRadius = Math.round(cr * Math.max(scaleX, scaleY));
        }
      }
      if ("layoutMode" in kid && kidR.layoutMode !== "NONE") {
        if ("paddingTop" in kid) {
          kidR.paddingTop = Math.round((kidR.paddingTop || 0) * scaleY);
          kidR.paddingBottom = Math.round((kidR.paddingBottom || 0) * scaleY);
          kidR.paddingLeft = Math.round((kidR.paddingLeft || 0) * scaleX);
          kidR.paddingRight = Math.round((kidR.paddingRight || 0) * scaleX);
        }
        if ("itemSpacing" in kid) {
          const isHoriz = kidR.layoutMode === "HORIZONTAL";
          kidR.itemSpacing = Math.round((kidR.itemSpacing || 0) * (isHoriz ? scaleX : scaleY));
        }
      }
      scaleSubtree(kid, scaleX, scaleY);
    }
  }
  function applyResizeNode(op) {
    var _a, _b;
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (!("resize" in node)) {
      throw new Error(`Node ${op.nodeId} (${node.type}) does not support resize`);
    }
    const resizable = node;
    const r = resizable;
    const oldW = resizable.width;
    const oldH = resizable.height;
    const newW = (_a = op.width) != null ? _a : oldW;
    const newH = (_b = op.height) != null ? _b : oldH;
    if (_skipResizePropagation) {
      console.log(`[resize] Refinement: "${node.name}" ${oldW}x${oldH} \u2192 ${newW}x${newH}`);
      if ("layoutSizingHorizontal" in resizable) {
        if (op.width !== void 0 && r.layoutSizingHorizontal !== "FIXED") r.layoutSizingHorizontal = "FIXED";
        if (op.height !== void 0 && r.layoutSizingVertical !== "FIXED") r.layoutSizingVertical = "FIXED";
      }
      resizable.resize(newW, newH);
      return;
    }
    console.log(`[resize] Node ${op.nodeId} type=${node.type} name="${node.name}" old=${oldW}x${oldH} new=${newW}x${newH}`);
    if ("absoluteBoundingBox" in resizable) {
      const bb = r.absoluteBoundingBox;
      console.log(`[resize] BEFORE absoluteBoundingBox: x=${bb == null ? void 0 : bb.x} y=${bb == null ? void 0 : bb.y} w=${bb == null ? void 0 : bb.width} h=${bb == null ? void 0 : bb.height}`);
    }
    if ("absoluteRenderBounds" in resizable) {
      const rb = r.absoluteRenderBounds;
      console.log(`[resize] BEFORE absoluteRenderBounds: x=${rb == null ? void 0 : rb.x} y=${rb == null ? void 0 : rb.y} w=${rb == null ? void 0 : rb.width} h=${rb == null ? void 0 : rb.height}`);
    }
    console.log(`[resize] visible=${r.visible} opacity=${r.opacity} clipsContent=${r.clipsContent}`);
    if ("fills" in resizable) {
      try {
        const fills = r.fills;
        console.log(`[resize] fills: ${JSON.stringify(fills)}`);
      } catch (_e) {
        console.log("[resize] fills: mixed");
      }
    }
    if ("layoutMode" in resizable) {
      console.log(`[resize] layoutMode=${r.layoutMode} primaryAxisSizingMode=${r.primaryAxisSizingMode} counterAxisSizingMode=${r.counterAxisSizingMode}`);
      console.log(`[resize] padding: T=${r.paddingTop} B=${r.paddingBottom} L=${r.paddingLeft} R=${r.paddingRight} gap=${r.itemSpacing}`);
    }
    if ("layoutSizingHorizontal" in resizable) {
      console.log(`[resize] layoutSizing: H=${r.layoutSizingHorizontal} V=${r.layoutSizingVertical}`);
    }
    const parent = resizable.parent;
    if (parent) {
      console.log(`[resize] parent: type=${parent.type} name="${parent.name}" layoutMode=${"layoutMode" in parent ? parent.layoutMode : "N/A"}`);
    }
    if ("children" in resizable) {
      const kids = resizable.children;
      console.log(`[resize] children count=${kids.length}`);
      for (const kid of kids) {
        console.log(`[resize]   child: id=${kid.id} type=${kid.type} name="${kid.name}" size=${kid.width}x${kid.height}`);
      }
    }
    if ("layoutSizingHorizontal" in resizable) {
      if (op.width !== void 0 && r.layoutSizingHorizontal !== "FIXED") {
        r.layoutSizingHorizontal = "FIXED";
      }
      if (op.height !== void 0 && r.layoutSizingVertical !== "FIXED") {
        r.layoutSizingVertical = "FIXED";
      }
    }
    if ("primaryAxisSizingMode" in resizable) {
      if (r.primaryAxisSizingMode === "AUTO") r.primaryAxisSizingMode = "FIXED";
      if (r.counterAxisSizingMode === "AUTO") r.counterAxisSizingMode = "FIXED";
    }
    const gapSnapshots = [];
    {
      let cur = resizable;
      for (let d = 0; d < 10; d++) {
        const p = cur.parent;
        if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
        const pAny = p;
        const pLayout = "layoutMode" in p ? pAny.layoutMode : "NONE";
        if (pLayout === "NONE" && "children" in p) {
          const sibs = pAny.children.slice().sort((a, b) => a.y - b.y);
          const idx = sibs.findIndex((s) => s.id === cur.id);
          if (idx >= 0) {
            const gaps = [];
            const curBottom = cur.y + cur.height;
            for (let i = idx + 1; i < sibs.length; i++) {
              const prev = i === idx + 1 ? cur : sibs[i - 1];
              const prevBottom = prev.y + prev.height;
              gaps.push({ sibId: sibs[i].id, gap: sibs[i].y - prevBottom });
            }
            gapSnapshots.push({ parentId: p.id, nodeId: cur.id, gaps });
            console.log(`[resize] Gap snapshot at "${p.name}": ${gaps.map((g) => `${g.sibId}:${g.gap}px`).join(", ")}`);
          }
        }
        cur = p;
      }
    }
    if ("cornerRadius" in resizable) {
      const cr = r.cornerRadius;
      if (typeof cr === "number" && cr > 0) {
        const scale = Math.max(newW / oldW, newH / oldH);
        r.cornerRadius = Math.round(cr * scale);
      }
    }
    if ("layoutMode" in resizable && r.layoutMode !== "NONE") {
      if (r.minHeight !== void 0) r.minHeight = null;
      if (r.minWidth !== void 0) r.minWidth = null;
    }
    resizable.resize(newW, newH);
    const scaleX = newW / oldW;
    const scaleY = newH / oldH;
    if ("layoutMode" in resizable && r.layoutMode !== "NONE") {
      r.paddingTop = Math.round((r.paddingTop || 0) * scaleY);
      r.paddingBottom = Math.round((r.paddingBottom || 0) * scaleY);
      r.paddingLeft = Math.round((r.paddingLeft || 0) * scaleX);
      r.paddingRight = Math.round((r.paddingRight || 0) * scaleX);
      const isHoriz = r.layoutMode === "HORIZONTAL";
      r.itemSpacing = Math.round((r.itemSpacing || 0) * (isHoriz ? scaleX : scaleY));
    }
    scaleSubtree(resizable, scaleX, scaleY);
    normalizeGridCells(resizable, scaleX, scaleY);
    if (resizable.parent && "layoutMode" in resizable.parent && resizable.parent.layoutMode === "GRID") {
      console.log(`[resize] Parent "${resizable.parent.name}" is GRID \u2014 normalizing sibling cells`);
      normalizeGridCells(resizable.parent, scaleX, scaleY);
    }
    tightFitAutoLayout(resizable);
    if ("children" in resizable && "layoutMode" in resizable) {
      try {
        const layoutMode = r.layoutMode;
        if (layoutMode && layoutMode !== "NONE") {
          const kids = resizable.children;
          if (kids.length > 0) {
            const padTop = r.paddingTop || 0;
            const padBottom = r.paddingBottom || 0;
            const padLeft = r.paddingLeft || 0;
            const padRight = r.paddingRight || 0;
            const gapVal = r.itemSpacing || 0;
            const isHorizontal = layoutMode === "HORIZONTAL";
            let contentH;
            let contentW;
            if (isHorizontal) {
              contentH = padTop + Math.max(...kids.map((k) => k.height)) + padBottom;
              contentW = padLeft;
              for (let i = 0; i < kids.length; i++) {
                if (i > 0) contentW += gapVal;
                contentW += kids[i].width;
              }
              contentW += padRight;
            } else {
              contentH = padTop;
              for (let i = 0; i < kids.length; i++) {
                if (i > 0) contentH += gapVal;
                contentH += kids[i].height;
              }
              contentH += padBottom;
              contentW = padLeft + Math.max(...kids.map((k) => k.width)) + padRight;
            }
            let origContentH;
            if (isHorizontal) {
              origContentH = Math.round(padTop / scaleY) + Math.max(...kids.map((k) => Math.round(k.height / scaleY))) + Math.round(padBottom / scaleY);
            } else {
              origContentH = Math.round(padTop / scaleY);
              for (let i = 0; i < kids.length; i++) {
                if (i > 0) origContentH += Math.round(gapVal / scaleY);
                origContentH += Math.round(kids[i].height / scaleY);
              }
              origContentH += Math.round(padBottom / scaleY);
            }
            const contentDelta = contentH - origContentH;
            const adjustedH = Math.round(oldH + contentDelta);
            if (adjustedH < newH && adjustedH > oldH) {
              console.log(`[resize] Content tight-fit (${layoutMode}): ${newH}px \u2192 ${adjustedH}px (content grew ${Math.round(contentDelta)}px, saved ${newH - adjustedH}px)`);
              if (r.minHeight !== void 0) r.minHeight = null;
              resizable.resize(newW, adjustedH);
              r.minHeight = adjustedH;
            } else if (adjustedH <= oldH) {
              console.log(`[resize] Content tight-fit (${layoutMode}): content didn't grow, reverting to original ${oldH}px`);
              if (r.minHeight !== void 0) r.minHeight = null;
              resizable.resize(newW, oldH);
              r.minHeight = oldH;
            }
          }
        }
      } catch (_e) {
      }
    }
    const actualDH = resizable.height - oldH;
    const actualDW = resizable.width - oldW;
    console.log(`[resize] Actual measured delta: dW=${actualDW} dH=${actualDH} (frame is now ${resizable.width}x${resizable.height})`);
    if (actualDH !== 0 || actualDW !== 0) {
      let current = resizable;
      let runningDH = actualDH;
      let runningDW = actualDW;
      for (let depth = 0; depth < 10; depth++) {
        const par = current.parent;
        if (!par || par.type === "PAGE" || par.type === "DOCUMENT") break;
        const parAny = par;
        const parLayout = "layoutMode" in par ? parAny.layoutMode : "NONE";
        if (parLayout !== "NONE") {
          if ("resize" in par) {
            const pf = par;
            const isHoriz = parLayout === "HORIZONTAL";
            if (isHoriz) {
              const padT = parAny.paddingTop || 0;
              const padB = parAny.paddingBottom || 0;
              const availH = pf.height - padT - padB;
              const overflow = current.height - availH;
              if (overflow > 0 && (parAny.layoutSizingVertical === "FIXED" || parAny.counterAxisSizingMode === "FIXED")) {
                console.log(`[resize] HORIZONTAL ancestor "${pf.name}": child ${current.height}px overflows avail ${availH}px by ${overflow}px \u2192 grow ${pf.height} \u2192 ${pf.height + overflow}`);
                if (parAny.minHeight !== void 0) parAny.minHeight = null;
                pf.resize(pf.width, pf.height + overflow);
                if (parAny.minHeight !== void 0) parAny.minHeight = pf.height;
                runningDH = overflow;
              } else {
                console.log(`[resize] HORIZONTAL ancestor "${pf.name}": child ${current.height}px fits in avail ${availH}px \u2014 no growth needed`);
                runningDH = 0;
              }
            } else {
              if (runningDH > 0 && (parAny.layoutSizingVertical === "FIXED" || parAny.primaryAxisSizingMode === "FIXED")) {
                console.log(`[resize] VERTICAL ancestor "${pf.name}": grow ${pf.height} \u2192 ${pf.height + runningDH}`);
                if (parAny.minHeight !== void 0) parAny.minHeight = null;
                pf.resize(pf.width, pf.height + runningDH);
                if (parAny.minHeight !== void 0) parAny.minHeight = pf.height;
              }
            }
          }
          current = par;
          continue;
        }
        if (runningDH === 0 && runningDW === 0) {
          current = par;
          continue;
        }
        if ("children" in par) {
          const siblings = parAny.children;
          const sorted = siblings.slice().sort((a, b) => a.y - b.y);
          const idx = sorted.findIndex((s) => s.id === current.id);
          for (let i = idx + 1; i < sorted.length; i++) {
            const sib = sorted[i];
            console.log(`[resize] Shifting "${sib.name}" y: ${sib.y} \u2192 ${sib.y + runningDH} (at ancestor "${par.name}")`);
            sib.y += runningDH;
          }
        }
        if ("resize" in par) {
          const pf = par;
          const grewH = runningDH > 0 ? runningDH : 0;
          const grewW = runningDW > 0 ? runningDW : 0;
          if (grewH > 0 || grewW > 0) {
            console.log(`[resize] Growing ancestor "${pf.name}" ${pf.width}x${pf.height} \u2192 ${pf.width + grewW}x${pf.height + grewH}`);
            pf.resize(pf.width + grewW, pf.height + grewH);
          }
        }
        current = par;
      }
    }
    for (const snap of gapSnapshots) {
      const snapParent = figma.getNodeById(snap.parentId);
      const snapNode = figma.getNodeById(snap.nodeId);
      if (!snapParent || !snapNode || !("children" in snapParent)) continue;
      const sibs = snapParent.children.slice().sort((a, b) => a.y - b.y);
      const idx = sibs.findIndex((s) => s.id === snap.nodeId);
      if (idx < 0) continue;
      for (let i = 0; i < snap.gaps.length; i++) {
        const gapInfo = snap.gaps[i];
        const sib = figma.getNodeById(gapInfo.sibId);
        if (!sib) continue;
        const prev = i === 0 ? snapNode : figma.getNodeById(snap.gaps[i - 1].sibId);
        if (!prev) continue;
        const prevBottom = prev.y + prev.height;
        const expectedY = prevBottom + gapInfo.gap;
        if (Math.abs(sib.y - expectedY) > 0.5) {
          console.log(`[resize] Gap correction: "${sib.name}" y: ${sib.y} \u2192 ${expectedY} (gap=${gapInfo.gap}px after "${prev.name}")`);
          sib.y = expectedY;
        }
      }
      if ("resize" in snapParent) {
        const pf = snapParent;
        const lastChild = sibs[sibs.length - 1];
        const neededH = lastChild.y + lastChild.height - sibs[0].y + (sibs[0].y - 0);
        const bottomEdge = lastChild.y + lastChild.height;
        if (bottomEdge > pf.height) {
          console.log(`[resize] Gap correction: growing "${pf.name}" ${pf.height} \u2192 ${bottomEdge}`);
          pf.resize(pf.width, bottomEdge);
        }
      }
    }
    {
      let cur = resizable;
      for (let d = 0; d < 15; d++) {
        const p = cur.parent;
        if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
        if ("children" in p && "resize" in p) {
          const pf = p;
          const pAny = p;
          const kids = pAny.children;
          let maxBottom = 0;
          let maxRight = 0;
          for (const kid of kids) {
            const kidBottom = kid.y + kid.height;
            const kidRight = kid.x + kid.width;
            if (kidBottom > maxBottom) maxBottom = kidBottom;
            if (kidRight > maxRight) maxRight = kidRight;
          }
          const padB = pAny.paddingBottom || 0;
          const padR = pAny.paddingRight || 0;
          const neededH = maxBottom + padB;
          const neededW = maxRight + padR;
          let grew = false;
          let finalW = pf.width;
          let finalH = pf.height;
          if (neededH > pf.height + 0.5) {
            finalH = neededH;
            grew = true;
          }
          if (neededW > pf.width + 0.5) {
            finalW = neededW;
            grew = true;
          }
          if (grew) {
            console.log(`[resize] Fit-content: growing "${pf.name}" ${pf.width}x${pf.height} \u2192 ${finalW}x${finalH}`);
            if (pAny.minHeight !== void 0) pAny.minHeight = null;
            if (pAny.minWidth !== void 0) pAny.minWidth = null;
            pf.resize(finalW, finalH);
          }
        }
        cur = p;
      }
    }
    console.log(`[resize] AFTER: width=${resizable.width} height=${resizable.height}`);
    figma.currentPage.selection = [resizable];
    figma.viewport.scrollAndZoomIntoView([resizable]);
    console.log(`[resize] Done`);
  }
  function applyMoveNode(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    const movable = node;
    movable.x = op.x;
    movable.y = op.y;
  }
  function applyCloneNode(op) {
    const sourceNode = figma.getNodeById(op.nodeId);
    if (!sourceNode) {
      throw new Error(`Source node ${op.nodeId} not found`);
    }
    const parentNode = figma.getNodeById(op.parentId);
    if (!parentNode) {
      throw new Error(`Parent node ${op.parentId} not found`);
    }
    if (!("children" in parentNode)) {
      throw new Error(`Parent node ${op.parentId} (${parentNode.type}) cannot have children`);
    }
    const source = sourceNode;
    const parent = parentNode;
    const parentOldH = parent.height;
    const clone = source.clone();
    if (op.insertIndex !== void 0 && op.insertIndex < parent.children.length) {
      parent.insertChild(op.insertIndex, clone);
    } else {
      parent.appendChild(clone);
    }
    const pAny = parent;
    const pLayout = "layoutMode" in parent ? pAny.layoutMode : "NONE";
    if (pLayout === "NONE") {
      const allSibs = pAny.children;
      const sortedSibs = allSibs.filter((c) => c.id !== clone.id).slice().sort((a, b) => a.y - b.y);
      const gaps = [];
      for (let i = 1; i < sortedSibs.length; i++) {
        const prevBottom = sortedSibs[i - 1].y + sortedSibs[i - 1].height;
        const gap = sortedSibs[i].y - prevBottom;
        if (gap > 0) gaps.push(gap);
      }
      let typicalGap = 0;
      if (gaps.length > 0) {
        const rounded = gaps.map((g) => Math.round(g));
        const counts = /* @__PURE__ */ new Map();
        for (const g of rounded) counts.set(g, (counts.get(g) || 0) + 1);
        let bestGap = rounded[0];
        let bestCount = 0;
        for (const [g, c] of counts) {
          if (c > bestCount) {
            bestCount = c;
            bestGap = g;
          }
        }
        typicalGap = bestGap;
      }
      console.log(`[clone] Detected typical gap between siblings: ${typicalGap}px (from ${gaps.length} pairs: ${gaps.map((g) => Math.round(g)).join(",")})`);
      clone.x = source.x;
      clone.y = source.y + source.height + typicalGap;
      console.log(`[clone] Positioned clone at y=${clone.y} (source bottom=${source.y + source.height}, gap=${typicalGap})`);
      const shiftAmount = clone.height + typicalGap;
      for (const sib of allSibs) {
        if (sib.id === clone.id || sib.id === source.id) continue;
        if (sib.y >= clone.y - 0.5) {
          console.log(`[clone] Shifting sibling "${sib.name}" y: ${sib.y} \u2192 ${sib.y + shiftAmount}`);
          sib.y += shiftAmount;
        }
      }
      const lastChild = allSibs.reduce((max, c) => c.y + c.height > max.y + max.height ? c : max, allSibs[0]);
      const padB = pAny.paddingBottom || 0;
      const neededH = lastChild.y + lastChild.height + padB;
      if (neededH > parent.height + 0.5) {
        console.log(`[clone] Growing parent "${parent.name}" ${parent.height} \u2192 ${neededH}`);
        if (pAny.minHeight !== void 0) pAny.minHeight = null;
        parent.resize(parent.width, neededH);
      }
    }
    let cur = parent;
    let shiftDelta = parent.height - parentOldH;
    console.log(`[clone] Parent grew by ${shiftDelta}px (${parentOldH} \u2192 ${parent.height})`);
    for (let d = 0; d < 15; d++) {
      if (shiftDelta < 0.5) break;
      const p = cur.parent;
      if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
      if (!("children" in p) || !("resize" in p)) {
        cur = p;
        continue;
      }
      const pf = p;
      const ppAny = p;
      const ppLayout = "layoutMode" in p ? ppAny.layoutMode : "NONE";
      if (ppLayout === "NONE") {
        const sibs = ppAny.children;
        const curOldBottom = cur.y + cur.height - shiftDelta;
        for (const sib of sibs) {
          if (sib.id === cur.id) continue;
          if (sib.y >= curOldBottom - 0.5) {
            console.log(`[clone] Shifting "${sib.name}" y: ${sib.y} \u2192 ${sib.y + shiftDelta} (at "${pf.name}")`);
            sib.y += shiftDelta;
          }
        }
      }
      const kids = ppAny.children;
      let maxBottom = 0;
      for (const kid of kids) {
        const kb = kid.y + kid.height;
        if (kb > maxBottom) maxBottom = kb;
      }
      const ppPadB = ppAny.paddingBottom || 0;
      const ppNeededH = maxBottom + ppPadB;
      const oldAncH = pf.height;
      if (ppNeededH > pf.height + 0.5) {
        console.log(`[clone] Growing ancestor "${pf.name}" ${pf.height} \u2192 ${ppNeededH}`);
        if (ppAny.minHeight !== void 0) ppAny.minHeight = null;
        pf.resize(pf.width, ppNeededH);
      }
      shiftDelta = pf.height - oldAncH;
      cur = p;
    }
    console.log(`[clone] Cloned "${source.name}" (${source.id}) \u2192 "${clone.name}" (${clone.id}) into "${parent.name}" (${parent.id})`);
  }
  function applyDeleteNode(op) {
    const targetNode = figma.getNodeById(op.nodeId);
    if (!targetNode) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    const target = targetNode;
    const parent = target.parent;
    if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") {
      console.log(`[delete] Removing top-level node "${target.name}" (${target.id})`);
      target.remove();
      return;
    }
    if (!("children" in parent) || !("resize" in parent)) {
      console.log(`[delete] Removing "${target.name}" from non-frame parent "${parent.name}"`);
      target.remove();
      return;
    }
    const pf = parent;
    const pAny = parent;
    const pLayout = "layoutMode" in parent ? pAny.layoutMode : "NONE";
    const targetY = target.y;
    const targetH = target.height;
    const parentOldH = pf.height;
    let gapToClose = targetH;
    if (pLayout === "NONE") {
      const allSibs = pAny.children;
      const sortedSibs = allSibs.filter((c) => c.id !== target.id).slice().sort((a, b) => a.y - b.y);
      const allSorted = allSibs.slice().sort((a, b) => a.y - b.y);
      const targetIdx = allSorted.findIndex((s) => s.id === target.id);
      const sibAbove = targetIdx > 0 ? allSorted[targetIdx - 1] : null;
      const sibBelow = targetIdx < allSorted.length - 1 ? allSorted[targetIdx + 1] : null;
      let gapAbove = 0;
      if (sibAbove) {
        gapAbove = target.y - (sibAbove.y + sibAbove.height);
        if (gapAbove < 0) gapAbove = 0;
      }
      let gapBelow = 0;
      if (sibBelow) {
        gapBelow = sibBelow.y - (target.y + target.height);
        if (gapBelow < 0) gapBelow = 0;
      }
      gapToClose = targetH + gapBelow;
      console.log(`[delete] Target "${target.name}" y=${targetY} h=${targetH} gapAbove=${gapAbove} gapBelow=${gapBelow} \u2192 shifting siblings up by ${gapToClose}px`);
      const targetName = target.name;
      target.remove();
      console.log(`[delete] Removed "${targetName}"`);
      const remainingSibs = pAny.children;
      for (const sib of remainingSibs) {
        if (sib.y >= targetY + targetH - 0.5) {
          console.log(`[delete] Shifting sibling "${sib.name}" y: ${Math.round(sib.y)} \u2192 ${Math.round(sib.y - gapToClose)}`);
          sib.y -= gapToClose;
        }
      }
      const kids = pAny.children;
      if (kids.length === 0) {
        console.log(`[delete] Parent "${pf.name}" is now empty`);
      } else {
        let maxBottom = 0;
        for (const kid of kids) {
          const kb = kid.y + kid.height;
          if (kb > maxBottom) maxBottom = kb;
        }
        const padB = pAny.paddingBottom || 0;
        const neededH = maxBottom + padB;
        if (neededH < pf.height - 0.5) {
          console.log(`[delete] Shrinking parent "${pf.name}" ${Math.round(pf.height)} \u2192 ${Math.round(neededH)}`);
          if (pAny.minHeight !== void 0) pAny.minHeight = null;
          pf.resize(pf.width, neededH);
        }
      }
    } else {
      console.log(`[delete] Removing "${target.name}" from auto-layout parent "${pf.name}"`);
      target.remove();
      return;
    }
    let cur = pf;
    let shrinkDelta = parentOldH - pf.height;
    console.log(`[delete] Parent shrank by ${Math.round(shrinkDelta)}px (${Math.round(parentOldH)} \u2192 ${Math.round(pf.height)})`);
    for (let d = 0; d < 15; d++) {
      if (shrinkDelta < 0.5) break;
      const p = cur.parent;
      if (!p || p.type === "PAGE" || p.type === "DOCUMENT") break;
      if (!("children" in p) || !("resize" in p)) {
        cur = p;
        continue;
      }
      const ancFrame = p;
      const ancAny = p;
      const ancLayout = "layoutMode" in p ? ancAny.layoutMode : "NONE";
      if (ancLayout === "NONE") {
        const sibs = ancAny.children;
        const curBottom = cur.y + cur.height;
        for (const sib of sibs) {
          if (sib.id === cur.id) continue;
          if (sib.y >= curBottom + shrinkDelta - 0.5) {
            console.log(`[delete] Shifting "${sib.name}" y: ${Math.round(sib.y)} \u2192 ${Math.round(sib.y - shrinkDelta)} (at "${ancFrame.name}")`);
            sib.y -= shrinkDelta;
          }
        }
      }
      const kids = ancAny.children;
      let maxBottom = 0;
      for (const kid of kids) {
        const kb = kid.y + kid.height;
        if (kb > maxBottom) maxBottom = kb;
      }
      const ancPadB = ancAny.paddingBottom || 0;
      const neededH = maxBottom + ancPadB;
      const oldAncH = ancFrame.height;
      if (neededH < ancFrame.height - 0.5) {
        console.log(`[delete] Shrinking ancestor "${ancFrame.name}" ${Math.round(ancFrame.height)} \u2192 ${Math.round(neededH)}`);
        if (ancAny.minHeight !== void 0) ancAny.minHeight = null;
        ancFrame.resize(ancFrame.width, neededH);
      }
      shrinkDelta = oldAncH - ancFrame.height;
      cur = p;
    }
  }
  function applySetFillColor(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (!("fills" in node)) {
      throw new Error(`Node ${op.nodeId} (${node.type}) does not support fills`);
    }
    const hex = op.color.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const fill = {
      type: "SOLID",
      color: { r, g, b },
      opacity: 1
    };
    node.fills = [fill];
    console.log(`[setFillColor] Set "${node.name}" fill to ${op.color}`);
  }
  function applySetLayoutMode(op) {
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (!("layoutMode" in node)) {
      throw new Error(`Node ${op.nodeId} (${node.type}) does not support auto-layout`);
    }
    const frame = node;
    frame.layoutMode = op.layoutMode;
    if (op.wrap !== void 0 && "layoutWrap" in frame) {
      frame.layoutWrap = op.wrap ? "WRAP" : "NO_WRAP";
    }
    console.log(`[setLayoutMode] Set "${frame.name}" layoutMode to ${op.layoutMode}${op.wrap ? " (wrap)" : ""}`);
  }
  function applySetLayoutProps(op) {
    var _a, _b, _c, _d;
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (!("layoutMode" in node)) {
      throw new Error(`Node ${op.nodeId} (${node.type}) does not support auto-layout`);
    }
    const frame = node;
    if (op.paddingTop !== void 0) frame.paddingTop = op.paddingTop;
    if (op.paddingRight !== void 0) frame.paddingRight = op.paddingRight;
    if (op.paddingBottom !== void 0) frame.paddingBottom = op.paddingBottom;
    if (op.paddingLeft !== void 0) frame.paddingLeft = op.paddingLeft;
    if (op.itemSpacing !== void 0) frame.itemSpacing = op.itemSpacing;
    if (op.counterAxisSpacing !== void 0 && "counterAxisSpacing" in frame) {
      frame.counterAxisSpacing = op.counterAxisSpacing;
    }
    const changes = [];
    if (op.paddingTop !== void 0 || op.paddingRight !== void 0 || op.paddingBottom !== void 0 || op.paddingLeft !== void 0) {
      changes.push(`padding: ${(_a = op.paddingTop) != null ? _a : frame.paddingTop}/${(_b = op.paddingRight) != null ? _b : frame.paddingRight}/${(_c = op.paddingBottom) != null ? _c : frame.paddingBottom}/${(_d = op.paddingLeft) != null ? _d : frame.paddingLeft}`);
    }
    if (op.itemSpacing !== void 0) changes.push(`itemSpacing: ${op.itemSpacing}`);
    if (op.counterAxisSpacing !== void 0) changes.push(`counterAxisSpacing: ${op.counterAxisSpacing}`);
    console.log(`[setLayoutProps] Set "${frame.name}" ${changes.join(", ")}`);
  }
  function applySetSizeMode(op) {
    var _a, _b;
    const node = figma.getNodeById(op.nodeId);
    if (!node) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    if (!("layoutSizingHorizontal" in node)) {
      throw new Error(`Node ${op.nodeId} (${node.type}) does not support layout sizing`);
    }
    const frame = node;
    const parent = node.parent;
    const parentAny = parent;
    const parentHasAutoLayout = parent && "layoutMode" in parent && (parentAny.layoutMode === "VERTICAL" || parentAny.layoutMode === "HORIZONTAL");
    if (op.horizontal !== void 0) {
      if ((op.horizontal === "FILL" || op.horizontal === "HUG") && !parentHasAutoLayout) {
        console.log(`[setSizeMode] Skipping H=${op.horizontal} on "${frame.name}" \u2014 parent has no auto-layout`);
      } else {
        frame.layoutSizingHorizontal = op.horizontal;
      }
    }
    if (op.vertical !== void 0) {
      if ((op.vertical === "FILL" || op.vertical === "HUG") && !parentHasAutoLayout) {
        console.log(`[setSizeMode] Skipping V=${op.vertical} on "${frame.name}" \u2014 parent has no auto-layout`);
      } else {
        frame.layoutSizingVertical = op.vertical;
      }
    }
    console.log(`[setSizeMode] Set "${frame.name}" sizing: H=${(_a = op.horizontal) != null ? _a : "unchanged"}, V=${(_b = op.vertical) != null ? _b : "unchanged"}`);
  }
  function hexToRgb01(hex) {
    const h = hex.replace("#", "");
    return {
      r: parseInt(h.substring(0, 2), 16) / 255,
      g: parseInt(h.substring(2, 4), 16) / 255,
      b: parseInt(h.substring(4, 6), 16) / 255
    };
  }
  function rgbToHex(r, g, b) {
    const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
  }
  function relativeLuminance(r, g, b) {
    const srgb = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  }
  function contrastRatio(hexA, hexB) {
    const a = hexToRgb01(hexA);
    const b = hexToRgb01(hexB);
    const lA = relativeLuminance(a.r, a.g, a.b);
    const lB = relativeLuminance(b.r, b.g, b.b);
    const lighter = Math.max(lA, lB);
    const darker = Math.min(lA, lB);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function getEffectiveBackground(node) {
    let cur = node.parent;
    while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
      if ("fills" in cur) {
        try {
          const fills = cur.fills;
          if (Array.isArray(fills)) {
            for (let i = fills.length - 1; i >= 0; i--) {
              const f = fills[i];
              if (f.type === "SOLID" && (f.visible === void 0 || f.visible)) {
                return rgbToHex(f.color.r, f.color.g, f.color.b);
              }
            }
          }
        } catch (_e) {
        }
      }
      cur = cur.parent;
    }
    return null;
  }
  function getNodeFillHex(node) {
    if (!("fills" in node)) return null;
    try {
      const fills = node.fills;
      if (!Array.isArray(fills)) return null;
      for (let i = fills.length - 1; i >= 0; i--) {
        const f = fills[i];
        if (f.type === "SOLID" && (f.visible === void 0 || f.visible)) {
          return rgbToHex(f.color.r, f.color.g, f.color.b);
        }
      }
    } catch (_e) {
    }
    return null;
  }
  function isDark(hex) {
    const { r, g, b } = hexToRgb01(hex);
    return relativeLuminance(r, g, b) < 0.4;
  }
  function fixContrastRecursive(root) {
    let fixes = 0;
    const MINIMUM_CONTRAST = 4.5;
    const ICON_TYPES = /* @__PURE__ */ new Set([
      "VECTOR",
      "BOOLEAN_OPERATION",
      "STAR",
      "LINE",
      "ELLIPSE",
      "POLYGON"
    ]);
    function getNodeStrokeHex(node) {
      if (!("strokes" in node)) return null;
      try {
        const strokes = node.strokes;
        if (!Array.isArray(strokes)) return null;
        for (let i = strokes.length - 1; i >= 0; i--) {
          const s = strokes[i];
          if (s.type === "SOLID" && (s.visible === void 0 || s.visible)) {
            return rgbToHex(s.color.r, s.color.g, s.color.b);
          }
        }
      } catch (_e) {
      }
      return null;
    }
    function fixNodeContrast(node, label) {
      const bgHex = getEffectiveBackground(node) || "#FFFFFF";
      const fillHex = getNodeFillHex(node);
      if (fillHex) {
        const ratio = contrastRatio(fillHex, bgHex);
        if (ratio < MINIMUM_CONTRAST) {
          const newColor = isDark(bgHex) ? "#FFFFFF" : "#1A1A1A";
          const newRatio = contrastRatio(newColor, bgHex);
          if (newRatio > ratio) {
            const { r, g, b } = hexToRgb01(newColor);
            node.fills = [{ type: "SOLID", color: { r, g, b }, opacity: 1 }];
            console.log(
              `[contrastFix] Fixed ${label} fill "${node.name}": ${fillHex} on ${bgHex} (ratio ${ratio.toFixed(1)}) \u2192 ${newColor} (ratio ${newRatio.toFixed(1)})`
            );
            fixes++;
          }
        }
      }
      const strokeHex = getNodeStrokeHex(node);
      if (strokeHex) {
        const ratio = contrastRatio(strokeHex, bgHex);
        if (ratio < MINIMUM_CONTRAST) {
          const newColor = isDark(bgHex) ? "#FFFFFF" : "#1A1A1A";
          const newRatio = contrastRatio(newColor, bgHex);
          if (newRatio > ratio) {
            const { r, g, b } = hexToRgb01(newColor);
            node.strokes = [{ type: "SOLID", color: { r, g, b }, opacity: 1 }];
            console.log(
              `[contrastFix] Fixed ${label} stroke "${node.name}": ${strokeHex} on ${bgHex} (ratio ${ratio.toFixed(1)}) \u2192 ${newColor} (ratio ${newRatio.toFixed(1)})`
            );
            fixes++;
          }
        }
      }
    }
    function walk(node) {
      if (node.type === "TEXT") {
        fixNodeContrast(node, "text");
      } else if (ICON_TYPES.has(node.type)) {
        fixNodeContrast(node, "icon");
      }
      if ("children" in node) {
        for (const child of node.children) {
          walk(child);
        }
      }
    }
    walk(root);
    return fixes;
  }
  function detectResponsiveType(intent) {
    const lower = intent.toLowerCase();
    if (/desktop|wide|full.?screen|large.?screen|laptop|web\s*layout|widescreen/i.test(lower)) {
      return "mobile-to-desktop";
    }
    if (/mobile|phone|narrow|small.?screen|compact|smartphone/i.test(lower)) {
      return "desktop-to-mobile";
    }
    return null;
  }
  function parseLayoutPrefs(intent) {
    const lower = intent.toLowerCase();
    let searchPlacement = "auto";
    if (/search.*(below|under|second row|row 2|separate row)/i.test(lower)) {
      searchPlacement = "below-header";
    } else if (/search.*(in|same|header row|nav row|top row|inline)/i.test(lower)) {
      searchPlacement = "header";
    }
    console.log(`[prefs] Parsed layout prefs from intent: searchPlacement=${searchPlacement}`);
    return { searchPlacement };
  }
  async function preProcessDesktopLayout(root, targetWidth, prefs) {
    if (!("children" in root)) return;
    const effectiveRoot = findEffectiveRoot(root);
    console.log(`[preProcess] Root "${root.name}" \u2192 effective root "${effectiveRoot.name}" (${effectiveRoot.children.length} children)`);
    let cur = root;
    while (cur && "children" in cur) {
      const f = cur;
      if ("clipsContent" in f) f.clipsContent = true;
      if ("layoutMode" in f) {
        const fAny = f;
        if (fAny.layoutMode === "NONE") {
          fAny.layoutMode = "VERTICAL";
          console.log(`[preProcess] Set "${f.name}" layoutMode to VERTICAL (was NONE)`);
        }
      }
      if (cur !== root && "layoutSizingHorizontal" in f) {
        const fAny2 = f;
        if (fAny2.layoutSizingHorizontal !== "FILL") {
          try {
            fAny2.layoutSizingHorizontal = "FILL";
            console.log(`[preProcess] Set "${f.name}" wrapper horizontal sizing to FILL`);
          } catch (e) {
            console.warn(`[preProcess] Could not set FILL on wrapper "${f.name}": ${e.message}`);
          }
        }
      }
      if (cur === effectiveRoot) break;
      if (f.children.length === 1) {
        cur = f.children[0];
      } else break;
    }
    await moveBottomNavToTop(effectiveRoot);
    const layoutPrefs = prefs || { searchPlacement: "auto" };
    await mergeHeaderIntoNav(effectiveRoot, layoutPrefs);
    const erAny = effectiveRoot;
    const erHasAutoLayout = "layoutMode" in effectiveRoot && (erAny.layoutMode === "VERTICAL" || erAny.layoutMode === "HORIZONTAL");
    for (const child of effectiveRoot.children) {
      if (erHasAutoLayout && "layoutSizingHorizontal" in child) {
        const childAny = child;
        if (childAny.layoutSizingHorizontal !== "FILL") {
          try {
            console.log(`[preProcess] Setting "${child.name}" horizontal sizing to FILL (was ${childAny.layoutSizingHorizontal})`);
            childAny.layoutSizingHorizontal = "FILL";
          } catch (e) {
            console.warn(`[preProcess] Could not set FILL on "${child.name}": ${e.message}`);
          }
        }
      }
      if ("clipsContent" in child) {
        child.clipsContent = true;
      }
    }
    applyDesktopPadding(effectiveRoot);
    convertCardListsToGrid(effectiveRoot, targetWidth);
    await transformHeroSections(effectiveRoot, targetWidth);
    recursivelySetFill(effectiveRoot, 0);
  }
  function findEffectiveRoot(frame) {
    let current = frame;
    while (current.children.length === 1) {
      const only = current.children[0];
      if (!("children" in only) || only.type === "TEXT") break;
      if (only.type !== "FRAME" && only.type !== "GROUP" && only.type !== "COMPONENT" && only.type !== "COMPONENT_SET") break;
      console.log(`[preProcess] Drilling: "${current.name}" \u2192 "${only.name}" (${only.children.length} children)`);
      current = only;
    }
    return current;
  }
  async function moveBottomNavToTop(rootFrame) {
    const children = rootFrame.children;
    if (children.length < 2) return;
    let bestScore = 0;
    let bestIndex = -1;
    let bestNode = null;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!("children" in child)) continue;
      let score = 0;
      const childAny = child;
      const childFrame = child;
      const name = child.name.toLowerCase();
      const isHorizontal = "layoutMode" in child && childAny.layoutMode === "HORIZONTAL";
      const isShort = child.height < 120;
      if (/nav|tab.?bar|bottom.?bar|toolbar/i.test(name)) {
        score += 10;
      }
      if (/\bmenu\b/i.test(name) && !/food|drink|coffee|item/i.test(name)) {
        score += 6;
      }
      let navWordCount = 0;
      try {
        const allText = childFrame.findAll((n) => n.type === "TEXT");
        const navWords = /\b(home|explore|search|orders|favorites|profile|browse|settings|account|discover|cart|shop|menu|feed|inbox|notifications|activity|library|saved)\b/i;
        navWordCount = allText.filter((t) => navWords.test(t.characters)).length;
        if (navWordCount >= 4) score += 10;
        else if (navWordCount >= 3) score += 8;
        else if (navWordCount >= 2) score += 5;
      } catch (_e) {
      }
      if (isHorizontal && isShort) {
        score += 3;
        const navKids = childFrame.children;
        if (navKids.length >= 3 && navKids.length <= 7) {
          const heights = navKids.map((k) => k.height);
          const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
          const allSimilar = heights.every((h) => Math.abs(h - avgH) < avgH * 0.4);
          if (allSimilar) score += 3;
        }
      } else if (isShort) {
        score += 1;
      }
      if (i >= children.length - 2) score += 3;
      else if (i >= children.length - 4) score += 1;
      console.log(`[navDetect] "${child.name}" i=${i} score=${score} (navWords=${navWordCount}, horiz=${isHorizontal}, short=${isShort})`);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
        bestNode = child;
      }
    }
    if (!bestNode || bestScore < 5) {
      console.log(`[preProcess] No nav detected (best score=${bestScore}) \u2014 skipping`);
      return;
    }
    console.log(`[preProcess] \u2713 Nav found: "${bestNode.name}" score=${bestScore} at index ${bestIndex}/${children.length - 1}`);
    try {
      rootFrame.insertChild(0, bestNode);
      console.log(`[preProcess] Moved "${bestNode.name}" to index 0`);
      const navFrame = bestNode;
      const navAny = navFrame;
      if ("layoutMode" in bestNode) {
        navAny.layoutMode = "HORIZONTAL";
      }
      if ("layoutSizingVertical" in bestNode) {
        navAny.layoutSizingVertical = "HUG";
      }
      const parentAny = rootFrame;
      const parentHasAL = "layoutMode" in rootFrame && (parentAny.layoutMode === "VERTICAL" || parentAny.layoutMode === "HORIZONTAL");
      if (parentHasAL && "layoutSizingHorizontal" in bestNode) {
        try {
          navAny.layoutSizingHorizontal = "FILL";
        } catch (e) {
          console.warn(`[preProcess] Could not set nav FILL: ${e.message}`);
        }
      }
      if ("layoutMode" in bestNode) {
        navAny.paddingLeft = 48;
        navAny.paddingRight = 48;
        navAny.paddingTop = 12;
        navAny.paddingBottom = 12;
        navAny.itemSpacing = 12;
      }
      if ("layoutWrap" in bestNode) {
        navAny.layoutWrap = "WRAP";
        if ("counterAxisSpacing" in bestNode) {
          navAny.counterAxisSpacing = 8;
        }
      }
      if ("counterAxisAlignItems" in bestNode) {
        navAny.counterAxisAlignItems = "CENTER";
      }
      if ("primaryAxisAlignItems" in bestNode) {
        navAny.primaryAxisAlignItems = "SPACE_BETWEEN";
      }
      if ("children" in bestNode) {
        let navItems = navFrame.children;
        if (navItems.length === 1 && "children" in navItems[0] && navItems[0].type !== "TEXT") {
          const wrapper = navItems[0];
          const wAny = wrapper;
          console.log(`[preProcess] Nav has single wrapper child "${wrapper.name}" (${wrapper.children.length} children) \u2014 drilling into it`);
          if ("layoutMode" in wrapper) {
            wAny.layoutMode = "HORIZONTAL";
            wAny.itemSpacing = 32;
            if ("counterAxisAlignItems" in wrapper) wAny.counterAxisAlignItems = "CENTER";
            if ("primaryAxisAlignItems" in wrapper) wAny.primaryAxisAlignItems = "SPACE_BETWEEN";
          }
          try {
            if ("layoutSizingHorizontal" in wrapper) wAny.layoutSizingHorizontal = "FILL";
          } catch (_e) {
          }
          navItems = wrapper.children;
        }
        for (const navChild of navItems) {
          if (!("layoutMode" in navChild) && !("children" in navChild)) continue;
          const itemAny = navChild;
          const itemFrame = navChild;
          if ("layoutMode" in navChild && itemAny.layoutMode === "NONE") {
            itemAny.layoutMode = "HORIZONTAL";
            console.log(`[preProcess] Set nav item "${navChild.name}" to HORIZONTAL (was NONE)`);
          } else if ("layoutMode" in navChild && itemAny.layoutMode === "VERTICAL" && "children" in navChild && itemFrame.children.length >= 2) {
            itemAny.layoutMode = "HORIZONTAL";
            console.log(`[preProcess] Set nav item "${navChild.name}" to HORIZONTAL (was VERTICAL)`);
          }
          try {
            if ("layoutSizingHorizontal" in navChild) {
              itemAny.layoutSizingHorizontal = "HUG";
            }
            if ("layoutSizingVertical" in navChild) {
              itemAny.layoutSizingVertical = "HUG";
            }
          } catch (e) {
            console.warn(`[preProcess] Could not set HUG on "${navChild.name}": ${e.message}`);
          }
          if ("layoutMode" in navChild) {
            itemAny.itemSpacing = 8;
            itemAny.paddingTop = 0;
            itemAny.paddingBottom = 0;
            if ("counterAxisAlignItems" in navChild) {
              itemAny.counterAxisAlignItems = "CENTER";
            }
          }
          if ("children" in navChild) {
            for (const item of itemFrame.children) {
              if (item.type === "TEXT") {
                try {
                  const textNode = item;
                  const currentSize = typeof textNode.fontSize === "number" ? textNode.fontSize : 12;
                  if (currentSize < 14) {
                    if (textNode.fontName && typeof textNode.fontName === "object" && "family" in textNode.fontName) {
                      await figma.loadFontAsync(textNode.fontName).catch(() => {
                      });
                      textNode.fontSize = 14;
                    }
                  }
                } catch (_e) {
                }
              }
            }
          }
        }
      }
      console.log(`[preProcess] Desktop nav styling applied to "${bestNode.name}"`);
    } catch (err) {
      console.warn(`[preProcess] Failed to process nav: ${err.message}`);
    }
  }
  async function mergeHeaderIntoNav(rootFrame, prefs) {
    if (rootFrame.children.length < 3) return;
    const navSection = rootFrame.children[0];
    if (!("children" in navSection)) return;
    let navContainer = navSection;
    if (navContainer.children.length === 1 && "children" in navContainer.children[0] && navContainer.children[0].type !== "TEXT") {
      navContainer = navContainer.children[0];
    }
    console.log(`[headerMerge] Nav container: "${navContainer.name}" with ${navContainer.children.length} children`);
    function findIconNodes(parent, depth, maxDepth) {
      const icons = [];
      if (depth >= maxDepth) return icons;
      for (const child of parent.children) {
        if (child.type === "TEXT") continue;
        if (child.width <= 48 && child.height <= 48) {
          icons.push(child);
          continue;
        }
        if ("children" in child) {
          icons.push(...findIconNodes(child, depth + 1, maxDepth));
        }
      }
      return icons;
    }
    function isCompanionSection(section) {
      const allText = section.findAll((n) => n.type === "TEXT");
      const hasCompanionText = allText.some(
        (t) => /filter|sort|setting|refine|adjust|tune/i.test(t.characters)
      );
      if (hasCompanionText) return true;
      if (section.height <= 60 && section.width <= 80 && section.children.length <= 3) {
        return true;
      }
      if (section.children.length === 1) {
        const only = section.children[0];
        if (only.width <= 48 && only.height <= 48) return true;
      }
      return false;
    }
    const searchSections = [];
    const companionSections = [];
    const iconNodes = [];
    for (let i = 1; i < Math.min(5, rootFrame.children.length); i++) {
      const section = rootFrame.children[i];
      if (!("children" in section)) continue;
      const sFrame = section;
      console.log(`[headerMerge] Scanning section i=${i} "${sFrame.name}" h=${Math.round(sFrame.height)} w=${Math.round(sFrame.width)} children=${sFrame.children.length}`);
      if (sFrame.height > 200) {
        console.log(`[headerMerge] Section too tall (${Math.round(sFrame.height)}px) \u2014 stopping scan`);
        break;
      }
      const allText = sFrame.findAll((n) => n.type === "TEXT");
      const isSearch = allText.some((t) => /search/i.test(t.characters));
      if (isSearch) {
        searchSections.push(sFrame);
        if ("children" in sFrame) {
          console.log(`[headerMerge] \u2192 Identified as SEARCH section with children: ${sFrame.children.map((c) => `"${c.name}" ${c.type} ${Math.round(c.width)}\xD7${Math.round(c.height)}`).join(", ")}`);
        }
        const nextIdx = i + 1;
        if (nextIdx < rootFrame.children.length) {
          const nextSection = rootFrame.children[nextIdx];
          if ("children" in nextSection) {
            const nextFrame = nextSection;
            if (nextFrame.height <= 200 && isCompanionSection(nextFrame)) {
              companionSections.push(nextFrame);
              console.log(`[headerMerge] \u2192 Found COMPANION section "${nextFrame.name}" (${Math.round(nextFrame.width)}\xD7${Math.round(nextFrame.height)}) next to search \u2014 will move together`);
              i++;
            }
          }
        }
        continue;
      }
      if (searchSections.length > 0 && isCompanionSection(sFrame)) {
        companionSections.push(sFrame);
        console.log(`[headerMerge] \u2192 Identified as COMPANION section (filter/sort near search)`);
        continue;
      }
      const foundIcons = findIconNodes(sFrame, 0, 3);
      if (foundIcons.length > 0) {
        iconNodes.push(...foundIcons);
        console.log(`[headerMerge] \u2192 Found ${foundIcons.length} icons: ${foundIcons.map((ic) => `"${ic.name}" ${Math.round(ic.width)}\xD7${Math.round(ic.height)}`).join(", ")}`);
      } else {
        console.log(`[headerMerge] \u2192 No icons found in this section`);
      }
    }
    if (searchSections.length === 0 && iconNodes.length === 0 && companionSections.length === 0) {
      console.log(`[headerMerge] No header elements found to merge`);
      return;
    }
    const searchPref = (prefs == null ? void 0 : prefs.searchPlacement) || "auto";
    console.log(`[headerMerge] Search placement preference: "${searchPref}"`);
    let searchAdded = false;
    for (const searchSection of searchSections) {
      if (searchPref === "below-header") {
        try {
          const sAny = searchSection;
          if (sAny.layoutMode === "NONE") {
            sAny.layoutMode = "HORIZONTAL";
          }
          sAny.layoutSizingHorizontal = "FILL";
          sAny.layoutSizingVertical = "HUG";
          console.log(`[headerMerge] Search stays below header (user preference) \u2014 set FILL`);
        } catch (e) {
          console.warn(`[headerMerge] Could not style search: ${e.message}`);
        }
        continue;
      }
      try {
        const sAny = searchSection;
        if (sAny.layoutMode === "NONE") {
          sAny.layoutMode = "HORIZONTAL";
          console.log(`[headerMerge] Set search section layoutMode to HORIZONTAL`);
        }
        navContainer.appendChild(searchSection);
        sAny.layoutSizingHorizontal = "FILL";
        sAny.layoutSizingVertical = "HUG";
        if ("children" in searchSection) {
          const childrenToExtract = [];
          for (const child of searchSection.children) {
            if (child.type === "TEXT") continue;
            const isSmall = child.width <= 56 && child.height <= 56;
            let hasFilterText = false;
            if ("findAll" in child) {
              const texts = child.findAll((n) => n.type === "TEXT");
              hasFilterText = texts.some((t) => /filter|sort|tune|adjust|setting/i.test(t.characters));
            }
            const nameIsFilter = /filter|sort|tune|slider|adjust/i.test(child.name);
            if (isSmall || hasFilterText || nameIsFilter) {
              let isSearchInput = false;
              if ("findAll" in child) {
                const texts = child.findAll((n) => n.type === "TEXT");
                isSearchInput = texts.some((t) => /search/i.test(t.characters));
              }
              if (!isSearchInput) {
                childrenToExtract.push(child);
              }
            }
          }
          for (const extractChild of childrenToExtract) {
            try {
              const searchIdx = [...navContainer.children].indexOf(searchSection);
              navContainer.insertChild(searchIdx + 1, extractChild);
              const ecAny = extractChild;
              if ("layoutSizingHorizontal" in extractChild) ecAny.layoutSizingHorizontal = "FIXED";
              if ("layoutSizingVertical" in extractChild) ecAny.layoutSizingVertical = "FIXED";
              console.log(`[headerMerge] Extracted filter element "${extractChild.name}" (${Math.round(extractChild.width)}\xD7${Math.round(extractChild.height)}) from search \u2192 nav bar`);
            } catch (e) {
              console.warn(`[headerMerge] Could not extract "${extractChild.name}": ${e.message}`);
            }
          }
        }
        if ("minWidth" in searchSection) {
          sAny.minWidth = 280;
          console.log(`[headerMerge] Set search minWidth=280px`);
        }
        console.log(`[headerMerge] Moved search "${searchSection.name}" into nav (FILL, will wrap if needed)`);
        searchAdded = true;
      } catch (e) {
        console.warn(`[headerMerge] Could not move search: ${e.message}`);
      }
    }
    for (const icon of iconNodes) {
      try {
        navContainer.appendChild(icon);
        const iconAny = icon;
        if ("layoutSizingHorizontal" in icon) iconAny.layoutSizingHorizontal = "FIXED";
        if ("layoutSizingVertical" in icon) iconAny.layoutSizingVertical = "FIXED";
        console.log(`[headerMerge] Moved icon "${icon.name}" (${Math.round(icon.width)}\xD7${Math.round(icon.height)}) to nav \u2014 pinned FIXED`);
      } catch (e) {
        console.warn(`[headerMerge] Could not move icon "${icon.name}": ${e.message}`);
      }
    }
    for (const companion of companionSections) {
      if (searchPref === "below-header") {
        try {
          const cAny = companion;
          if (cAny.layoutMode === "NONE") {
            cAny.layoutMode = "HORIZONTAL";
          }
          cAny.layoutSizingHorizontal = "HUG";
          cAny.layoutSizingVertical = "HUG";
          console.log(`[headerMerge] Companion "${companion.name}" stays with search below header`);
        } catch (e) {
          console.warn(`[headerMerge] Could not style companion: ${e.message}`);
        }
        continue;
      }
      try {
        navContainer.appendChild(companion);
        const cAny = companion;
        if ("layoutSizingHorizontal" in companion) cAny.layoutSizingHorizontal = "HUG";
        if ("layoutSizingVertical" in companion) cAny.layoutSizingVertical = "HUG";
        console.log(`[headerMerge] Moved companion "${companion.name}" (${Math.round(companion.width)}\xD7${Math.round(companion.height)}) into nav`);
      } catch (e) {
        console.warn(`[headerMerge] Could not move companion "${companion.name}": ${e.message}`);
      }
    }
    if (searchAdded) {
      const ncAny = navContainer;
      if ("primaryAxisAlignItems" in navContainer) {
        ncAny.primaryAxisAlignItems = "MIN";
        console.log(`[headerMerge] Changed nav alignment to MIN (for FILL search)`);
      }
      if (navContainer !== navSection) {
        const nsAny = navSection;
        if ("primaryAxisAlignItems" in navSection) {
          nsAny.primaryAxisAlignItems = "MIN";
        }
      }
    }
    console.log(`[headerMerge] Done. Nav now has ${navContainer.children.length} children`);
    const sectionsToRemove = [];
    for (let i = 1; i < rootFrame.children.length; i++) {
      const section = rootFrame.children[i];
      if (!("children" in section)) continue;
      const sFrame = section;
      if (sFrame.height > 200) continue;
      pruneEmptyFrames(sFrame);
      if (sFrame.children.length === 0) {
        sectionsToRemove.push(sFrame);
        console.log(`[headerMerge] Marking fully empty section "${sFrame.name}" for removal`);
        continue;
      }
      const hasVisibleContent = sFrame.children.some((child) => {
        if (child.type === "TEXT") {
          const text = child.characters.trim();
          return text.length > 0;
        }
        if ("children" in child) {
          const cf = child;
          return cf.children.length > 0;
        }
        return child.visible !== false;
      });
      if (!hasVisibleContent) {
        sectionsToRemove.push(sFrame);
        console.log(`[headerMerge] Marking empty section "${sFrame.name}" for removal (${sFrame.children.length} non-meaningful children)`);
        continue;
      }
      try {
        const sAny = sFrame;
        if ("layoutMode" in sFrame && sAny.layoutMode !== "NONE") {
          if ("layoutSizingVertical" in sFrame) {
            sAny.layoutSizingVertical = "HUG";
            console.log(`[headerMerge] Compacted section "${sFrame.name}" \u2014 set vertical to HUG`);
          }
        }
      } catch (e) {
        console.warn(`[headerMerge] Could not compact section: ${e.message}`);
      }
    }
    for (const section of sectionsToRemove) {
      try {
        section.remove();
        console.log(`[headerMerge] Removed empty section "${section.name}"`);
      } catch (e) {
        console.warn(`[headerMerge] Could not remove section: ${e.message}`);
      }
    }
  }
  function pruneEmptyFrames(parent) {
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = parent.children[i];
      if (!("children" in child)) continue;
      if (child.type === "TEXT") continue;
      const cf = child;
      pruneEmptyFrames(cf);
      if (cf.children.length === 0) {
        console.log(`[headerMerge] Pruning empty frame "${cf.name}" from "${parent.name}"`);
        try {
          cf.remove();
        } catch (e) {
        }
      }
    }
  }
  function applyDesktopPadding(rootFrame) {
    for (const child of rootFrame.children) {
      if (!("layoutMode" in child)) continue;
      const childAny = child;
      const lm = childAny.layoutMode;
      if (lm !== "VERTICAL" && lm !== "HORIZONTAL") continue;
      const currentPadLR = Math.max(childAny.paddingLeft || 0, childAny.paddingRight || 0);
      if (currentPadLR < 32) {
        const desktopPad = 40;
        console.log(`[preProcess] Desktop padding on "${child.name}": LR ${currentPadLR}\u2192${desktopPad}px`);
        childAny.paddingLeft = desktopPad;
        childAny.paddingRight = desktopPad;
      }
      const currentPadTB = Math.max(childAny.paddingTop || 0, childAny.paddingBottom || 0);
      if (currentPadTB < 20 && currentPadTB > 0) {
        const desktopPadV = Math.round(currentPadTB * 1.5);
        childAny.paddingTop = desktopPadV;
        childAny.paddingBottom = desktopPadV;
      }
      const currentSpacing = childAny.itemSpacing || 0;
      if (currentSpacing > 0 && currentSpacing < 16) {
        const desktopSpacing = Math.round(currentSpacing * 1.5);
        console.log(`[preProcess] Desktop spacing on "${child.name}": ${currentSpacing}\u2192${desktopSpacing}px`);
        childAny.itemSpacing = desktopSpacing;
      }
      if ("children" in child) {
        applyDesktopPaddingRecursive(child, 0);
      }
    }
  }
  function applyDesktopPaddingRecursive(frame, depth) {
    if (depth > 2) return;
    for (const child of frame.children) {
      if (!("layoutMode" in child)) continue;
      const childAny = child;
      const lm = childAny.layoutMode;
      if (lm !== "VERTICAL" && lm !== "HORIZONTAL") continue;
      const spacing = childAny.itemSpacing || 0;
      if (spacing > 0 && spacing < 16) {
        childAny.itemSpacing = Math.round(spacing * 1.5);
      }
      if ("children" in child) {
        applyDesktopPaddingRecursive(child, depth + 1);
      }
    }
  }
  function hasColoredBackground(node) {
    if (!("fills" in node)) return false;
    try {
      const fills = node.fills;
      if (!Array.isArray(fills)) return false;
      return fills.some((f) => {
        if (!f.visible) return false;
        if (f.type === "IMAGE") return true;
        if (f.type === "GRADIENT_LINEAR" || f.type === "GRADIENT_RADIAL" || f.type === "GRADIENT_ANGULAR" || f.type === "GRADIENT_DIAMOND") return true;
        if (f.type === "SOLID") {
          const c = f.color;
          const isWhite = c.r > 0.95 && c.g > 0.95 && c.b > 0.95;
          const isTransparent = f.opacity !== void 0 && f.opacity < 0.1;
          return !isWhite && !isTransparent;
        }
        return false;
      });
    } catch (_e) {
      return false;
    }
  }
  function scoreHeroSection(section) {
    let score = 0;
    const name = section.name.toLowerCase();
    if (/hero|banner|promo|special|featured|spotlight|offer|deal|highlight/i.test(name)) {
      score += 10;
    }
    if (/header|carousel|slide/i.test(name)) {
      score += 4;
    }
    if (/popular|trending|category|categories|products|items|menu|nav|tab|footer|bottom/i.test(name)) {
      score -= 8;
    }
    if (hasColoredBackground(section)) {
      score += 8;
    }
    if (section.height >= 200 && section.height <= 500) {
      score += 3;
    }
    if (section.width > 300) {
      score += 1;
    }
    if (!("children" in section)) return score;
    const allNodes = section.findAll(() => true);
    const textNodes = allNodes.filter((n) => n.type === "TEXT");
    const imageNodes = allNodes.filter((n) => {
      if (n.type === "ELLIPSE" || n.type === "RECTANGLE") {
        if ("fills" in n) {
          try {
            const fills = n.fills;
            return Array.isArray(fills) && fills.some((f) => f.type === "IMAGE");
          } catch (_e) {
          }
        }
      }
      if (n.type === "FRAME" && "fills" in n) {
        try {
          const fills = n.fills;
          return Array.isArray(fills) && fills.some((f) => f.type === "IMAGE");
        } catch (_e) {
        }
      }
      return false;
    });
    if (textNodes.length >= 1 && imageNodes.length >= 1) {
      score += 6;
    }
    const hasCTA = textNodes.some(
      (t) => /order now|shop now|buy now|get started|try now|learn more|sign up|discover/i.test(t.characters)
    );
    if (hasCTA) {
      score += 3;
    }
    const priceNodes = textNodes.filter((t) => /\$|€|£|\d+\.\d{2}/.test(t.characters));
    if (priceNodes.length >= 3) {
      score -= 6;
    } else if (priceNodes.length === 1) {
      score += 2;
    }
    const hasSeeAll = textNodes.some((t) => /see all|view all|show more/i.test(t.characters));
    if (hasSeeAll) {
      score -= 5;
    }
    if (section.children.length > 8) {
      score -= 5;
    }
    if (section.children.length >= 3) {
      const childHeights = section.children.filter((c) => "height" in c).map((c) => c.height);
      if (childHeights.length >= 3) {
        const avgH = childHeights.reduce((a, b) => a + b, 0) / childHeights.length;
        const allSimilar = childHeights.every((h) => Math.abs(h - avgH) / avgH < 0.2);
        if (allSimilar) {
          score -= 4;
        }
      }
    }
    if (section.height < 100) {
      score -= 5;
    }
    return score;
  }
  function classifyHeroChildren(section) {
    const textChildren = [];
    const imageChildren = [];
    let classifyTarget = section.children;
    if (section.children.length === 1 && "children" in section.children[0]) {
      const inner = section.children[0];
      if (inner.children && inner.children.length > 1) {
        classifyTarget = inner.children;
        console.log(`[hero] Drilling into wrapper "${inner.name}" for classification (${inner.children.length} children)`);
      }
    }
    for (const child of classifyTarget) {
      if (child.type === "TEXT") {
        textChildren.push(child);
        continue;
      }
      let isImage = false;
      if ("fills" in child) {
        try {
          const fills = child.fills;
          if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) {
            isImage = true;
          }
        } catch (_e) {
        }
      }
      if (!isImage && child.type === "ELLIPSE") {
        isImage = true;
      }
      if (!isImage && "children" in child) {
        const cf = child;
        const hasImgChild = cf.findOne((n) => {
          if (n.type === "ELLIPSE") return true;
          if ("fills" in n) {
            try {
              const fills = n.fills;
              return Array.isArray(fills) && fills.some((f) => f.type === "IMAGE");
            } catch (_e) {
            }
          }
          return false;
        });
        if (hasImgChild) isImage = true;
      }
      if (isImage) {
        imageChildren.push(child);
      } else {
        let isButton = false;
        if ("children" in child) {
          const cf = child;
          const texts = cf.findAll((n) => n.type === "TEXT");
          if (texts.length <= 2 && child.height <= 60) {
            isButton = texts.some(
              (t) => /order|shop|buy|get|try|learn|start|sign|view|explore|discover|check/i.test(t.characters)
            );
          }
        }
        textChildren.push(child);
      }
    }
    return { textChildren, imageChildren };
  }
  async function scaleHeroText(section, scaleFactor) {
    const textNodes = section.findAll((n) => n.type === "TEXT");
    for (const textNode of textNodes) {
      try {
        const currentSize = textNode.fontSize;
        if (typeof currentSize !== "number") continue;
        let newSize;
        if (currentSize >= 24) {
          newSize = Math.round(currentSize * Math.min(scaleFactor, 2));
        } else if (currentSize >= 14) {
          newSize = Math.round(currentSize * Math.min(scaleFactor, 1.5));
        } else {
          newSize = Math.round(currentSize * Math.min(scaleFactor, 1.25));
        }
        newSize = Math.min(newSize, 72);
        if (newSize !== currentSize) {
          const fontName = textNode.fontName;
          if (fontName && typeof fontName === "object" && "family" in fontName) {
            await figma.loadFontAsync(fontName);
          }
          textNode.fontSize = newSize;
          console.log(`[hero] Scaled text "${textNode.characters.substring(0, 20)}" ${currentSize}\u2192${newSize}px`);
        }
      } catch (e) {
        console.warn(`[hero] Could not scale text "${textNode.name}": ${e.message}`);
      }
    }
  }
  async function transformHeroSections(rootFrame, targetWidth) {
    const HERO_SCORE_THRESHOLD = 16;
    let heroFound = false;
    for (let idx = 0; idx < rootFrame.children.length; idx++) {
      const section = rootFrame.children[idx];
      if (!("children" in section)) continue;
      if (section.type !== "FRAME" && section.type !== "COMPONENT" && section.type !== "INSTANCE") continue;
      const sFrame = section;
      if (idx === 0) {
        console.log(`[hero] Skipping index 0 "${sFrame.name}" (nav bar)`);
        continue;
      }
      if (heroFound) {
        console.log(`[hero] Skipping "${sFrame.name}" \u2014 already transformed a hero`);
        continue;
      }
      const heroScore = scoreHeroSection(sFrame);
      console.log(`[hero] Section "${sFrame.name}" score=${heroScore} (threshold=${HERO_SCORE_THRESHOLD})`);
      if (heroScore < HERO_SCORE_THRESHOLD) continue;
      heroFound = true;
      console.log(`[hero] Transforming hero section "${sFrame.name}" for desktop`);
      const sAny = sFrame;
      const mobileWidth = 390;
      const scaleFactor = Math.min(targetWidth / mobileWidth, 2);
      await scaleHeroText(sFrame, scaleFactor);
      const { textChildren, imageChildren } = classifyHeroChildren(sFrame);
      console.log(`[hero] Children: ${textChildren.length} text-group, ${imageChildren.length} image-group`);
      const desktopMinHeight = Math.min(480, Math.max(300, Math.round(sFrame.height * 1.2)));
      if ("minHeight" in sFrame) {
        sAny.minHeight = desktopMinHeight;
        console.log(`[hero] Set minHeight=${desktopMinHeight}px`);
      }
      if (textChildren.length > 0 && imageChildren.length > 0) {
        const currentLayout = sAny.layoutMode;
        if (currentLayout === "VERTICAL" || currentLayout === "NONE") {
          sAny.layoutMode = "HORIZONTAL";
          sAny.primaryAxisAlignItems = "SPACE_BETWEEN";
          sAny.counterAxisAlignItems = "CENTER";
          sAny.itemSpacing = 40;
          console.log(`[hero] Switched to HORIZONTAL layout with center alignment`);
          if (textChildren.length > 1) {
            const textWrapper = figma.createFrame();
            textWrapper.name = "hero-text-group";
            const twAny = textWrapper;
            twAny.layoutMode = "VERTICAL";
            twAny.primaryAxisAlignItems = "CENTER";
            twAny.counterAxisAlignItems = "MIN";
            twAny.itemSpacing = 12;
            twAny.layoutSizingHorizontal = "FILL";
            twAny.layoutSizingVertical = "HUG";
            textWrapper.fills = [];
            let firstTextIdx = 0;
            for (let i = 0; i < sFrame.children.length; i++) {
              if (textChildren.includes(sFrame.children[i])) {
                firstTextIdx = i;
                break;
              }
            }
            sFrame.insertChild(firstTextIdx, textWrapper);
            for (const tc of textChildren) {
              textWrapper.appendChild(tc);
            }
            console.log(`[hero] Wrapped ${textChildren.length} text elements in group`);
            twAny.layoutSizingHorizontal = "FILL";
          } else {
            const tc = textChildren[0];
            if ("layoutSizingHorizontal" in tc) {
              tc.layoutSizingHorizontal = "FILL";
            }
          }
          for (const img of imageChildren) {
            const imgAny = img;
            if ("layoutSizingHorizontal" in img) {
              imgAny.layoutSizingHorizontal = "FIXED";
            }
            if ("layoutSizingVertical" in img) {
              imgAny.layoutSizingVertical = "FIXED";
            }
            if ("resize" in img) {
              const imgScale = Math.min(scaleFactor, 1.8);
              const newW = Math.round(img.width * imgScale);
              const newH = Math.round(img.height * imgScale);
              const maxImgW = Math.round(targetWidth * 0.4);
              const finalW = Math.min(newW, maxImgW);
              const finalH = Math.round(finalW * (img.height / img.width));
              img.resize(finalW, finalH);
              console.log(`[hero] Scaled image "${img.name}" to ${finalW}\xD7${finalH}px`);
            }
          }
          for (const img of imageChildren) {
            try {
              sFrame.appendChild(img);
            } catch (_e) {
            }
          }
        }
      } else {
        if (sAny.layoutMode === "VERTICAL" || sAny.layoutMode === "NONE") {
          if (sAny.layoutMode === "NONE") {
            sAny.layoutMode = "VERTICAL";
          }
          sAny.counterAxisAlignItems = "CENTER";
        }
      }
      const currentPadLR = Math.max(sAny.paddingLeft || 0, sAny.paddingRight || 0);
      if (currentPadLR < 48) {
        sAny.paddingLeft = 60;
        sAny.paddingRight = 60;
        console.log(`[hero] Desktop padding: LR \u2192 60px`);
      }
      const currentPadTB = Math.max(sAny.paddingTop || 0, sAny.paddingBottom || 0);
      if (currentPadTB < 32) {
        sAny.paddingTop = 40;
        sAny.paddingBottom = 40;
        console.log(`[hero] Desktop padding: TB \u2192 40px`);
      }
      try {
        if ("layoutSizingVertical" in sFrame) {
          sAny.layoutSizingVertical = "HUG";
        }
      } catch (_e) {
      }
      console.log(`[hero] Finished transforming "${sFrame.name}"`);
    }
  }
  function convertCardListsToGrid(rootFrame, targetWidth) {
    for (const section of rootFrame.children) {
      if (!("children" in section)) continue;
      findAndConvertCardLists(section, targetWidth, 0);
    }
  }
  function findAndConvertCardLists(frame, targetWidth, depth) {
    if (depth > 4) return;
    const frameAny = frame;
    const lm = frameAny.layoutMode;
    if (lm === "VERTICAL" && "children" in frame && frame.children.length >= 3) {
      const kids = frame.children;
      const frameKids = kids.filter((k) => k.type === "FRAME" || k.type === "INSTANCE" || k.type === "COMPONENT");
      if (frameKids.length >= 3) {
        const heights = frameKids.map((k) => k.height);
        const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
        const allSimilar = heights.every((h) => Math.abs(h - avgH) < avgH * 0.4);
        if (allSimilar) {
          console.log(`[preProcess] Converting card list "${frame.name}" (${frameKids.length} cards) to HORIZONTAL WRAP`);
          frameAny.layoutMode = "HORIZONTAL";
          frameAny.layoutWrap = "WRAP";
          frameAny.itemSpacing = 20;
          if ("counterAxisSpacing" in frame) {
            frameAny.counterAxisSpacing = 20;
          }
          const padL = frameAny.paddingLeft || 0;
          const padR = frameAny.paddingRight || 0;
          const availableWidth = targetWidth - padL - padR;
          const gapCount = 2;
          const cardWidth = Math.floor((availableWidth - gapCount * 20) / 3);
          for (const card of frameKids) {
            if ("resize" in card) {
              const cardAny = card;
              if ("layoutSizingHorizontal" in card) {
                cardAny.layoutSizingHorizontal = "FIXED";
              }
              card.resize(cardWidth, card.height);
              console.log(`[preProcess] Sized card "${card.name}" to ${cardWidth}px wide`);
            }
          }
          return;
        }
      }
    }
    if ("children" in frame) {
      for (const child of frame.children) {
        if ("children" in child && "layoutMode" in child) {
          findAndConvertCardLists(child, targetWidth, depth + 1);
        }
      }
    }
  }
  function isImageWrapper(node) {
    if (!("children" in node)) return false;
    const children = node.children;
    for (const child of children) {
      if (child.type === "RECTANGLE" && "fills" in child) {
        try {
          const fills = child.fills;
          if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) {
            return true;
          }
        } catch (_e) {
        }
      }
    }
    return false;
  }
  var MAX_FILL_DEPTH = 3;
  function recursivelySetFill(parent, depth) {
    const parentAny = parent;
    const parentHasAutoLayout = "layoutMode" in parent && (parentAny.layoutMode === "VERTICAL" || parentAny.layoutMode === "HORIZONTAL");
    if (!("children" in parent)) return;
    for (const child of parent.children) {
      if ("clipsContent" in child) {
        child.clipsContent = true;
      }
      if (depth < MAX_FILL_DEPTH && parentHasAutoLayout && "layoutSizingHorizontal" in child) {
        const childAny = child;
        const isLeaf = child.type === "TEXT" || child.type === "ELLIPSE" || child.type === "VECTOR" || child.type === "LINE" || child.type === "STAR" || child.type === "POLYGON" || child.type === "RECTANGLE";
        const isImgWrapper = !isLeaf && isImageWrapper(child);
        const isSmallIcon = !isLeaf && child.width <= 48 && child.height <= 48;
        if (!isLeaf && !isImgWrapper && !isSmallIcon && childAny.layoutSizingHorizontal !== "FILL") {
          console.log(`[preProcess] Setting "${child.name}" (${child.type}, depth=${depth}) horizontal sizing to FILL`);
          childAny.layoutSizingHorizontal = "FILL";
        } else if (isImgWrapper) {
          console.log(`[preProcess] Skipping image wrapper "${child.name}" \u2014 not setting FILL`);
        }
      }
      if ("children" in child) {
        recursivelySetFill(child, depth + 1);
      }
    }
  }
  async function applyDuplicateFrame(op) {
    const sourceNode = figma.getNodeById(op.nodeId);
    if (!sourceNode) {
      throw new Error(`Node ${op.nodeId} not found`);
    }
    const source = sourceNode;
    const clone = source.clone();
    const CANVAS_GAP = 100;
    clone.x = source.x + source.width + CANVAS_GAP;
    clone.y = source.y;
    if (op.variantIntent) {
      clone.name = `${source.name} \u2014 ${op.variantIntent}`;
    } else {
      clone.name = `${source.name} (copy)`;
    }
    console.log(`[duplicateFrame] Cloned "${source.name}" \u2192 "${clone.name}" at x=${clone.x}`);
    if (op.variantIntent) {
      sendToUI({ type: "status", message: `Applying variant: ${op.variantIntent}\u2026` });
      const responsiveType = detectResponsiveType(op.variantIntent);
      try {
        let targetWidth = source.width;
        if (responsiveType === "mobile-to-desktop" && "resize" in clone) {
          targetWidth = 1440;
          const cloneFrame = clone;
          const cloneAny = cloneFrame;
          if ("layoutSizingHorizontal" in cloneFrame) {
            cloneAny.layoutSizingHorizontal = "FIXED";
          }
          cloneFrame.resize(targetWidth, cloneFrame.height);
          console.log(`[duplicateFrame] Pre-resized clone to ${targetWidth}px wide`);
          const layoutPrefs = parseLayoutPrefs(op.variantIntent || "");
          await preProcessDesktopLayout(clone, targetWidth, layoutPrefs);
          clone.x = source.x + source.width + CANVAS_GAP;
        } else if (responsiveType === "desktop-to-mobile" && "resize" in clone) {
          targetWidth = 375;
          const cloneFrame = clone;
          const cloneAny = cloneFrame;
          if ("layoutSizingHorizontal" in cloneFrame) {
            cloneAny.layoutSizingHorizontal = "FIXED";
          }
          cloneFrame.resize(targetWidth, cloneFrame.height);
          console.log(`[duplicateFrame] Pre-resized clone to ${targetWidth}px wide`);
        }
        const cloneSnapshot = snapshotNode(clone, 0);
        const cloneSelection = { nodes: [cloneSnapshot] };
        const designSystem = await extractDesignSystemSnapshot();
        let variantPrompt;
        if (responsiveType) {
          variantPrompt = buildResponsivePrompt(op.variantIntent, responsiveType, targetWidth, source.width);
        } else {
          variantPrompt = buildColorVariantPrompt(op.variantIntent);
        }
        const payload = {
          intent: variantPrompt,
          selection: cloneSelection,
          designSystem,
          apiKey: _userApiKey,
          provider: _selectedProvider,
          model: _selectedModel
        };
        const variantBatch = await fetchViaUI("/plan?lenient=true", payload);
        if (variantBatch.operations && variantBatch.operations.length > 0) {
          const safeOps = variantBatch.operations.filter((o) => o.type !== "DUPLICATE_FRAME");
          console.log(`[duplicateFrame] Applying ${safeOps.length} variant transformations (filtered ${variantBatch.operations.length - safeOps.length} DUPLICATE_FRAME ops)`);
          for (const varOp of safeOps) {
            try {
              await applyOperation(varOp);
            } catch (err) {
              console.warn(`[duplicateFrame] Variant op failed: ${err.message}`);
            }
          }
        }
        if (responsiveType && "resize" in clone) {
          const cloneFrame = clone;
          const cloneAny = cloneFrame;
          if (cloneFrame.width !== targetWidth) {
            console.log(`[duplicateFrame] Re-clamping root width from ${Math.round(cloneFrame.width)}px back to ${targetWidth}px`);
            cloneAny.layoutSizingHorizontal = "FIXED";
            cloneFrame.resize(targetWidth, cloneFrame.height);
          }
        }
      } catch (err) {
        console.warn(`[duplicateFrame] Variant transformation failed: ${err.message}`);
      }
      sendToUI({ type: "status", message: "Checking contrast\u2026" });
      const contrastFixes = fixContrastRecursive(clone);
      if (contrastFixes > 0) {
        console.log(`[duplicateFrame] Auto-fixed ${contrastFixes} low-contrast text node(s)`);
      }
    }
  }
  function buildResponsivePrompt(variantIntent, responsiveType, targetWidth, sourceWidth) {
    const isToDesktop = responsiveType === "mobile-to-desktop";
    return `Transform this frame to be a "${variantIntent}" variant.

IMPORTANT: The root frame has ALREADY been resized to ${targetWidth}px wide (from ${sourceWidth}px). Do NOT use RESIZE_NODE on the root frame.

CRITICAL RULES:
1. The ROOT frame MUST remain VERTICAL \u2014 NEVER change its layout mode.
2. Do NOT change text content or colors.
3. Only reference node IDs from the snapshot.

` + (isToDesktop ? `MOBILE \u2192 DESKTOP (${targetWidth}px):
Pre-processing has already done most of the work:
\u2022 Sections stretched to full width via FILL
\u2022 Bottom nav moved to top
\u2022 Card lists converted to horizontal wrap grids
\u2022 Desktop padding applied to all sections

YOUR REMAINING TASKS (lightweight fine-tuning only):
1. If you see any inner container that should also be HORIZONTAL for desktop, use SET_LAYOUT_MODE.
2. If any text nodes or small elements need FILL sizing to spread across the width, use SET_SIZE_MODE horizontal=FILL (only if parent has auto-layout).
3. Fine-tune any spacing that still looks mobile-sized with SET_LAYOUT_PROPS.
4. Do NOT resize images or the root frame.
5. If the layout already looks good from pre-processing, generate an EMPTY operations array \u2014 that's perfectly fine.

` : `DESKTOP \u2192 MOBILE (${targetWidth}px):
\u2022 Switch HORIZONTAL sections to VERTICAL so items stack.
\u2022 Reduce padding to mobile proportions: paddingLeft/Right 16-20px, paddingTop/Bottom 12-16px.
\u2022 Reduce itemSpacing to 8-12px.
\u2022 Set cards to FILL width.

`) + `AVAILABLE OPERATIONS:
\u2022 SET_LAYOUT_MODE \u2014 change direction (HORIZONTAL/VERTICAL), enable wrap
\u2022 SET_LAYOUT_PROPS \u2014 adjust padding and spacing
\u2022 SET_SIZE_MODE \u2014 FILL/HUG (only when parent has auto-layout)

IMPORTANT: Do NOT use RESIZE_NODE \u2014 sizing is handled by FILL/HUG via auto-layout.
IMPORTANT: Only reference node IDs from the snapshot. Be minimal \u2014 pre-processing has done the heavy lifting.`;
  }
  function buildColorVariantPrompt(variantIntent) {
    return `Transform this frame to be a "${variantIntent}" variant.

CRITICAL \u2014 CONTRAST & READABILITY RULES (apply to EVERY variant):
1. EVERY text node must have strong contrast against its immediate background.
2. After changing any background, you MUST also change the text on top of it so the pair remains readable.
3. After changing any text color, verify it contrasts with the background behind it.
4. Light text (#FFFFFF, #E0E0E0, #F5F5F5) must ONLY appear on dark backgrounds (#333 or darker). Dark text (#000000, #1A1A1A, #333333) must ONLY appear on light backgrounds (#CCC or lighter).
5. Selected / active / highlighted states (e.g., a selected tab, active category, toggled button) must remain visually distinct from their unselected siblings. If you change the selected item's background, also update its text/icon color AND make sure unselected siblings use a clearly different style.
6. Hero sections, banners, and promotional cards: if the background changes, ALL overlay text (title, subtitle, price, CTA) must be updated to contrast.
7. Icons and small UI elements (badges, "+" buttons, dots) should also be checked \u2014 ensure they remain visible.

COLOR PALETTE GUIDANCE:
\u2022 Dark mode backgrounds: #121212 (surface), #1E1E1E (card), #1A1A2E (hero), #2D2D3F (elevated), #0F0F1A (deepest).
\u2022 Dark mode text: #FFFFFF (primary), #E0E0E0 (secondary), #B0B0B0 (tertiary/muted).
\u2022 Light mode backgrounds: #FFFFFF (surface), #F5F5F5 (card), #FFF8F0 (warm hero), #F0F0F0 (elevated).
\u2022 Light mode text: #000000 or #1A1A1A (primary), #333333 (secondary), #666666 (tertiary/muted).
\u2022 Accent / brand colors (buttons, links, highlights) can usually stay the same across modes, but verify their text labels still contrast.

TASK: Walk through EVERY node in the snapshot and emit SET_FILL_COLOR for:
  \u2013 Every background frame/rectangle that needs to change.
  \u2013 Every TEXT node whose color must flip to maintain contrast.
  \u2013 Every icon or decorative element that would disappear against the new background.
Do NOT skip nodes. Be thorough \u2014 it is better to emit too many color changes than to leave unreadable text.

For translations: change all text content to the target language using SET_TEXT.
Use SET_FILL_COLOR to change background colors and text colors.
Use SET_TEXT to change text content.
Use RESIZE_NODE to change sizes.
IMPORTANT: Only reference node IDs from the snapshot provided.
IMPORTANT: To change text color, use SET_FILL_COLOR on the TEXT node with the desired color.`;
  }
  async function applyOperation(op) {
    switch (op.type) {
      case "INSERT_COMPONENT":
        await applyInsertComponent(op);
        break;
      case "CREATE_FRAME":
        applyCreateFrame(op);
        break;
      case "SET_TEXT":
        await applySetText(op);
        break;
      case "APPLY_TEXT_STYLE":
        await applyTextStyle(op);
        break;
      case "APPLY_FILL_STYLE":
        applyFillStyle(op);
        break;
      case "RENAME_NODE":
        applyRenameNode(op);
        break;
      case "SET_IMAGE":
        await applySetImage(op);
        break;
      case "RESIZE_NODE":
        applyResizeNode(op);
        break;
      case "MOVE_NODE":
        applyMoveNode(op);
        break;
      case "CLONE_NODE":
        applyCloneNode(op);
        break;
      case "DELETE_NODE":
        applyDeleteNode(op);
        break;
      case "SET_FILL_COLOR":
        applySetFillColor(op);
        break;
      case "SET_LAYOUT_MODE":
        applySetLayoutMode(op);
        break;
      case "SET_LAYOUT_PROPS":
        applySetLayoutProps(op);
        break;
      case "SET_SIZE_MODE":
        applySetSizeMode(op);
        break;
      case "DUPLICATE_FRAME":
        await applyDuplicateFrame(op);
        break;
      default:
        throw new Error(`Unknown operation type: ${op.type}`);
    }
  }
  function captureNodeState(node) {
    const state = { name: node.name };
    if (node.type === "TEXT") {
      const tn = node;
      state.characters = tn.characters;
      state.textStyleId = typeof tn.textStyleId === "string" ? tn.textStyleId : "";
    }
    if ("fillStyleId" in node) {
      state.fillStyleId = typeof node.fillStyleId === "string" ? node.fillStyleId : "";
    }
    if ("fills" in node) {
      try {
        state.fills = JSON.stringify(node.fills);
      } catch (_e) {
      }
    }
    if ("width" in node && "height" in node) {
      state.width = node.width;
      state.height = node.height;
      state.x = node.x;
      state.y = node.y;
    }
    if ("cornerRadius" in node) {
      state.cornerRadius = node.cornerRadius;
    }
    if ("layoutSizingHorizontal" in node) {
      state.layoutSizingHorizontal = node.layoutSizingHorizontal;
      state.layoutSizingVertical = node.layoutSizingVertical;
    }
    if ("primaryAxisSizingMode" in node) {
      state.primaryAxisSizingMode = node.primaryAxisSizingMode;
      state.counterAxisSizingMode = node.counterAxisSizingMode;
    }
    if ("minHeight" in node) {
      state.minHeight = node.minHeight;
      state.minWidth = node.minWidth;
    }
    return state;
  }
  function captureDeepState(node, out) {
    if ("id" in node && !out[node.id]) {
      out[node.id] = JSON.stringify(captureNodeState(node));
    }
    if ("children" in node) {
      for (const child of node.children) {
        captureDeepState(child, out);
      }
    }
  }
  function captureAncestorChain(node, out) {
    let current = node;
    for (let depth = 0; depth < 10; depth++) {
      const par = current.parent;
      if (!par || par.type === "PAGE" || par.type === "DOCUMENT") break;
      if (!out[par.id]) out[par.id] = JSON.stringify(captureNodeState(par));
      if ("children" in par) {
        for (const sib of par.children) {
          if (!out[sib.id]) out[sib.id] = JSON.stringify(captureNodeState(sib));
        }
      }
      current = par;
    }
  }
  function captureRevertState(batch) {
    const previousStates = {};
    for (const op of batch.operations) {
      const nodeId = "nodeId" in op ? op.nodeId : void 0;
      if (!nodeId) continue;
      const node = figma.getNodeById(nodeId);
      if (!node) continue;
      captureDeepState(node, previousStates);
      if ("parent" in node) {
        captureAncestorChain(node, previousStates);
      }
    }
    return { previousStates, batch };
  }
  async function revertLast() {
    if (!lastRevertState) {
      throw new Error("Nothing to revert");
    }
    for (const [nodeId, stateJSON] of Object.entries(
      lastRevertState.previousStates
    )) {
      const node = figma.getNodeById(nodeId);
      if (!node) continue;
      const state = JSON.parse(stateJSON);
      if (state.name !== void 0) {
        node.name = state.name;
      }
      if (node.type === "TEXT" && state.characters !== void 0) {
        const textNode = node;
        const len = textNode.characters.length || 1;
        const fonts = /* @__PURE__ */ new Set();
        for (let i = 0; i < len; i++) {
          const font = textNode.getRangeFontName(i, i + 1);
          fonts.add(`${font.family}::${font.style}`);
        }
        for (const f of fonts) {
          const [family, style] = f.split("::");
          await figma.loadFontAsync({ family, style });
        }
        textNode.characters = state.characters;
      }
      if (node.type === "TEXT" && state.textStyleId !== void 0) {
        node.textStyleId = state.textStyleId;
      }
      if ("fillStyleId" in node && state.fillStyleId !== void 0) {
        node.fillStyleId = state.fillStyleId;
      }
      if ("fills" in node && state.fills !== void 0) {
        try {
          node.fills = JSON.parse(state.fills);
        } catch (_e) {
        }
      }
      if ("resize" in node && state.width !== void 0 && state.height !== void 0) {
        if ("layoutSizingHorizontal" in node && state.layoutSizingHorizontal !== void 0) {
          node.layoutSizingHorizontal = state.layoutSizingHorizontal;
          node.layoutSizingVertical = state.layoutSizingVertical;
        }
        if ("primaryAxisSizingMode" in node && state.primaryAxisSizingMode !== void 0) {
          node.primaryAxisSizingMode = state.primaryAxisSizingMode;
          node.counterAxisSizingMode = state.counterAxisSizingMode;
        }
        node.resizeWithoutConstraints(state.width, state.height);
        if ("minHeight" in node && state.minHeight !== void 0) {
          node.minHeight = state.minHeight;
          node.minWidth = state.minWidth;
        }
        if (state.x !== void 0) node.x = state.x;
        if (state.y !== void 0) node.y = state.y;
      }
      if ("cornerRadius" in node && state.cornerRadius !== void 0) {
        node.cornerRadius = state.cornerRadius;
      }
    }
    lastRevertState = null;
  }
  function writeAuditLog(intent, batch) {
    let logFrame = figma.currentPage.findOne(
      (n) => n.type === "FRAME" && n.name === CHANGE_LOG_FRAME_NAME
    );
    if (!logFrame) {
      logFrame = figma.createFrame();
      logFrame.name = CHANGE_LOG_FRAME_NAME;
      logFrame.visible = false;
      logFrame.layoutMode = "VERTICAL";
      logFrame.primaryAxisSizingMode = "AUTO";
      logFrame.counterAxisSizingMode = "AUTO";
      logFrame.itemSpacing = 8;
      logFrame.paddingTop = 16;
      logFrame.paddingRight = 16;
      logFrame.paddingBottom = 16;
      logFrame.paddingLeft = 16;
    }
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      intent,
      operationSummary: batch.operations.map((op) => op.type).join(", ")
    };
    const textNode = figma.createText();
    figma.loadFontAsync({ family: "Inter", style: "Regular" }).then(() => {
      textNode.characters = JSON.stringify(entry, null, 2);
      textNode.fontSize = 10;
      logFrame.appendChild(textNode);
    });
  }
  async function saveRevertState(state) {
    await figma.clientStorage.setAsync("lastRevertState", JSON.stringify(state));
  }
  async function loadRevertState() {
    const raw = await figma.clientStorage.getAsync("lastRevertState");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }
  async function applyBatch(batch, intent) {
    const revertState = captureRevertState(batch);
    lastRevertState = revertState;
    await saveRevertState(revertState);
    const results = [];
    const friendlyName = {
      INSERT_COMPONENT: "Insert component",
      CREATE_FRAME: "Create frame",
      SET_TEXT: "Set text",
      APPLY_TEXT_STYLE: "Apply text style",
      APPLY_FILL_STYLE: "Apply fill style",
      RENAME_NODE: "Rename",
      SET_IMAGE: "Set image",
      RESIZE_NODE: "Resize",
      MOVE_NODE: "Move",
      CLONE_NODE: "Duplicate",
      DELETE_NODE: "Delete",
      SET_FILL_COLOR: "Set color",
      SET_LAYOUT_MODE: "Set layout mode",
      SET_LAYOUT_PROPS: "Set layout props",
      SET_SIZE_MODE: "Set size mode",
      DUPLICATE_FRAME: "Duplicate frame"
    };
    for (const op of batch.operations) {
      const label = friendlyName[op.type] || op.type;
      try {
        await applyOperation(op);
        results.push(`\u2713 ${label}`);
      } catch (err) {
        results.push(`\u2717 ${label}: ${err.message}`);
      }
    }
    writeAuditLog(intent, batch);
    return results.join("\n");
  }
  function recordCircularNodes(node, out) {
    const isCircular = node.type === "ELLIPSE" || "width" in node && "height" in node && Math.abs(node.width - node.height) <= 5 && node.width > 20;
    if (isCircular) {
      out.add(node.id);
    }
    if ("children" in node) {
      for (const child of node.children) {
        recordCircularNodes(child, out);
      }
    }
  }
  function enforceCirclesFromSet(circularIds) {
    for (const id of circularIds) {
      const node = figma.getNodeById(id);
      if (!node || !("resize" in node)) continue;
      const w = node.width;
      const h = node.height;
      if (w === h) continue;
      const maxDim = Math.max(w, h);
      console.log(
        `[resize] Circle enforce: "${node.name}" ${Math.round(w)}x${Math.round(h)} \u2192 ${Math.round(maxDim)}x${Math.round(maxDim)}`
      );
      node.resize(maxDim, maxDim);
      if ("cornerRadius" in node) {
        node.cornerRadius = Math.round(maxDim / 2);
      }
    }
  }
  function buildRefinementIntent(sectionName, snapshot, oldW, oldH, siblingContext) {
    var _a, _b;
    const newW = (_a = snapshot.width) != null ? _a : oldW;
    const newH = (_b = snapshot.height) != null ? _b : oldH;
    const extraW = newW - oldW;
    const extraH = newH - oldH;
    return `The section "${sectionName}" (id: ${snapshot.id}) was just resized from ${oldW}x${oldH} \u2192 ${newW}x${newH} (+${extraW}px wide, +${extraH}px tall).
ALL descendants have been proportionally scaled as a baseline.

YOUR TASK: Fine-tune the layout so it looks polished at the new size.
The mechanical scaling is done \u2014 focus on design quality:

DESIGN GUIDELINES:
1. IMAGES: If circular (width \u2248 height or ELLIPSE), ALWAYS set width === height.
2. SPACING: Fine-tune positions so elements are balanced within their parents.
3. TEXT NODES: Do NOT resize, but DO reposition with MOVE_NODE if needed.
4. BUTTONS: Keep buttons similar size, reposition as needed.
5. If everything looks good after scaling, return an EMPTY operations array.

RULES:
- ONLY target node IDs from the snapshot \u2014 do NOT invent IDs
- Do NOT resize the root section itself (id: ${snapshot.id}) \u2014 already done
- ELLIPSE nodes: ALWAYS set width === height
- Nodes where current width \u2248 height (\xB15px) and size > 20px: keep width === height (circles)
- TEXT nodes: do NOT resize, only MOVE_NODE if needed
- Use MOVE_NODE only for nodes whose parent has layoutMode=NONE
- MOVE_NODE must always include BOTH x and y fields
- For auto-layout children (parent layoutMode=VERTICAL|HORIZONTAL), only use RESIZE_NODE
- Keep all repositioned content within bounds (0,0 to ${newW},${newH})
- Output a batch of RESIZE_NODE and MOVE_NODE operations (or empty if no changes needed)`;
  }
  function describeSelection() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) return "Nothing selected \u2014 will generate new frame";
    if (sel.length === 1) return `Selected: ${sel[0].name}`;
    return `Selected: ${sel.length} layers`;
  }
  figma.on("selectionchange", () => {
    sendToUI({ type: "selection-change", label: describeSelection() });
  });
  setTimeout(() => {
    sendToUI({ type: "selection-change", label: describeSelection() });
  }, 100);
  setTimeout(() => {
    sendToUI({ type: "startup-ready" });
  }, 50);
  setTimeout(async () => {
    try {
      const raw = await figma.clientStorage.getAsync("phaseTimings");
      if (raw) {
        const timings = JSON.parse(raw);
        sendToUI({ type: "load-timings", timings });
        console.log("[startup] Loaded saved phase timings:", timings);
      }
    } catch (e) {
      console.warn("[startup] Failed to load phase timings:", e);
    }
    try {
      const rawAudit = await figma.clientStorage.getAsync("auditTimings");
      if (rawAudit) {
        const auditTimings = JSON.parse(rawAudit);
        sendToUI({ type: "load-audit-timings", timings: auditTimings });
        console.log("[startup] Loaded saved audit timings:", auditTimings);
      }
    } catch (e) {
      console.warn("[startup] Failed to load audit timings:", e);
    }
    try {
      const rawStateAudit = await figma.clientStorage.getAsync("stateAuditTimings");
      if (rawStateAudit) {
        const stateAuditTimings = JSON.parse(rawStateAudit);
        sendToUI({ type: "load-state-audit-timings", timings: stateAuditTimings });
        console.log("[startup] Loaded saved state audit timings:", stateAuditTimings);
      }
    } catch (e) {
      console.warn("[startup] Failed to load state audit timings:", e);
    }
  }, 150);
  setTimeout(async () => {
    try {
      const savedProvider = await figma.clientStorage.getAsync("selectedProvider");
      const savedModel = await figma.clientStorage.getAsync("selectedModel");
      if (savedProvider) _selectedProvider = savedProvider;
      if (savedModel) _selectedModel = savedModel;
      const allKeys = {};
      for (const p of ["anthropic", "openai", "gemini"]) {
        const k = await figma.clientStorage.getAsync(`apiKey_${p}`);
        if (k) allKeys[p] = k;
      }
      _userApiKey = allKeys[_selectedProvider] || "";
      sendToUI({
        type: "load-api-key",
        key: _userApiKey,
        provider: _selectedProvider,
        model: _selectedModel,
        allKeys
      });
      console.log(`[startup] Loaded provider=${_selectedProvider}, model=${_selectedModel}, key=${_userApiKey ? "set" : "empty"}`);
    } catch (e) {
      console.warn("[startup] Failed to load API key/provider:", e);
    }
  }, 120);
  async function runEditJob(job, intent, selectionSnapshot) {
    var _a;
    try {
      sendToUI({ type: "job-progress", jobId: job.id, phase: "analyze" });
      await yieldToUI();
      console.log(`[edit-job ${job.id}] Extracting design system...`);
      const designSystem = await extractDesignSystemSnapshot();
      await yieldToUI();
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      sendToUI({ type: "job-progress", jobId: job.id, phase: "generate" });
      const payload = __spreadValues({
        intent,
        selection: {
          nodes: selectionSnapshot.nodes.map((n) => truncateSnapshotForGenerate(n, 4e4))
        },
        designSystem
      }, _fullDesignSystem ? { fullDesignSystem: _fullDesignSystem } : {});
      console.log(`[edit-job ${job.id}] Calling backend /plan...`);
      let batch;
      try {
        batch = await fetchViaUIForJob("/plan", __spreadProps(__spreadValues({}, payload), { apiKey: _userApiKey, provider: _selectedProvider, model: _selectedModel }), job.id);
      } catch (err) {
        if (job.cancelled) {
          console.log(`[edit-job ${job.id}] Cancelled during fetch.`);
          sendToUI({ type: "job-cancelled", jobId: job.id });
          return;
        }
        sendToUI({ type: "job-error", jobId: job.id, error: `Backend error: ${err.message}` });
        return;
      }
      if (!batch.operations || batch.operations.length === 0) {
        sendToUI({ type: "job-error", jobId: job.id, error: "Could not determine what to change. Try being more specific." });
        return;
      }
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      sendToUI({ type: "job-progress", jobId: job.id, phase: "create" });
      const resizeOps = batch.operations.filter(
        (op) => op.type === "RESIZE_NODE"
      );
      const preResizeDims = {};
      const preResizeCircles = {};
      const preResizeSiblingPositions = {};
      for (const rop of resizeOps) {
        if (rop.type !== "RESIZE_NODE") continue;
        const n = figma.getNodeById(rop.nodeId);
        if (n) {
          preResizeDims[rop.nodeId] = { w: n.width, h: n.height };
          const circles = /* @__PURE__ */ new Set();
          recordCircularNodes(n, circles);
          preResizeCircles[rop.nodeId] = circles;
          const par = n.parent;
          if (par && "children" in par) {
            const sibs = par.children.filter((s) => s.id !== n.id).sort((a, b) => a.y - b.y);
            const sectionBottom = n.y + n.height;
            preResizeSiblingPositions[rop.nodeId] = sibs.filter((s) => s.y >= sectionBottom - 5).map((s) => ({ id: s.id, y: s.y, height: s.height }));
          }
        }
      }
      const summary = await applyBatch(batch, intent);
      if (resizeOps.length > 0) {
        for (const rop of resizeOps) {
          if (rop.type !== "RESIZE_NODE") continue;
          const targetNode = figma.getNodeById(rop.nodeId);
          if (!targetNode || !("children" in targetNode)) continue;
          const kids = targetNode.children;
          if (kids.length === 0) continue;
          const pre = (_a = preResizeDims[rop.nodeId]) != null ? _a : {
            w: targetNode.width,
            h: targetNode.height
          };
          const deepSnapshot = snapshotNode(targetNode, 0);
          const refinementPayload = {
            intent: buildRefinementIntent(
              targetNode.name,
              deepSnapshot,
              pre.w,
              pre.h,
              ""
            ),
            selection: { nodes: [deepSnapshot] },
            designSystem: {
              textStyles: [],
              fillStyles: [],
              components: [],
              variables: []
            },
            apiKey: _userApiKey,
            provider: _selectedProvider,
            model: _selectedModel
          };
          try {
            const refineBatch = await fetchViaUIForJob("/plan?lenient=true", refinementPayload, job.id);
            if (refineBatch.operations && refineBatch.operations.length > 0) {
              _skipResizePropagation = true;
              try {
                for (const refOp of refineBatch.operations) {
                  await applyOperation(refOp);
                }
              } finally {
                _skipResizePropagation = false;
              }
            }
          } catch (err) {
            console.warn(
              `[edit-job ${job.id}] Content refinement skipped: ${err.message}`
            );
          }
          const circles = preResizeCircles[rop.nodeId];
          if (circles && circles.size > 0) {
            enforceCirclesFromSet(circles);
          }
          const sectionNode = targetNode;
          const origSiblings = preResizeSiblingPositions[rop.nodeId] || [];
          if (origSiblings.length > 0) {
            const sectionBottom = sectionNode.y + sectionNode.height;
            const preDims = preResizeDims[rop.nodeId];
            const preSectionBottom = sectionNode.y + (preDims ? preDims.h : sectionNode.height);
            let cursor = sectionBottom;
            for (let si = 0; si < origSiblings.length; si++) {
              const origSib = origSiblings[si];
              const currentSib = figma.getNodeById(origSib.id);
              if (!currentSib) continue;
              const origGap = si === 0 ? origSib.y - preSectionBottom : origSib.y - (origSiblings[si - 1].y + origSiblings[si - 1].height);
              const gap = Math.max(origGap, 0);
              const desiredY = cursor + gap;
              if (Math.abs(currentSib.y - desiredY) > 1) {
                currentSib.y = desiredY;
              }
              cursor = currentSib.y + currentSib.height;
            }
          }
        }
      }
      figma.notify(summary, { timeout: 4e3 });
      sendToUI({ type: "job-complete", jobId: job.id, summary });
    } catch (err) {
      console.error(`[edit-job ${job.id}] Error:`, err.message, err.stack);
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      sendToUI({ type: "job-error", jobId: job.id, error: `Edit failed: ${err.message}` });
    } finally {
      _activeJobs.delete(job.id);
    }
  }
  async function buildImageMap(nodes) {
    const map = /* @__PURE__ */ new Map();
    async function walk(node, pathPrefix) {
      const isShapeNode = [
        "VECTOR",
        "BOOLEAN_OPERATION",
        "STAR",
        "POLYGON",
        "LINE",
        "ELLIPSE",
        "RECTANGLE"
      ].includes(node.type);
      const isIconGroup = node.type === "GROUP" && "children" in node && node.children.every(
        (c) => ["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE", "ELLIPSE", "RECTANGLE", "GROUP"].includes(c.type)
      );
      let hasImageFill = false;
      if ("fills" in node) {
        try {
          const fills = node.fills;
          if (Array.isArray(fills) && fills.some((f) => f.type === "IMAGE")) hasImageFill = true;
        } catch (_) {
        }
      }
      if (isShapeNode || isIconGroup || hasImageFill) {
        try {
          const bytes = await node.exportAsync({
            format: "PNG",
            constraint: { type: "SCALE", value: 2 }
          });
          const b64 = uint8ToBase64(bytes);
          const key = node.name.trim().toLowerCase();
          if (!map.has(key)) {
            map.set(key, { imageData: b64, width: Math.round(node.width), height: Math.round(node.height), type: node.type });
          }
          const pathKey = (pathPrefix + "/" + node.name).trim().toLowerCase();
          if (!map.has(pathKey)) {
            map.set(pathKey, { imageData: b64, width: Math.round(node.width), height: Math.round(node.height), type: node.type });
          }
        } catch (_) {
        }
        if (isShapeNode || isIconGroup) return;
      }
      if ("children" in node) {
        for (const child of node.children) {
          await walk(child, pathPrefix + "/" + node.name);
        }
      }
    }
    for (const node of nodes) {
      await walk(node, "");
    }
    return map;
  }
  function transplantImages(snap, imageMap, parentPath) {
    if (!snap) return 0;
    let count = 0;
    const key = (snap.name || "").trim().toLowerCase();
    const pathKey = (parentPath + "/" + (snap.name || "")).trim().toLowerCase();
    if (!snap.imageData && key) {
      const match = imageMap.get(pathKey) || imageMap.get(key);
      if (match) {
        snap.imageData = match.imageData;
        if (!snap.width || !snap.height) {
          snap.width = match.width;
          snap.height = match.height;
        }
        count++;
      }
    }
    if (Array.isArray(snap.children)) {
      for (const child of snap.children) {
        count += transplantImages(child, imageMap, parentPath + "/" + (snap.name || ""));
      }
    }
    return count;
  }
  async function runGenerateJob(job, prompt, sourceSnapshot, sourcePosition, sourceNodeIds) {
    try {
      sendToUI({ type: "job-progress", jobId: job.id, phase: "analyze" });
      await yieldToUI();
      console.log(`[job ${job.id}] Extracting design system...`);
      const designSystem = await extractDesignSystemSnapshot();
      console.log(`[job ${job.id}] Design system extracted.`);
      await yieldToUI();
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      const styleTokens = await extractStyleTokens(prompt);
      console.log(`[job ${job.id}] Style tokens extracted.`);
      await yieldToUI();
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      sendToUI({ type: "job-progress", jobId: job.id, phase: "generate" });
      const selectionSnapshot = sourceSnapshot || extractSelectionSnapshot();
      console.log(`[job ${job.id}] Selection: ${selectionSnapshot.nodes.length} node(s)`);
      const truncatedSelection = {
        nodes: selectionSnapshot.nodes.map((n) => truncateSnapshotForGenerate(n))
      };
      if (styleTokens && styleTokens.referenceSnapshots && styleTokens.referenceSnapshots.length > 0) {
        styleTokens.referenceSnapshots = styleTokens.referenceSnapshots.map(
          (s) => truncateSnapshotForGenerate(s, 8e4)
        );
      }
      const trimmedDesignSystem = {
        textStyles: (designSystem.textStyles || []).slice(0, 12),
        fillStyles: (designSystem.fillStyles || []).slice(0, 12),
        components: [],
        variables: []
      };
      const payloadToSend = __spreadValues({
        prompt,
        styleTokens,
        designSystem: trimmedDesignSystem,
        selection: truncatedSelection,
        apiKey: _userApiKey,
        provider: _selectedProvider,
        model: _selectedModel
      }, _fullDesignSystem ? { fullDesignSystem: _fullDesignSystem } : {});
      const payloadJson = JSON.stringify(payloadToSend);
      console.log(`[job ${job.id}] PAYLOAD SIZE: ${payloadJson.length} chars (~${Math.round(payloadJson.length / 4)} tokens)`);
      console.log(`[job ${job.id}] selection: ${JSON.stringify(truncatedSelection).length} chars, styleTokens: ${JSON.stringify(styleTokens).length} chars, designSystem: ${JSON.stringify(trimmedDesignSystem).length} chars`);
      console.log(`[job ${job.id}] Calling backend /generate...`);
      let result;
      try {
        result = await fetchViaUIForJob("/generate", payloadToSend, job.id);
      } catch (err) {
        if (job.cancelled) {
          console.log(`[job ${job.id}] Fetch cancelled by user.`);
          sendToUI({ type: "job-cancelled", jobId: job.id });
          return;
        }
        console.error(`[job ${job.id}] Fetch error:`, err.message);
        sendToUI({ type: "job-error", jobId: job.id, error: `Backend error: ${err.message}` });
        return;
      }
      const snapshot = result.snapshot;
      if (!snapshot || !snapshot.type) {
        console.error(`[job ${job.id}] Invalid snapshot:`, JSON.stringify(result).slice(0, 200));
        sendToUI({ type: "job-error", jobId: job.id, error: "Backend returned invalid frame data." });
        return;
      }
      console.log(`[job ${job.id}] Snapshot received:`, snapshot.name, snapshot.type);
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      const resolvedSourceNodes = [];
      if (sourceNodeIds && sourceNodeIds.length > 0) {
        for (const nid of sourceNodeIds) {
          const found = figma.getNodeById(nid);
          if (found && "type" in found && found.type !== "DOCUMENT" && found.type !== "PAGE") {
            resolvedSourceNodes.push(found);
          }
        }
      } else {
        resolvedSourceNodes.push(...figma.currentPage.selection);
      }
      if (resolvedSourceNodes.length > 0) {
        console.log(`[job ${job.id}] Building image map from ${resolvedSourceNodes.length} source node(s)...`);
        const imageMap = await buildImageMap(resolvedSourceNodes);
        console.log(`[job ${job.id}] Image map: ${imageMap.size} entries`);
        if (imageMap.size > 0) {
          const transplanted = transplantImages(snapshot, imageMap, "");
          console.log(`[job ${job.id}] Transplanted ${transplanted} image(s) into generated snapshot`);
        }
      }
      sendToUI({ type: "job-progress", jobId: job.id, phase: "create" });
      assignTempIds(snapshot);
      _importStats = { texts: 0, frames: 0, images: 0, failed: 0, errors: [] };
      clearStyleMaps();
      const modeHint = `${prompt} ${snapshot.name || ""} ${(sourcePosition == null ? void 0 : sourcePosition.name) || ""}`;
      _currentThemeMode = detectThemeMode(modeHint);
      console.log(`[job ${job.id}] Theme mode detected: ${_currentThemeMode} (from: "${modeHint.trim()}")`);
      let placeX;
      let placeY;
      const frameW = snapshot.width || 390;
      const frameH = snapshot.height || 800;
      const GAP = 100;
      if (sourcePosition) {
        let hasCollision2 = function(cx, cy, cw, ch) {
          for (const ob of obstacles) {
            if (cx < ob.x + ob.w && cx + cw > ob.x && cy < ob.y + ob.h && cy + ch > ob.y) {
              return true;
            }
          }
          return false;
        };
        var hasCollision = hasCollision2;
        const candidates = [
          // 1. Right of source
          { x: sourcePosition.x + sourcePosition.width + GAP, y: sourcePosition.y },
          // 2. Below source
          { x: sourcePosition.x, y: sourcePosition.y + sourcePosition.height + GAP },
          // 3. Further right (past 2x source width gap)
          { x: sourcePosition.x + sourcePosition.width + GAP + frameW + GAP, y: sourcePosition.y },
          // 4. Below-right
          { x: sourcePosition.x + sourcePosition.width + GAP, y: sourcePosition.y + sourcePosition.height + GAP },
          // 5. Far right (3x gap)
          { x: sourcePosition.x + sourcePosition.width + GAP + (frameW + GAP) * 2, y: sourcePosition.y }
        ];
        const obstacles = [];
        for (const child of figma.currentPage.children) {
          obstacles.push({
            x: child.x,
            y: child.y,
            w: child.width,
            h: child.height
          });
        }
        let placed = false;
        for (const c of candidates) {
          if (!hasCollision2(c.x, c.y, frameW, frameH)) {
            placeX = c.x;
            placeY = c.y;
            placed = true;
            console.log(`[job ${job.id}] Found empty spot near "${sourcePosition.name}" at x:${placeX}, y:${placeY}`);
            break;
          }
        }
        if (!placed) {
          let maxBottom = sourcePosition.y + sourcePosition.height;
          for (const ob of obstacles) {
            if (ob.x < sourcePosition.x + sourcePosition.width + GAP + frameW && ob.x + ob.w > sourcePosition.x) {
              const bottom = ob.y + ob.h;
              if (bottom > maxBottom) maxBottom = bottom;
            }
          }
          placeX = sourcePosition.x;
          placeY = maxBottom + GAP;
          console.log(`[job ${job.id}] Fallback placement below everything at x:${placeX}, y:${placeY}`);
        }
      } else if (_nextPlaceX !== null) {
        placeX = _nextPlaceX;
        placeY = 0;
      } else {
        placeX = 0;
        placeY = 0;
        const existingChildren = figma.currentPage.children;
        if (existingChildren.length > 0) {
          let maxRight = -Infinity;
          for (const child of existingChildren) {
            const right = child.x + child.width;
            if (right > maxRight) maxRight = right;
          }
          placeX = maxRight + 200;
        }
      }
      if (!sourcePosition) {
        _nextPlaceX = placeX + (snapshot.width || 1440) + 200;
      }
      const isComponentSetSnapshot = snapshot.type === "COMPONENT_SET";
      if (sourcePosition && sourcePosition.width > 0 && sourcePosition.height > 0 && !isComponentSetSnapshot) {
        snapshot.width = sourcePosition.width;
        snapshot.height = sourcePosition.height;
        snapshot.layoutSizingVertical = "FIXED";
        snapshot.layoutSizingHorizontal = "FIXED";
        console.log(`[job ${job.id}] Forced snapshot to ${sourcePosition.width}x${sourcePosition.height} FIXED`);
      }
      console.log(`[job ${job.id}] Creating ${isComponentSetSnapshot ? "COMPONENT_SET" : "frame"} on canvas at x:${placeX}, y:${placeY}...`);
      const node = await createNodeFromSnapshot(snapshot, figma.currentPage);
      if (node) {
        node.x = placeX;
        node.y = placeY;
        if (sourcePosition && "resize" in node && node.type !== "COMPONENT_SET") {
          const targetW = sourcePosition.width;
          const targetH = sourcePosition.height;
          if (targetW > 0 && targetH > 0) {
            const frame = node;
            try {
              frame.layoutSizingHorizontal = "FIXED";
            } catch (_) {
            }
            try {
              frame.layoutSizingVertical = "FIXED";
            } catch (_) {
            }
            if ("primaryAxisSizingMode" in frame) {
              try {
                frame.primaryAxisSizingMode = "FIXED";
              } catch (_) {
              }
              try {
                frame.counterAxisSizingMode = "FIXED";
              } catch (_) {
              }
            }
            frame.resize(targetW, targetH);
            console.log(`[job ${job.id}] Resized to match source: ${targetW}x${targetH} (FIXED sizing, primaryAxis=${frame.primaryAxisSizingMode}, counterAxis=${frame.counterAxisSizingMode})`);
            if (Math.abs(frame.width - targetW) > 1 || Math.abs(frame.height - targetH) > 1) {
              console.warn(`[job ${job.id}] Resize did NOT stick! Actual: ${frame.width}x${frame.height}. Trying layoutMode toggle...`);
              const savedMode = frame.layoutMode;
              const savedPadT = frame.paddingTop, savedPadR = frame.paddingRight;
              const savedPadB = frame.paddingBottom, savedPadL = frame.paddingLeft;
              const savedSpacing = frame.itemSpacing;
              const savedPrimary = frame.primaryAxisAlignItems;
              const savedCounter = frame.counterAxisAlignItems;
              frame.layoutMode = "NONE";
              frame.resize(targetW, targetH);
              frame.layoutMode = savedMode;
              frame.paddingTop = savedPadT;
              frame.paddingRight = savedPadR;
              frame.paddingBottom = savedPadB;
              frame.paddingLeft = savedPadL;
              frame.itemSpacing = savedSpacing;
              frame.primaryAxisAlignItems = savedPrimary;
              frame.counterAxisAlignItems = savedCounter;
              try {
                frame.primaryAxisSizingMode = "FIXED";
              } catch (_) {
              }
              try {
                frame.counterAxisSizingMode = "FIXED";
              } catch (_) {
              }
              frame.resize(targetW, targetH);
              console.log(`[job ${job.id}] After toggle: ${frame.width}x${frame.height} primaryAxis=${frame.primaryAxisSizingMode}`);
            }
          }
        }
        if ("setPluginData" in node) {
          node.setPluginData("generated", "true");
        }
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
        const actualRight = placeX + node.width + 200;
        if (actualRight > (_nextPlaceX || 0)) _nextPlaceX = actualRight;
        console.log(`[job ${job.id}] Frame created.`);
      } else {
        console.warn(`[job ${job.id}] createNodeFromSnapshot returned null`);
      }
      const genStats = `Generated "${snapshot.name || "Frame"}": ${_importStats.frames} frames, ${_importStats.texts} texts`;
      figma.notify(genStats, { timeout: 4e3 });
      sendToUI({ type: "job-complete", jobId: job.id, summary: genStats });
    } catch (err) {
      console.error(`[job ${job.id}] Error:`, err.message, err.stack);
      if (job.cancelled) {
        sendToUI({ type: "job-cancelled", jobId: job.id });
        return;
      }
      sendToUI({ type: "job-error", jobId: job.id, error: `Generation failed: ${err.message}` });
    } finally {
      _activeJobs.delete(job.id);
      if (_activeJobs.size === 0) _nextPlaceX = null;
    }
  }
  figma.ui.onmessage = async (msg) => {
    var _a, _b;
    try {
      switch (msg.type) {
        // ── UI ready handshake ────────────────────────────────
        case "ui-ready": {
          loadCachedFullDesignSystem().catch(() => {
          });
          return;
        }
        // ── Resize enforcement ────────────────────────────────
        case "resize": {
          const w = Math.max(msg.width || MIN_WIDTH, MIN_WIDTH);
          const h = Math.max(msg.height || MIN_HEIGHT, MIN_HEIGHT);
          figma.ui.resize(w, h);
          return;
        }
        // ── Cancel in-flight request (serial plan+apply) ─────
        case "cancel": {
          _cancelled = true;
          _working = false;
          if (_pendingFetch) {
            _pendingFetch.reject(new Error("Cancelled"));
            _pendingFetch = null;
          }
          return;
        }
        // ── Cancel a specific generate job ────────────────────
        case "cancel-job": {
          const jobId = msg.jobId;
          const job = _activeJobs.get(jobId);
          if (job) {
            job.cancelled = true;
            for (const [seq, pf] of _pendingFetches) {
              if (pf.jobId === jobId) {
                pf.reject(new Error("Cancelled"));
                _pendingFetches.delete(seq);
                break;
              }
            }
          }
          return;
        }
        // ── Fetch proxy responses from UI iframe ──────────────
        case "fetch-result": {
          const seq = msg.seq;
          const pf = _pendingFetches.get(seq);
          if (pf) {
            pf.resolve(msg.data);
            _pendingFetches.delete(seq);
            return;
          }
          if (_pendingFetch && _pendingFetch.seq === seq) {
            _pendingFetch.resolve(msg.data);
            _pendingFetch = null;
          }
          return;
        }
        case "fetch-error": {
          const seq = msg.seq;
          const pf2 = _pendingFetches.get(seq);
          if (pf2) {
            pf2.reject(new Error(msg.error || "Fetch failed"));
            _pendingFetches.delete(seq);
            return;
          }
          if (_pendingFetch && _pendingFetch.seq === seq) {
            _pendingFetch.reject(new Error(msg.error || "Fetch failed"));
            _pendingFetch = null;
          }
          return;
        }
        case "fetch-aborted": {
          const seq = msg.seq;
          const pf3 = _pendingFetches.get(seq);
          if (pf3) {
            pf3.reject(new Error("Cancelled"));
            _pendingFetches.delete(seq);
            return;
          }
          if (_pendingFetch && _pendingFetch.seq === seq) {
            _pendingFetch.reject(new Error("Cancelled"));
            _pendingFetch = null;
          }
          return;
        }
        // ── Persist audit timings from UI ─────────────────────
        case "save-audit-timings": {
          try {
            const timings = msg.timings;
            await figma.clientStorage.setAsync("auditTimings", JSON.stringify(timings));
            console.log("[a11y] Saved audit timings");
          } catch (e) {
            console.warn("[a11y] Failed to save audit timings:", e);
          }
          return;
        }
        // ── Persist state audit timings from UI ───────────────
        case "save-state-audit-timings": {
          try {
            const timings = msg.timings;
            await figma.clientStorage.setAsync("stateAuditTimings", JSON.stringify(timings));
            console.log("[state-audit] Saved state audit timings");
          } catch (e) {
            console.warn("[state-audit] Failed to save state audit timings:", e);
          }
          return;
        }
        // ── Persist phase timings from UI ─────────────────────
        case "save-timings": {
          try {
            const timings = msg.timings;
            await figma.clientStorage.setAsync("phaseTimings", JSON.stringify(timings));
            console.log("[timings] Saved phase timings:", timings);
          } catch (e) {
            console.warn("[timings] Failed to save:", e);
          }
          return;
        }
        // ── Persist API key from UI ───────────────────────────
        case "save-api-key": {
          try {
            const key = msg.key || "";
            const provider = msg.provider || _selectedProvider;
            _userApiKey = key;
            await figma.clientStorage.setAsync(`apiKey_${provider}`, key);
            console.log(`[api-key] API key saved for provider=${provider}.`);
          } catch (e) {
            console.warn("[api-key] Failed to save API key:", e);
          }
          return;
        }
        // ── Persist provider/model selection ───────────────────
        case "save-provider-selection": {
          try {
            const provider = msg.provider || "anthropic";
            const model = msg.model || "";
            _selectedProvider = provider;
            _selectedModel = model;
            await figma.clientStorage.setAsync("selectedProvider", provider);
            await figma.clientStorage.setAsync("selectedModel", model);
            const savedKey = await figma.clientStorage.getAsync(`apiKey_${provider}`);
            _userApiKey = savedKey || "";
            console.log(`[settings] Provider=${provider}, model=${model}, key=${_userApiKey ? "set" : "empty"}`);
          } catch (e) {
            console.warn("[settings] Failed to save provider selection:", e);
          }
          return;
        }
        // ── Accessibility Audit ───────────────────────────────
        case "audit-a11y": {
          try {
            sendToUI({ type: "status", message: "Running accessibility audit\u2026" });
            let nodesToAudit = [];
            let auditScope = "all";
            if (figma.currentPage.selection.length > 0) {
              nodesToAudit = [...figma.currentPage.selection];
              if (nodesToAudit.length === 1 && nodesToAudit[0].type === "FRAME") {
                auditScope = "frame";
              } else {
                auditScope = "component";
              }
            } else {
              nodesToAudit = figma.currentPage.children.filter(
                (n) => n.type === "FRAME" && n.name !== CHANGE_LOG_FRAME_NAME && n.name !== AUDIT_BADGE_FRAME_NAME && !n.name.startsWith("a11y-badge:")
              );
              auditScope = "all";
            }
            if (nodesToAudit.length === 0) {
              sendToUI({ type: "audit-error", error: "No frames found to audit." });
              break;
            }
            sendToUI({ type: "audit-phase", phase: "scanning", scope: auditScope });
            console.log(`[a11y] Auditing ${nodesToAudit.length} node(s) [scope=${auditScope}]\u2026`);
            const findings = runAccessibilityAudit(nodesToAudit);
            console.log(`[a11y] Found ${findings.length} issue(s).`);
            if (findings.length > 0 && _userApiKey) {
              try {
                sendToUI({ type: "audit-phase", phase: "enhancing" });
                sendToUI({ type: "status", message: `Found ${findings.length} issue(s) \u2014 getting AI suggestions\u2026` });
                const auditBody = {
                  findings: findings.slice(0, 30),
                  // cap for token limits
                  apiKey: _userApiKey,
                  provider: _selectedProvider,
                  model: _selectedModel
                };
                const enriched = await fetchViaUI("/audit", auditBody);
                if (enriched && enriched.findings) {
                  for (const ef of enriched.findings) {
                    const match = findings.find((f) => f.nodeId === ef.nodeId && f.checkType === ef.checkType);
                    if (match && ef.suggestion) {
                      match.suggestion = ef.suggestion;
                    }
                  }
                }
              } catch (llmErr) {
                console.warn("[a11y] LLM enrichment failed, returning raw findings:", llmErr.message);
              }
            }
            createAuditBadges(findings);
            sendToUI({ type: "audit-results", findings });
            figma.notify(`Accessibility audit: ${findings.length} issue(s) found.`, { timeout: 4e3 });
          } catch (err) {
            console.error("[a11y] Audit error:", err);
            sendToUI({ type: "audit-error", error: err.message || "Audit failed." });
          }
          break;
        }
        // ── Clear Audit Badges ────────────────────────────────
        case "clear-audit": {
          clearAuditBadges();
          figma.notify("Audit badges cleared.", { timeout: 2e3 });
          break;
        }
        // ── Fix Single Finding ────────────────────────────────
        case "fix-finding": {
          const finding = msg.finding;
          if (!finding) {
            sendToUI({ type: "fix-result", nodeId: "", checkType: "", success: false, message: "No finding provided." });
            break;
          }
          try {
            let resultMsg;
            if (finding.fixType === "auto") {
              resultMsg = await applyAutoFix(finding);
            } else if (finding.fixType === "llm") {
              sendToUI({ type: "status", message: `Getting AI fix for "${finding.nodeName}"\u2026` });
              resultMsg = await applyLLMFix(finding);
            } else {
              sendToUI({ type: "fix-result", nodeId: finding.nodeId, checkType: finding.checkType, success: false, message: "This issue requires manual fixing." });
              break;
            }
            sendToUI({ type: "fix-result", nodeId: finding.nodeId, checkType: finding.checkType, success: true, message: resultMsg });
            figma.notify(`Fixed: ${resultMsg}`, { timeout: 3e3 });
          } catch (err) {
            console.error("[fix] Error:", err);
            sendToUI({ type: "fix-result", nodeId: finding.nodeId, checkType: finding.checkType, success: false, message: err.message || "Fix failed." });
            figma.notify(`Fix failed: ${err.message}`, { timeout: 3e3, error: true });
          }
          break;
        }
        // ── Fix All Auto-Fixable Findings ─────────────────────
        case "fix-all-auto": {
          const allFindings = msg.findings || [];
          const autoFindings = allFindings.filter((f) => f.fixType === "auto");
          if (autoFindings.length === 0) {
            sendToUI({ type: "fix-all-complete", results: [] });
            figma.notify("No auto-fixable issues found.", { timeout: 3e3 });
            break;
          }
          sendToUI({ type: "status", message: `Fixing ${autoFindings.length} issue(s)\u2026` });
          const results = [];
          for (const f of autoFindings) {
            try {
              const resultMsg = await applyAutoFix(f);
              results.push({ nodeId: f.nodeId, checkType: f.checkType, success: true, message: resultMsg });
            } catch (err) {
              results.push({ nodeId: f.nodeId, checkType: f.checkType, success: false, message: err.message || "Fix failed." });
            }
          }
          const successCount = results.filter((r) => r.success).length;
          sendToUI({ type: "fix-all-complete", results });
          figma.notify(`Fixed ${successCount} of ${autoFindings.length} issue(s).`, { timeout: 4e3 });
          break;
        }
        // ── UI State Audit ────────────────────────────────────
        case "audit-states": {
          try {
            let walkForStateAudit2 = function(node) {
              var _a2;
              if (items.length >= MAX_ITEMS) return;
              if (node.type === "COMPONENT_SET") {
                const variantNames = node.children.map((c) => c.name);
                items.push({
                  nodeId: node.id,
                  name: node.name,
                  itemType: "component",
                  variants: variantNames.slice(0, 30)
                });
                return;
              }
              if (node.type === "COMPONENT") {
                if (((_a2 = node.parent) == null ? void 0 : _a2.type) !== "COMPONENT_SET") {
                  items.push({
                    nodeId: node.id,
                    name: node.name,
                    itemType: "component",
                    childNames: "children" in node ? node.children.map((c) => c.name).slice(0, 20) : []
                  });
                }
                return;
              }
              if (node.type === "FRAME" && (node.parent === figma.currentPage || sel.includes(node))) {
                if ("children" in node && node.children.length > 0) {
                  const childNames = node.children.map((c) => c.name).slice(0, 30);
                  items.push({
                    nodeId: node.id,
                    name: node.name,
                    itemType: "screen",
                    childNames
                  });
                }
              }
              if ("children" in node) {
                for (const child of node.children) {
                  if (items.length >= MAX_ITEMS) break;
                  walkForStateAudit2(child);
                }
              }
            };
            var walkForStateAudit = walkForStateAudit2;
            sendToUI({ type: "status", message: "Scanning for components and screens\u2026" });
            let scope = "all";
            const sel = figma.currentPage.selection;
            if (sel.length > 0) {
              if (sel.length === 1 && sel[0].type === "FRAME") scope = "frame";
              else scope = "component";
            }
            sendToUI({ type: "state-audit-phase", phase: "scanning", scope });
            const items = [];
            const MAX_ITEMS = 20;
            const roots = sel.length > 0 ? sel : figma.currentPage.children.filter(
              (n) => n.type === "FRAME" && n.name !== CHANGE_LOG_FRAME_NAME && n.name !== AUDIT_BADGE_FRAME_NAME && !n.name.startsWith("a11y-badge:")
            );
            for (const root of roots) {
              if (items.length >= MAX_ITEMS) break;
              walkForStateAudit2(root);
            }
            if (items.length === 0) {
              sendToUI({ type: "state-audit-error", error: "No components or screens found to audit." });
              break;
            }
            console.log(`[state-audit] Found ${items.length} item(s) to audit [scope=${scope}]`);
            sendToUI({ type: "state-audit-phase", phase: "analyzing" });
            sendToUI({ type: "status", message: `Analyzing ${items.length} item(s) for UI states\u2026` });
            const stateBody = {
              items,
              apiKey: _userApiKey,
              provider: _selectedProvider,
              model: _selectedModel
            };
            const result = await fetchViaUI("/audit-states", stateBody);
            if (result && result.items) {
              sendToUI({ type: "state-audit-results", items: result.items });
              const missingCount = result.items.reduce((sum, it) => {
                var _a2;
                return sum + (((_a2 = it.missingStates) == null ? void 0 : _a2.length) || 0);
              }, 0);
              figma.notify(`State audit: ${missingCount} missing state(s) found across ${result.items.length} item(s).`, { timeout: 4e3 });
            } else {
              sendToUI({ type: "state-audit-error", error: "No results returned from analysis." });
            }
          } catch (err) {
            console.error("[state-audit] Error:", err);
            sendToUI({ type: "state-audit-error", error: err.message || "State audit failed." });
          }
          break;
        }
        // ── Select a node by ID (from audit results panel) ────
        case "select-node": {
          const nodeId = msg.nodeId;
          if (nodeId) {
            const targetNode = figma.getNodeById(nodeId);
            if (targetNode) {
              figma.currentPage.selection = [targetNode];
              figma.viewport.scrollAndZoomIntoView([targetNode]);
            }
          }
          break;
        }
        // ── Run (plan + apply in one step) ─────────────────────
        case "run": {
          const intentText = msg.intent || "";
          const intentLower = intentText.toLowerCase();
          const hasVariantKeyword = /\bvariants?\b/i.test(intentText) || /\bstates?\b/i.test(intentText);
          const hasCreateKeyword = /\b(create|make|add|generate|missing)\b/i.test(intentText);
          const selectionIsComponentSet = figma.currentPage.selection.length > 0 && figma.currentPage.selection[0].type === "COMPONENT_SET";
          const isCreateVariantsIntent = hasVariantKeyword && hasCreateKeyword || selectionIsComponentSet && hasCreateKeyword && hasVariantKeyword;
          const isCreateComponentIntent = /\b(create|make|convert|turn)\b.+\bcomponent\b/i.test(intentText) && !/\bcomponent\s*set\b/i.test(intentText) && !isCreateVariantsIntent;
          const isDetachInstanceIntent = /\b(detach|unlink|disconnect)\b.+\b(instance|component)\b/i.test(intentText) || /\binstance\b.+\b(detach|unlink)\b/i.test(intentText);
          const isGroupIntent = /\b(group)\b.+\b(selection|selected|these|nodes?|layers?|elements?)\b/i.test(intentText) || /\b(selection|selected|these)\b.+\bgroup\b/i.test(intentText);
          const isUngroupIntent = /\b(ungroup|un-group)\b/i.test(intentText);
          const isFlattenIntent = /\b(flatten)\b.+\b(selection|selected|these|nodes?|layers?|elements?)\b/i.test(intentText) || /\bflatten\s+(this|it)\b/i.test(intentText);
          const isAutoLayoutIntent = /\bauto[\s-]?layout\b/i.test(intentText) || /\b(add|apply|set|enable|convert|turn\s+on)\b/i.test(intentText) && /\b(layout|auto[\s-]?layout)\b/i.test(intentText);
          const isCleanupIntent = /\b(clean\s*up|cleanup|tidy\s*(up)?|neaten|straighten)\b/i.test(intentText) || /\b(consistent|normalize|standardize|even\s*out|fix|align|regularize)\b/i.test(intentText) && /\b(padding|margins?|spacing|gaps?|layout|alignment|indentation)\b/i.test(intentText);
          if (isCreateComponentIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select a frame or element first.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobId = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobId, prompt: intentText });
            let customName = null;
            const nameMatch = intentText.match(
              /\b(?:called|named|name(?:d)?|as)\s+["']?([A-Za-z0-9_\-/ ]+?)["']?\s*$/i
            ) || intentText.match(
              /\bcomponent\s+["']([A-Za-z0-9_\-/ ]+?)["']/i
            ) || intentText.match(
              /["']([A-Za-z0-9_\-/ ]+?)["']/i
            );
            if (nameMatch) customName = nameMatch[1].trim();
            try {
              const created = [];
              for (let ni = 0; ni < selection.length; ni++) {
                let detachNestedInstances2 = function(n) {
                  if (!("children" in n)) return;
                  const container = n;
                  for (let ci = 0; ci < container.children.length; ci++) {
                    const child = container.children[ci];
                    if (child.type === "INSTANCE") {
                      const detached = child.detachInstance();
                      detachNestedInstances2(detached);
                    } else {
                      detachNestedInstances2(child);
                    }
                  }
                };
                var detachNestedInstances = detachNestedInstances2;
                const node = selection[ni];
                const isInsideInstance = (() => {
                  let cur = node.parent;
                  while (cur) {
                    if (cur.type === "INSTANCE") return true;
                    cur = "parent" in cur ? cur.parent : null;
                  }
                  return false;
                })();
                let clone = node.clone();
                if (clone.type === "INSTANCE") {
                  clone = clone.detachInstance();
                }
                detachNestedInstances2(clone);
                const comp = figma.createComponent();
                comp.resize(clone.width, clone.height);
                if ("fills" in clone) {
                  try {
                    comp.fills = JSON.parse(JSON.stringify(clone.fills));
                  } catch (_) {
                  }
                }
                if ("strokes" in clone) {
                  try {
                    comp.strokes = JSON.parse(JSON.stringify(clone.strokes));
                    comp.strokeWeight = clone.strokeWeight;
                    comp.strokeAlign = clone.strokeAlign;
                    if ("strokeTopWeight" in clone) {
                      comp.strokeTopWeight = clone.strokeTopWeight;
                      comp.strokeRightWeight = clone.strokeRightWeight;
                      comp.strokeBottomWeight = clone.strokeBottomWeight;
                      comp.strokeLeftWeight = clone.strokeLeftWeight;
                    }
                  } catch (_) {
                  }
                }
                if ("cornerRadius" in clone) {
                  try {
                    comp.cornerRadius = clone.cornerRadius;
                  } catch (_) {
                  }
                }
                if ("topLeftRadius" in clone) {
                  try {
                    comp.topLeftRadius = clone.topLeftRadius;
                    comp.topRightRadius = clone.topRightRadius;
                    comp.bottomLeftRadius = clone.bottomLeftRadius;
                    comp.bottomRightRadius = clone.bottomRightRadius;
                  } catch (_) {
                  }
                }
                if ("clipsContent" in clone) {
                  comp.clipsContent = clone.clipsContent;
                }
                if ("opacity" in clone) {
                  comp.opacity = clone.opacity;
                }
                if ("effects" in clone) {
                  try {
                    comp.effects = JSON.parse(JSON.stringify(clone.effects));
                  } catch (_) {
                  }
                }
                if ("blendMode" in clone) {
                  try {
                    comp.blendMode = clone.blendMode;
                  } catch (_) {
                  }
                }
                if ("layoutMode" in clone && clone.layoutMode !== "NONE") {
                  const f = clone;
                  comp.layoutMode = f.layoutMode;
                  comp.primaryAxisSizingMode = f.primaryAxisSizingMode;
                  comp.counterAxisSizingMode = f.counterAxisSizingMode;
                  comp.primaryAxisAlignItems = f.primaryAxisAlignItems;
                  comp.counterAxisAlignItems = f.counterAxisAlignItems;
                  comp.paddingTop = f.paddingTop;
                  comp.paddingRight = f.paddingRight;
                  comp.paddingBottom = f.paddingBottom;
                  comp.paddingLeft = f.paddingLeft;
                  comp.itemSpacing = f.itemSpacing;
                  if ("counterAxisSpacing" in f) comp.counterAxisSpacing = f.counterAxisSpacing;
                  if ("layoutWrap" in f) comp.layoutWrap = f.layoutWrap;
                }
                if ("children" in clone) {
                  const children = [...clone.children];
                  for (const child of children) {
                    comp.appendChild(child);
                  }
                }
                comp.name = customName && selection.length === 1 ? customName : customName ? `${customName} ${ni + 1}` : node.name;
                comp.x = node.x;
                comp.y = node.y;
                const parent = node.parent;
                if (parent && "children" in parent && !isInsideInstance) {
                  const idx = parent.children.indexOf(node);
                  if (idx >= 0) {
                    parent.insertChild(idx, comp);
                  } else {
                    parent.appendChild(comp);
                  }
                  node.remove();
                } else {
                  figma.currentPage.appendChild(comp);
                }
                clone.remove();
                created.push(comp);
              }
              if (created.length > 0) {
                figma.currentPage.selection = created;
                const summary = `Created component${created.length > 1 ? "s" : ""}: ${created.map((c) => c.name).join(", ")}`;
                figma.notify(summary, { timeout: 4e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobId, summary });
              } else {
                sendToUI({ type: "job-complete", jobId: nativeJobId, summary: "No components created." });
              }
            } catch (err) {
              figma.notify(`Failed to create component: ${err.message}`, { timeout: 4e3 });
              sendToUI({ type: "job-error", jobId: nativeJobId, error: `Failed: ${err.message}` });
            }
            break;
          }
          if (isCreateVariantsIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select a frame or element first.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobIdV = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobIdV, prompt: intentText });
            try {
              let cloneAsComponent2 = function(src, varName, pName) {
                var _a2;
                let clone = src.clone();
                if (clone.type === "INSTANCE") {
                  clone = clone.detachInstance();
                }
                function detachNested(n) {
                  if (!("children" in n)) return;
                  const container = n;
                  for (let ci = 0; ci < container.children.length; ci++) {
                    const child = container.children[ci];
                    if (child.type === "INSTANCE") {
                      const det = child.detachInstance();
                      detachNested(det);
                    } else {
                      detachNested(child);
                    }
                  }
                }
                detachNested(clone);
                if (clone.type === "COMPONENT") {
                  clone.name = `${pName}=${varName}`;
                  console.log(`[Variants] cloneAsComponent: COMPONENT path \u2014 ${((_a2 = clone.children) == null ? void 0 : _a2.length) || 0} children preserved`);
                  return clone;
                }
                const comp = figma.createComponent();
                comp.name = `${pName}=${varName}`;
                comp.resize(clone.width, clone.height);
                comp.fills = [];
                comp.clipsContent = false;
                clone.x = 0;
                clone.y = 0;
                comp.appendChild(clone);
                comp.layoutMode = "VERTICAL";
                comp.primaryAxisSizingMode = "AUTO";
                comp.counterAxisSizingMode = "AUTO";
                comp.paddingTop = 0;
                comp.paddingRight = 0;
                comp.paddingBottom = 0;
                comp.paddingLeft = 0;
                if ("layoutSizingHorizontal" in clone) {
                  try {
                    clone.layoutSizingHorizontal = "FILL";
                  } catch (_) {
                  }
                }
                console.log(`[Variants] cloneAsComponent: FRAME-wrap path \u2014 clone type=${clone.type}, inner children=${"children" in clone ? clone.children.length : 0}`);
                return comp;
              }, describeNodeVisuals2 = function(snap, indent = "") {
                const lines = [];
                let desc = `${indent}\u2022 "${snap.name}" (${snap.type}, id="${snap.id}")`;
                if (snap.fillColor) desc += ` fill=${snap.fillColor}`;
                if (snap.opacity !== void 0 && snap.opacity < 1) desc += ` opacity=${snap.opacity}`;
                if (snap.strokeColor) desc += ` stroke=${snap.strokeColor}`;
                if (snap.cornerRadius) desc += ` radius=${snap.cornerRadius}`;
                if (snap.characters) desc += ` text="${snap.characters}"`;
                if (snap.effects && snap.effects.length > 0) desc += ` effects=[${snap.effects.map((e) => e.type).join(",")}]`;
                lines.push(desc);
                if (snap.children) {
                  for (const child of snap.children) {
                    lines.push(...describeNodeVisuals2(child, indent + "  ").split("\n"));
                  }
                }
                return lines.join("\n");
              }, collectFillNodes2 = function(snap) {
                const result = [];
                if (snap.fillColor) {
                  result.push({ id: snap.id, name: snap.name, fillColor: snap.fillColor });
                }
                if (snap.children) {
                  for (const child of snap.children) {
                    result.push(...collectFillNodes2(child));
                  }
                }
                return result;
              }, adjustHexColor2 = function(hex, factor) {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
                if (factor > 1) {
                  const t = factor - 1;
                  return `#${clamp(r + (255 - r) * t).toString(16).padStart(2, "0")}${clamp(g + (255 - g) * t).toString(16).padStart(2, "0")}${clamp(b + (255 - b) * t).toString(16).padStart(2, "0")}`.toUpperCase();
                } else {
                  return `#${clamp(r * factor).toString(16).padStart(2, "0")}${clamp(g * factor).toString(16).padStart(2, "0")}${clamp(b * factor).toString(16).padStart(2, "0")}`.toUpperCase();
                }
              }, applyFallbackVariantStyle2 = function(comp, varName) {
                const state = varName.toLowerCase();
                console.log(`[Variants] Applying fallback styling for "${varName}"`);
                const compSnap = snapshotNode(comp, 0);
                const fillNodes = collectFillNodes2(compSnap);
                if (fillNodes.length === 0) return;
                for (const fNode of fillNodes) {
                  const node = figma.getNodeById(fNode.id);
                  if (!node || !("fills" in node)) continue;
                  const fills = node.fills;
                  if (!Array.isArray(fills) || fills.length === 0) continue;
                  const newFills = fills.map((f) => {
                    if (f.type !== "SOLID") return f;
                    const solid = f;
                    const hexR = Math.round(solid.color.r * 255).toString(16).padStart(2, "0");
                    const hexG = Math.round(solid.color.g * 255).toString(16).padStart(2, "0");
                    const hexB = Math.round(solid.color.b * 255).toString(16).padStart(2, "0");
                    const origHex = `#${hexR}${hexG}${hexB}`;
                    let newHex = origHex;
                    if (state === "hover") {
                      newHex = adjustHexColor2(origHex, 1.25);
                    } else if (state === "active" || state === "pressed") {
                      newHex = adjustHexColor2(origHex, 0.65);
                    } else if (state === "disabled") {
                      newHex = adjustHexColor2(origHex, 1.4);
                    } else if (state === "focused" || state === "focus") {
                      newHex = adjustHexColor2(origHex, 1.1);
                    } else if (state === "error" || state === "danger") {
                      newHex = "#D32F2F";
                    } else {
                      newHex = adjustHexColor2(origHex, 0.85);
                    }
                    const nr = parseInt(newHex.slice(1, 3), 16) / 255;
                    const ng = parseInt(newHex.slice(3, 5), 16) / 255;
                    const nb = parseInt(newHex.slice(5, 7), 16) / 255;
                    return __spreadProps(__spreadValues({}, solid), { color: { r: nr, g: ng, b: nb } });
                  });
                  node.fills = newFills;
                }
                if (state === "disabled") {
                  comp.opacity = 0.5;
                }
                if (state === "hover") {
                  comp.effects = [
                    { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.15 }, offset: { x: 0, y: 2 }, radius: 6, spread: 0, visible: true, blendMode: "NORMAL" }
                  ];
                } else if (state === "active" || state === "pressed") {
                  comp.effects = [
                    { type: "INNER_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL" }
                  ];
                } else if (state === "focused" || state === "focus") {
                  comp.effects = [
                    { type: "DROP_SHADOW", color: { r: 0.25, g: 0.4, b: 1, a: 0.5 }, offset: { x: 0, y: 0 }, radius: 0, spread: 3, visible: true, blendMode: "NORMAL" }
                  ];
                }
                figma.notify(`Applied fallback styling for "${varName}"`, { timeout: 2e3 });
              };
              var cloneAsComponent = cloneAsComponent2, describeNodeVisuals = describeNodeVisuals2, collectFillNodes = collectFillNodes2, adjustHexColor = adjustHexColor2, applyFallbackVariantStyle = applyFallbackVariantStyle2;
              sendToUI({ type: "status", message: "Understanding your request\u2026" });
              let existingVariantInfo = "";
              const componentSetNodes = [...selection].filter((n) => n.type === "COMPONENT_SET");
              if (componentSetNodes.length > 0) {
                const allExisting = [];
                for (const csNode of componentSetNodes) {
                  const children = csNode.children;
                  for (const c of children) {
                    const eqIndex = c.name.indexOf("=");
                    allExisting.push(eqIndex >= 0 ? c.name.substring(eqIndex + 1).trim() : c.name);
                  }
                }
                if (allExisting.length > 0) {
                  existingVariantInfo = `
Some component sets already have these variants: [${[...new Set(allExisting)].join(", ")}]. Do NOT include variants that already exist.`;
                }
              }
              const parsePrompt = `The user said: "${intentText}"
They are working with ${selection.length > 1 ? selection.length + " UI components" : "a UI component"} and want to create variant states.${existingVariantInfo}

Extract the following from the user's message:
1. "variantNames": An array of state/variant names to create (e.g., ["Hover", "Active", "Disabled"]).
   - Capitalize each name (e.g., "hover" \u2192 "Hover").
   - If the user says "missing" or "all" without specifying names, infer common UI states: Default, Hover, Active, Disabled \u2014 but exclude any that already exist.
   - If the user asks for a single state, return just that one.
   - Only include actual UI state names, not filler words.
2. "propertyName": The Figma variant property name (e.g., "State", "Size", "Type"). Default to "State" if not specified.

Respond with ONLY valid JSON, no markdown:
{"variantNames": ["..."], "propertyName": "..."}`;
              let variantNames = [];
              let propName = "State";
              try {
                const parsePayload = {
                  intent: parsePrompt,
                  selection: { nodes: [] },
                  designSystem: { textStyles: [], fillStyles: [], components: [], variables: [] },
                  apiKey: _userApiKey,
                  provider: _selectedProvider,
                  model: _selectedModel
                };
                const parseResult = await fetchViaUI("/plan?lenient=true&analyze=true", parsePayload);
                let parsed = null;
                if (parseResult.variantNames) {
                  parsed = parseResult;
                }
                if (!parsed) {
                  const rawStr = JSON.stringify(parseResult);
                  const jsonMatch = rawStr.match(/\{"variantNames"\s*:\s*\[.*?\]\s*,\s*"propertyName"\s*:\s*"[^"]*"\s*\}/);
                  if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[0]);
                  }
                }
                if (!parsed && parseResult._raw) {
                  const jsonMatch = parseResult._raw.match(/\{"variantNames"\s*:\s*\[.*?\]\s*,\s*"propertyName"\s*:\s*"[^"]*"\s*\}/);
                  if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[0]);
                  }
                }
                if (parsed && Array.isArray(parsed.variantNames) && parsed.variantNames.length > 0) {
                  variantNames = parsed.variantNames.map((n) => String(n).charAt(0).toUpperCase() + String(n).slice(1));
                  if (parsed.propertyName && typeof parsed.propertyName === "string") {
                    propName = parsed.propertyName;
                  }
                  console.log(`[Variants] LLM parsed intent: names=[${variantNames.join(", ")}], property="${propName}"`);
                } else {
                  console.warn(`[Variants] LLM intent parsing returned no variant names, using fallback`);
                }
              } catch (parseErr) {
                console.warn(`[Variants] LLM intent parsing failed: ${parseErr.message}, using fallback`);
              }
              if (variantNames.length === 0) {
                const knownStates = ["default", "hover", "active", "pressed", "disabled", "focused", "focus", "selected", "error", "loading"];
                const foundStates = knownStates.filter((s) => new RegExp(`\\b${s}\\b`, "i").test(intentText));
                if (foundStates.length > 0) {
                  variantNames = foundStates.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
                } else {
                  variantNames = ["Default", "Hover", "Active", "Disabled"];
                }
                console.log(`[Variants] Fallback parsed: [${variantNames.join(", ")}]`);
              }
              async function applyVariantStyleViaLLM(comp, varName) {
                const state = varName.toLowerCase();
                if (state === "default" || state === "normal" || state === "rest" || state === "base") {
                  console.log(`[Variants] Skipping LLM for "${varName}" (default state)`);
                  return;
                }
                try {
                  const compSnapshot = snapshotNode(comp, 0);
                  const compSelection = { nodes: [compSnapshot] };
                  const designSystem = await extractDesignSystemSnapshot();
                  const visualSummary = describeNodeVisuals2(compSnapshot);
                  const fillNodes = collectFillNodes2(compSnapshot);
                  const fillNodeList = fillNodes.map((n) => `  - id="${n.id}" name="${n.name}" currentFill=${n.fillColor}`).join("\n");
                  const variantPrompt = `Apply "${varName}" state styling to this UI component.

COMPONENT STRUCTURE (node tree with current visual properties):
${visualSummary}

NODES WITH FILLS (these are the main targets for color changes):
${fillNodeList}

CRITICAL RULES:
1. ONLY use the node IDs listed above \u2014 do NOT invent new IDs.
2. Do NOT change text content, font family, or font size.
3. Do NOT use DUPLICATE_FRAME, INSERT_COMPONENT, or RESIZE_NODE.
4. You MUST return at least one SET_FILL_COLOR operation to visually differentiate this state.
5. Use design system colors/tokens when available.

REQUIRED CHANGES for "${varName}" state:
\u2022 The component MUST look visibly different from the default state.
\u2022 Use SET_FILL_COLOR on the nodes listed above to change their fill colors.
` + (state === "hover" ? `\u2022 HOVER state: lighten the primary fill color by 15-25%. Add a subtle DROP_SHADOW for elevation.
` : state === "active" || state === "pressed" ? `\u2022 ACTIVE/PRESSED state: darken the primary fill color by 25-35%. Add an INNER_SHADOW for depth. The color should be noticeably darker than the default.
` : state === "disabled" ? `\u2022 DISABLED state: desaturate/grey out all fill colors. Set opacity to 0.4-0.5 using SET_OPACITY.
` : state === "focused" || state === "focus" ? `\u2022 FOCUSED state: add a visible focus ring (DROP_SHADOW with spread:3, no offset, blue/accent color). Slightly lighten the fill.
` : state === "error" || state === "danger" ? `\u2022 ERROR state: change the primary fill to a red/danger color (e.g., #D32F2F or design system error color).
` : state === "selected" ? `\u2022 SELECTED state: use accent/selection color for the fill. Consider adding a subtle border or highlight.
` : `\u2022 For "${varName}": apply appropriate visual changes based on common UI patterns for this state.
`) + `
Return ONLY the operations array. Every operation must target a real node ID from the list above.`;
                  const payload = __spreadProps(__spreadValues({
                    intent: variantPrompt,
                    selection: compSelection,
                    designSystem
                  }, _fullDesignSystem ? { fullDesignSystem: _fullDesignSystem } : {}), {
                    apiKey: _userApiKey,
                    provider: _selectedProvider,
                    model: _selectedModel
                  });
                  sendToUI({ type: "status", message: `Styling "${varName}" variant via AI\u2026` });
                  console.log(`[Variants] Sending "${varName}" to LLM for styling...`);
                  console.log(`[Variants] Fill targets: ${fillNodes.map((n) => `${n.name}(${n.fillColor})`).join(", ")}`);
                  const batch = await fetchViaUI("/plan?lenient=true", payload);
                  if (batch.operations && batch.operations.length > 0) {
                    const safeOps = batch.operations.filter(
                      (o) => o.type !== "DUPLICATE_FRAME" && o.type !== "INSERT_COMPONENT" && o.type !== "RESIZE_NODE"
                    );
                    console.log(`[Variants] Applying ${safeOps.length} LLM operations for "${varName}" (filtered ${batch.operations.length - safeOps.length} unsafe ops)`);
                    let appliedCount = 0;
                    for (const op of safeOps) {
                      try {
                        await applyOperation(op);
                        appliedCount++;
                      } catch (err) {
                        console.warn(`[Variants] Op failed for "${varName}": ${err.message}`, JSON.stringify(op));
                      }
                    }
                    if (appliedCount === 0) {
                      console.warn(`[Variants] All ${safeOps.length} LLM operations failed for "${varName}", using fallback`);
                      applyFallbackVariantStyle2(comp, varName);
                    } else {
                      console.log(`[Variants] Successfully applied ${appliedCount}/${safeOps.length} operations for "${varName}"`);
                    }
                  } else {
                    console.warn(`[Variants] LLM returned no operations for "${varName}", using fallback`);
                    applyFallbackVariantStyle2(comp, varName);
                  }
                } catch (err) {
                  console.warn(`[Variants] LLM styling failed for "${varName}": ${err.message}, using fallback`);
                  applyFallbackVariantStyle2(comp, varName);
                }
              }
              const allCreatedSets = [];
              const summaryParts = [];
              for (const sourceNode of [...selection]) {
                const isAddingToExistingSet = sourceNode.type === "COMPONENT_SET";
                let currentPropName = propName;
                let templateSource;
                let existingVariantNames = [];
                let existingSet = null;
                if (isAddingToExistingSet) {
                  existingSet = sourceNode;
                  const children = existingSet.children;
                  if (children.length === 0) {
                    console.warn(`[Variants] Skipping empty component set "${sourceNode.name}"`);
                    continue;
                  }
                  templateSource = children[0];
                  const firstChildName = children[0].name;
                  const eqIdx = firstChildName.indexOf("=");
                  if (eqIdx >= 0 && currentPropName === "State") {
                    currentPropName = firstChildName.substring(0, eqIdx).trim();
                  }
                  existingVariantNames = children.map((c) => {
                    const eqIndex = c.name.indexOf("=");
                    return eqIndex >= 0 ? c.name.substring(eqIndex + 1).trim().toLowerCase() : c.name.toLowerCase();
                  });
                  console.log(`[Variants] Existing set: "${existingSet.name}" variants: [${existingVariantNames.join(", ")}], prop="${currentPropName}"`);
                } else {
                  templateSource = sourceNode;
                }
                let nodeVariantNames = [...variantNames];
                if (isAddingToExistingSet && existingVariantNames.length > 0) {
                  nodeVariantNames = nodeVariantNames.filter((n) => !existingVariantNames.includes(n.toLowerCase()));
                  if (nodeVariantNames.length === 0) {
                    console.log(`[Variants] All variants already exist for "${sourceNode.name}", skipping.`);
                    continue;
                  }
                }
                sendToUI({ type: "status", message: `Creating variants for "${sourceNode.name}"\u2026` });
                const components = [];
                for (const vName of nodeVariantNames) {
                  const comp = cloneAsComponent2(templateSource, vName, currentPropName);
                  figma.currentPage.appendChild(comp);
                  await applyVariantStyleViaLLM(comp, vName);
                  components.push(comp);
                }
                if (isAddingToExistingSet && existingSet) {
                  for (const comp of components) {
                    existingSet.appendChild(comp);
                  }
                  allCreatedSets.push(existingSet);
                  summaryParts.push(`Added ${components.length} variant${components.length > 1 ? "s" : ""} to "${existingSet.name}"`);
                } else if (components.length >= 2) {
                  const parentNode = sourceNode.parent;
                  const targetParent = parentNode && "children" in parentNode ? parentNode : figma.currentPage;
                  const componentSet = figma.combineAsVariants(components, targetParent);
                  componentSet.name = sourceNode.name || "Component";
                  componentSet.layoutMode = "HORIZONTAL";
                  componentSet.primaryAxisSizingMode = "AUTO";
                  componentSet.counterAxisSizingMode = "AUTO";
                  componentSet.itemSpacing = 16;
                  componentSet.paddingTop = 40;
                  componentSet.paddingRight = 40;
                  componentSet.paddingBottom = 40;
                  componentSet.paddingLeft = 40;
                  componentSet.fills = [];
                  componentSet.x = sourceNode.x;
                  componentSet.y = sourceNode.y + sourceNode.height + 80;
                  allCreatedSets.push(componentSet);
                  summaryParts.push(`"${componentSet.name}" with ${nodeVariantNames.length} variants`);
                } else if (components.length === 1) {
                  allCreatedSets.push(components[0]);
                  summaryParts.push(`"${sourceNode.name}" (1 variant \u2014 need 2+ for a set)`);
                }
              }
              if (allCreatedSets.length > 0) {
                figma.currentPage.selection = allCreatedSets;
                const summary = selection.length > 1 ? `Created variant sets for ${allCreatedSets.length} element${allCreatedSets.length > 1 ? "s" : ""}: ${summaryParts.join("; ")}` : summaryParts[0] || "Variants created.";
                figma.notify(summary, { timeout: 5e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobIdV, summary });
              } else {
                sendToUI({ type: "job-complete", jobId: nativeJobIdV, summary: "No variants created." });
              }
            } catch (err) {
              figma.notify(`Failed to create variants: ${err.message}`, { timeout: 4e3 });
              sendToUI({ type: "job-error", jobId: nativeJobIdV, error: `Failed: ${err.message}` });
            }
            break;
          }
          if (isDetachInstanceIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select an instance first.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobId2 = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobId2, prompt: intentText });
            let detached = 0;
            const newSelection = [];
            for (const node of [...selection]) {
              if (node.type === "INSTANCE") {
                const frame = node.detachInstance();
                newSelection.push(frame);
                detached++;
              } else {
                newSelection.push(node);
              }
            }
            if (detached > 0) {
              figma.currentPage.selection = newSelection;
              const summary2 = `Detached ${detached} instance${detached > 1 ? "s" : ""}. `;
              figma.notify(summary2, { timeout: 3e3 });
              sendToUI({ type: "job-complete", jobId: nativeJobId2, summary: summary2 });
            } else {
              figma.notify("No instances found in selection.", { timeout: 3e3 });
              sendToUI({ type: "job-complete", jobId: nativeJobId2, summary: "No instances found." });
            }
            break;
          }
          if (isGroupIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length < 2) {
              figma.notify("Select at least 2 elements to group.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "Need 2+ elements." });
              break;
            }
            const nativeJobId3 = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobId3, prompt: intentText });
            const group = figma.group([...selection], selection[0].parent);
            group.name = "Group";
            figma.currentPage.selection = [group];
            const summary3 = `Grouped ${selection.length} elements.`;
            figma.notify(summary3, { timeout: 3e3 });
            sendToUI({ type: "job-complete", jobId: nativeJobId3, summary: summary3 });
            break;
          }
          if (isUngroupIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select a group first.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobId4 = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobId4, prompt: intentText });
            let ungrouped = 0;
            const newSel = [];
            for (const node of [...selection]) {
              if (node.type === "GROUP") {
                const parent = node.parent;
                const children = [...node.children];
                const idx = parent.children.indexOf(node);
                for (let i = children.length - 1; i >= 0; i--) {
                  parent.insertChild(idx, children[i]);
                  newSel.push(children[i]);
                }
                node.remove();
                ungrouped++;
              } else {
                newSel.push(node);
              }
            }
            if (ungrouped > 0) {
              figma.currentPage.selection = newSel;
              const summary4 = `Ungrouped ${ungrouped} group${ungrouped > 1 ? "s" : ""}. `;
              figma.notify(summary4, { timeout: 3e3 });
              sendToUI({ type: "job-complete", jobId: nativeJobId4, summary: summary4 });
            } else {
              figma.notify("No groups found in selection.", { timeout: 3e3 });
              sendToUI({ type: "job-complete", jobId: nativeJobId4, summary: "No groups found." });
            }
            break;
          }
          if (isFlattenIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select elements to flatten.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobId5 = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobId5, prompt: intentText });
            const flattened = [];
            for (const node of [...selection]) {
              try {
                const flat = figma.flatten([node]);
                flattened.push(flat);
              } catch (e) {
                figma.notify(`Cannot flatten "${node.name}": ${e.message}`, { timeout: 3e3 });
              }
            }
            if (flattened.length > 0) {
              figma.currentPage.selection = flattened;
              const summary5 = `Flattened ${flattened.length} element${flattened.length > 1 ? "s" : ""}. `;
              figma.notify(summary5, { timeout: 3e3 });
              sendToUI({ type: "job-complete", jobId: nativeJobId5, summary: summary5 });
            } else {
              sendToUI({ type: "job-complete", jobId: nativeJobId5, summary: "Nothing flattened." });
            }
            break;
          }
          if (isAutoLayoutIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select a frame first.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobIdAL = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobIdAL, prompt: intentText });
            try {
              let collectFrames2 = function(node, list, depth) {
                if (node.type !== "FRAME") return;
                if (depth > MAX_AL_DEPTH) return;
                const container = node;
                const childNames = container.children.map((c) => {
                  if (c.type === "TEXT") return `"${c.characters.substring(0, 30)}" (TEXT)`;
                  return `"${c.name}" (${c.type}, ${Math.round(c.width)}\xD7${Math.round(c.height)})`;
                });
                const hasLayout = container.layoutMode === "HORIZONTAL" || container.layoutMode === "VERTICAL";
                list.push({
                  id: node.id,
                  name: node.name,
                  type: node.type,
                  depth,
                  width: Math.round(node.width),
                  height: Math.round(node.height),
                  childCount: container.children.length,
                  childSummary: childNames.slice(0, 10).join(", ") + (childNames.length > 10 ? ` \u2026 +${childNames.length - 10} more` : ""),
                  alreadyHasLayout: hasLayout
                });
                for (const child of container.children) {
                  if (child.type === "FRAME") {
                    collectFrames2(child, list, depth + 1);
                  }
                }
              };
              var collectFrames = collectFrames2;
              const MAX_AL_DEPTH = 3;
              const allFrames = [];
              for (const node of [...selection]) {
                collectFrames2(node, allFrames, 0);
              }
              const framesToProcess = allFrames.filter((f) => !f.alreadyHasLayout);
              if (framesToProcess.length === 0) {
                const msg2 = allFrames.length > 0 ? `All ${allFrames.length} frames already have auto layout.` : "No frames found to apply auto layout to.";
                figma.notify(msg2, { timeout: 3e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobIdAL, summary: msg2 });
                break;
              }
              sendToUI({ type: "status", message: `Analyzing ${framesToProcess.length} frames for auto layout\u2026` });
              const frameDescriptions = framesToProcess.map(
                (f) => `\u2022 id="${f.id}" name="${f.name}" depth=${f.depth} size=${f.width}\xD7${f.height} children(${f.childCount}): [${f.childSummary}]`
              ).join("\n");
              const layoutPrompt = `The user said: "${intentText}"
Apply auto layout to a Figma frame and its nested sub-frames.

Frames to configure (depth 0 = root, selected frame):
${frameDescriptions}

For EACH frame, determine the best auto layout settings:
- "direction": "VERTICAL" or "HORIZONTAL"
  \u2022 Vertical: when children are stacked top-to-bottom (lists, cards, full screens)
  \u2022 Horizontal: when children are side-by-side (rows, navbars, quantity selectors, price lines)
- "spacing": pixels between items (0 = touching, 8-16 = normal, 24+ = sections)
- "padding": pixels on all sides (0 for inner groups, 16-24 for main containers)
- "alignment": primary axis \u2014 "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"
- "counterAlignment": cross axis \u2014 "MIN" | "CENTER" | "MAX"

IMPORTANT rules:
- depth=0 root frame: use FIXED width to keep the screen width, spacing based on its sections
- Inner frames: typically no padding, suitable spacing
- Look at child dimensions to infer direction: if children are wider than tall and stacked, it's vertical. If children are narrow and side by side, it's horizontal.

Respond with ONLY a JSON array, no markdown:
[{"id": "...", "direction": "...", "spacing": N, "padding": N, "alignment": "...", "counterAlignment": "..."}]`;
              const layoutPayload = {
                intent: layoutPrompt,
                selection: { nodes: [] },
                designSystem: { textStyles: [], fillStyles: [], components: [], variables: [] },
                apiKey: _userApiKey,
                provider: _selectedProvider,
                model: _selectedModel
              };
              let layoutSettings = [];
              try {
                const layoutResult = await fetchViaUI("/plan?lenient=true&analyze=true", layoutPayload);
                if (Array.isArray(layoutResult)) {
                  layoutSettings = layoutResult;
                } else if (layoutResult && typeof layoutResult === "object" && layoutResult.id) {
                  console.log(`[AutoLayout] LLM returned single object, wrapping in array`);
                  layoutSettings = [layoutResult];
                } else {
                  const rawStr = JSON.stringify(layoutResult);
                  const arrMatch = rawStr.match(/\[[\s\S]*?\{[\s\S]*?"id"[\s\S]*?\}[\s\S]*?\]/);
                  if (arrMatch) {
                    const parsed = JSON.parse(arrMatch[0]);
                    if (Array.isArray(parsed)) {
                      layoutSettings = parsed;
                    }
                  }
                }
                console.log(`[AutoLayout] LLM returned settings for ${layoutSettings.length} frames`);
              } catch (parseErr) {
                console.warn(`[AutoLayout] LLM layout analysis failed: ${parseErr.message}`);
              }
              const settingsMap = /* @__PURE__ */ new Map();
              for (const s of layoutSettings) settingsMap.set(s.id, s);
              const sorted = [...framesToProcess].sort((a, b) => b.depth - a.depth);
              let appliedCount = 0;
              for (const frameInfo of sorted) {
                const node = figma.getNodeById(frameInfo.id);
                if (!node || node.type !== "FRAME") continue;
                const frame = node;
                const settings = settingsMap.get(frameInfo.id);
                const dir = (settings == null ? void 0 : settings.direction) || "VERTICAL";
                const spacing = (_a = settings == null ? void 0 : settings.spacing) != null ? _a : 0;
                const pad = (_b = settings == null ? void 0 : settings.padding) != null ? _b : 0;
                const align = (settings == null ? void 0 : settings.alignment) || "MIN";
                const counterAlign = (settings == null ? void 0 : settings.counterAlignment) || "MIN";
                const origWidth = frame.width;
                const origHeight = frame.height;
                const isRoot = frameInfo.depth === 0;
                frame.layoutMode = dir;
                frame.itemSpacing = spacing;
                frame.paddingTop = pad;
                frame.paddingRight = pad;
                frame.paddingBottom = pad;
                frame.paddingLeft = pad;
                if (["MIN", "CENTER", "MAX", "SPACE_BETWEEN"].includes(align)) {
                  frame.primaryAxisAlignItems = align;
                }
                if (["MIN", "CENTER", "MAX"].includes(counterAlign)) {
                  frame.counterAxisAlignItems = counterAlign;
                }
                if (isRoot) {
                  frame.counterAxisSizingMode = "FIXED";
                  frame.primaryAxisSizingMode = "AUTO";
                  frame.resize(origWidth, frame.height);
                } else {
                  frame.primaryAxisSizingMode = "AUTO";
                  frame.counterAxisSizingMode = "AUTO";
                }
                appliedCount++;
                console.log(`[AutoLayout] Applied to "${frame.name}" (depth ${frameInfo.depth}): ${dir}, spacing=${spacing}, padding=${pad}`);
              }
              if (appliedCount > 0) {
                const summary = `Applied auto layout to ${appliedCount} frame${appliedCount > 1 ? "s" : ""}.`;
                figma.notify(summary, { timeout: 4e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobIdAL, summary });
              } else {
                sendToUI({ type: "job-complete", jobId: nativeJobIdAL, summary: "No frames had auto layout applied." });
              }
            } catch (err) {
              figma.notify(`Failed to apply auto layout: ${err.message}`, { timeout: 4e3 });
              sendToUI({ type: "job-error", jobId: nativeJobIdAL, error: `Failed: ${err.message}` });
            }
            break;
          }
          if (isCleanupIntent) {
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
              figma.notify("Select a frame first.", { timeout: 3e3 });
              sendToUI({ type: "status", message: "No selection." });
              break;
            }
            const nativeJobIdCU = ++_nextJobId;
            sendToUI({ type: "job-started", jobId: nativeJobIdCU, prompt: intentText });
            try {
              let collectCleanupFrames2 = function(node, list, depth, parentId, parentName, parentWidth, parentLayoutMode) {
                var _a2, _b2, _c, _d, _e, _f, _g;
                if (node.type !== "FRAME") return;
                if (depth > MAX_CU_DEPTH) return;
                const f = node;
                const childNames = f.children.map((c) => {
                  if (c.type === "TEXT") return `"${c.characters.substring(0, 30)}" (TEXT)`;
                  return `"${c.name}" (${c.type}, ${Math.round(c.width)}\xD7${Math.round(c.height)})`;
                });
                const lm = f.layoutMode || "NONE";
                const hasAutoLayout = lm === "HORIZONTAL" || lm === "VERTICAL";
                if (!hasAutoLayout) {
                  for (const child of f.children) {
                    if (child.type === "FRAME") {
                      collectCleanupFrames2(child, list, depth + 1, f.id, f.name, Math.round(f.width), f.layoutMode || "NONE");
                    }
                  }
                  return;
                }
                list.push({
                  id: f.id,
                  name: f.name,
                  depth,
                  parentId,
                  parentName,
                  parentWidth,
                  parentLayoutMode,
                  width: Math.round(f.width),
                  height: Math.round(f.height),
                  layoutMode: hasAutoLayout ? lm : "NONE",
                  paddingTop: (_a2 = f.paddingTop) != null ? _a2 : 0,
                  paddingRight: (_b2 = f.paddingRight) != null ? _b2 : 0,
                  paddingBottom: (_c = f.paddingBottom) != null ? _c : 0,
                  paddingLeft: (_d = f.paddingLeft) != null ? _d : 0,
                  itemSpacing: (_e = f.itemSpacing) != null ? _e : 0,
                  counterAxisSpacing: (_f = f.counterAxisSpacing) != null ? _f : 0,
                  primaryAxisAlign: f.primaryAxisAlignItems || "MIN",
                  counterAxisAlign: f.counterAxisAlignItems || "MIN",
                  sizingH: f.layoutSizingHorizontal || "FIXED",
                  sizingV: f.layoutSizingVertical || "FIXED",
                  clipsContent: (_g = f.clipsContent) != null ? _g : false,
                  childCount: f.children.length,
                  childSummary: childNames.slice(0, 10).join(", ") + (childNames.length > 10 ? ` \u2026 +${childNames.length - 10} more` : "")
                });
                for (const child of f.children) {
                  if (child.type === "FRAME") {
                    collectCleanupFrames2(child, list, depth + 1, f.id, f.name, Math.round(f.width), lm);
                  }
                }
              }, fixPositionAndBounds2 = function(node, depth) {
                if (node.type !== "FRAME") return;
                if (depth > MAX_CU_DEPTH + 1) return;
                const parent = node;
                const parentW = Math.round(parent.width);
                const parentH = Math.round(parent.height);
                const parentLM = parent.layoutMode || "NONE";
                for (const child of parent.children) {
                  const childW = Math.round(child.width);
                  const childH = Math.round(child.height);
                  const childX = Math.round(child.x);
                  const childY = Math.round(child.y);
                  const childName = child.name || "(unnamed)";
                  const isVisChild = /image|photo|thumbnail|hero|banner|avatar|icon|separator|divider|indicator/i.test(childName.toLowerCase());
                  const fixes = [];
                  if (parentLM === "NONE") {
                    let curX = childX;
                    if (curX < 0) {
                      child.x = 0;
                      fixes.push(`x ${curX}->0`);
                      curX = 0;
                    }
                    const curW = Math.round(child.width);
                    if (curX + curW > parentW + 2 && !isVisChild) {
                      if (curW <= parentW) {
                        const newX = parentW - curW;
                        child.x = newX;
                        fixes.push(`x ${curX}->${newX} (shift to fit)`);
                      } else {
                        const targetW = parentW - curX;
                        if (targetW > 0) {
                          try {
                            child.resize(targetW, childH);
                            fixes.push(`width ${curW}->${targetW} (fit in parent)`);
                          } catch (_e) {
                          }
                        }
                      }
                    }
                    const rightEdge = Math.round(child.x) + Math.round(child.width);
                    if (!isVisChild && rightEdge >= parentW - 1 && Math.round(child.width) < parentW - 16) {
                      const margin = 16;
                      const newX = parentW - Math.round(child.width) - margin;
                      if (newX >= 0 && newX !== Math.round(child.x)) {
                        child.x = newX;
                        fixes.push(`x ${Math.round(child.x + (child.x - newX))}->${newX} (right margin)`);
                      }
                    }
                    if (childY < -2) {
                      child.y = 0;
                      fixes.push(`y ${childY}->0`);
                    }
                    if (parent.clipsContent && childH > parentH && !isVisChild && childY >= 0) {
                      if (childH - parentH > 5) {
                        try {
                          child.resize(Math.round(child.width), parentH - Math.round(child.y));
                          fixes.push(`height ${childH}->${parentH - Math.round(child.y)} (clip overflow)`);
                        } catch (_e) {
                        }
                      }
                    }
                  } else {
                    if (child.type === "FRAME" && childW > parentW + 2) {
                      try {
                        child.layoutSizingHorizontal = "FILL";
                        fixes.push(`sizingH->FILL (${childW}>${parentW} in ${parentLM})`);
                      } catch (_e) {
                      }
                    }
                  }
                  if (fixes.length > 0) {
                    phase0Count++;
                    phase0Changes.push(`"${childName}": ${fixes.join(", ")}`);
                    console.log(`[Cleanup Phase0] "${childName}" in "${parent.name}": ${fixes.join(", ")}`);
                  }
                  if (child.type === "FRAME") {
                    fixPositionAndBounds2(child, depth + 1);
                  } else if (child.type === "GROUP") {
                    for (const gc of child.children) {
                      if (gc.type === "FRAME") {
                        fixPositionAndBounds2(gc, depth + 1);
                      }
                    }
                  }
                }
                if (parentLM === "NONE" && parent.children.length >= 2) {
                  const sortedKids = [...parent.children].sort((a, b) => a.y - b.y);
                  for (let i = 1; i < sortedKids.length; i++) {
                    const prev = sortedKids[i - 1];
                    const curr = sortedKids[i];
                    const prevBottom = Math.round(prev.y + prev.height);
                    const currTop = Math.round(curr.y);
                    const isVisCurr = /image|photo|thumbnail|hero|banner|avatar|icon|separator|divider|indicator/i.test((curr.name || "").toLowerCase());
                    const isVisPrev = /image|photo|thumbnail|hero|banner|avatar|icon|separator|divider|indicator/i.test((prev.name || "").toLowerCase());
                    if (currTop < prevBottom - 2 && !isVisCurr && !isVisPrev) {
                      const gap = 8;
                      const newY = prevBottom + gap;
                      if (newY !== currTop) {
                        const oldY = curr.y;
                        curr.y = newY;
                        phase0Count++;
                        phase0Changes.push(`"${curr.name}": y ${Math.round(oldY)}->${newY} (overlap fix)`);
                        console.log(`[Cleanup Phase0] "${curr.name}" in "${parent.name}": y ${Math.round(oldY)}->${newY} (overlap with "${prev.name}")`);
                      }
                    }
                  }
                }
              }, enforceNoneLayoutConsistency2 = function(node, depth) {
                if (node.type !== "FRAME") return;
                if (depth > MAX_CU_DEPTH + 1) return;
                const parent = node;
                const parentW = Math.round(parent.width);
                const parentLM = parent.layoutMode || "NONE";
                if (parentLM === "NONE" && parent.children.length >= 2) {
                  const childInfos = [];
                  for (const child of parent.children) {
                    const cn = child.name || "(unnamed)";
                    const isVis = /image|photo|thumbnail|hero|banner|avatar|icon|separator|divider|indicator|gesture|bar$/i.test(cn.toLowerCase());
                    childInfos.push({
                      node: child,
                      name: cn,
                      x: Math.round(child.x),
                      y: Math.round(child.y),
                      w: Math.round(child.width),
                      h: Math.round(child.height),
                      isVisual: isVis
                    });
                  }
                  const nameGroups = /* @__PURE__ */ new Map();
                  for (const ci of childInfos) {
                    if (!nameGroups.has(ci.name)) nameGroups.set(ci.name, []);
                    nameGroups.get(ci.name).push(ci);
                  }
                  for (const [_name, group] of nameGroups) {
                    if (group.length < 2) continue;
                    const xCounts = /* @__PURE__ */ new Map();
                    const wCounts = /* @__PURE__ */ new Map();
                    for (const g of group) {
                      xCounts.set(g.x, (xCounts.get(g.x) || 0) + 1);
                      wCounts.set(g.w, (wCounts.get(g.w) || 0) + 1);
                    }
                    let bestX = group[0].x, bestXCount = 0;
                    for (const [x, cnt] of xCounts) {
                      if (cnt > bestXCount) {
                        bestXCount = cnt;
                        bestX = x;
                      }
                    }
                    let bestW = group[0].w, bestWCount = 0;
                    for (const [w, cnt] of wCounts) {
                      if (cnt > bestWCount) {
                        bestWCount = cnt;
                        bestW = w;
                      }
                    }
                    for (const g of group) {
                      if (g.x === bestX && g.w === bestW) continue;
                      const fixes = [];
                      if (g.x !== bestX) {
                        g.node.x = bestX;
                        fixes.push(`x ${g.x}->${bestX}`);
                        g.x = bestX;
                      }
                      if (g.w !== bestW) {
                        try {
                          g.node.resize(bestW, g.h);
                          fixes.push(`w ${g.w}->${bestW}`);
                          g.w = bestW;
                        } catch (_e) {
                        }
                      }
                      if (fixes.length > 0) {
                        phase0Count++;
                        phase0Changes.push(`"${g.name}": ${fixes.join(", ")} (sibling match)`);
                        console.log(`[Cleanup Phase0b] "${g.name}" in "${parent.name}": ${fixes.join(", ")} (sibling match)`);
                      }
                    }
                  }
                  const sorted = [...childInfos].sort((a, b) => a.y - b.y);
                  const gaps = [];
                  for (let i = 1; i < sorted.length; i++) {
                    const gap = sorted[i].y - (sorted[i - 1].y + sorted[i - 1].h);
                    gaps.push({ index: i, gap });
                  }
                  if (gaps.length >= 1) {
                    const positiveGaps = gaps.map((g) => g.gap).filter((g) => g > 0).sort((a, b) => a - b);
                    const medianGap = positiveGaps.length >= 2 ? positiveGaps[Math.floor(positiveGaps.length / 2)] : 16;
                    const maxAllowedGap = Math.max(medianGap * 2.5, 40);
                    let totalShift = 0;
                    for (let i = 0; i < gaps.length; i++) {
                      const gapInfo = gaps[i];
                      if (gapInfo.gap > maxAllowedGap) {
                        const targetGap = Math.max(medianGap, 16);
                        const reduction = gapInfo.gap - targetGap;
                        if (reduction > 8) {
                          totalShift += reduction;
                          phase0Count++;
                          phase0Changes.push(`gap above "${sorted[gapInfo.index].name}": ${gapInfo.gap}->${gapInfo.gap - reduction}px`);
                          console.log(`[Cleanup Phase0b] gap above "${sorted[gapInfo.index].name}" in "${parent.name}": ${gapInfo.gap}->${gapInfo.gap - reduction}px`);
                        }
                      }
                      if (totalShift > 0) {
                        sorted[gapInfo.index].node.y = sorted[gapInfo.index].y - totalShift;
                      }
                    }
                  }
                }
                for (const child of parent.children) {
                  if (child.type === "FRAME") {
                    enforceNoneLayoutConsistency2(child, depth + 1);
                  } else if (child.type === "GROUP") {
                    for (const gc of child.children) {
                      if (gc.type === "FRAME") enforceNoneLayoutConsistency2(gc, depth + 1);
                    }
                  }
                }
              }, buildFrameDescriptions2 = function(frames) {
                var _a2, _b2, _c, _d, _e, _f, _g;
                for (const f of frames) {
                  const node = figma.getNodeById(f.id);
                  if (!node || node.type !== "FRAME") continue;
                  const fr = node;
                  f.width = Math.round(fr.width);
                  f.height = Math.round(fr.height);
                  f.paddingTop = (_a2 = fr.paddingTop) != null ? _a2 : 0;
                  f.paddingRight = (_b2 = fr.paddingRight) != null ? _b2 : 0;
                  f.paddingBottom = (_c = fr.paddingBottom) != null ? _c : 0;
                  f.paddingLeft = (_d = fr.paddingLeft) != null ? _d : 0;
                  f.itemSpacing = (_e = fr.itemSpacing) != null ? _e : 0;
                  f.counterAxisSpacing = (_f = fr.counterAxisSpacing) != null ? _f : 0;
                  f.primaryAxisAlign = fr.primaryAxisAlignItems || "MIN";
                  f.counterAxisAlign = fr.counterAxisAlignItems || "MIN";
                  f.sizingH = fr.layoutSizingHorizontal || "FIXED";
                  f.sizingV = fr.layoutSizingVertical || "FIXED";
                  f.clipsContent = (_g = fr.clipsContent) != null ? _g : false;
                  const childNames = fr.children.map((c) => {
                    if (c.type === "TEXT") return `"${c.characters.substring(0, 30)}" (TEXT)`;
                    return `"${c.name}" (${c.type}, ${Math.round(c.width)}\xD7${Math.round(c.height)})`;
                  });
                  f.childCount = fr.children.length;
                  f.childSummary = childNames.slice(0, 10).join(", ") + (childNames.length > 10 ? ` \u2026 +${childNames.length - 10} more` : "");
                }
                return frames.filter((f) => {
                  if (f.layoutMode === "NONE") return false;
                  return true;
                }).map((f) => {
                  const problems = [];
                  const nameLower = f.name.toLowerCase();
                  const isImage = /image|photo|thumbnail|hero|banner|avatar|icon/i.test(nameLower);
                  const isSeparator = /separator|divider|line|rule/i.test(nameLower);
                  const isCarousel = /carousel|slider|swiper/i.test(nameLower);
                  const isButton = /button|btn|cta/i.test(nameLower);
                  const hasText = f.childSummary.includes("(TEXT)");
                  const hasDeepText = hasText || /labels|content|body|description|title|subtitle|text|paragraph|caption/i.test(f.childSummary);
                  if (!isImage && !isSeparator && !isCarousel && f.parentLayoutMode && f.parentLayoutMode !== "NONE" && f.depth > 0) {
                    if (f.parentLayoutMode === "VERTICAL" && f.sizingH === "FIXED") {
                      problems.push("[ISSUE] FIXED width inside VERTICAL parent -- should be sizingH=FILL");
                    }
                    if (f.parentLayoutMode === "HORIZONTAL" && f.sizingV === "FIXED" && f.height > 60) {
                      problems.push("[ISSUE] FIXED height inside HORIZONTAL parent -- consider sizingV=FILL or HUG");
                    }
                  }
                  if (!isImage && !isCarousel && f.clipsContent && f.sizingH === "FIXED") {
                    problems.push("[ISSUE] clipsContent=true with FIXED width -- content IS being clipped. Set sizingH=FILL");
                  }
                  if (!isImage && !isCarousel && f.clipsContent && f.sizingV === "FIXED") {
                    problems.push("[ISSUE] clipsContent=true with FIXED height -- content clipped. Consider sizingV=HUG");
                  }
                  if (!isImage && !isSeparator && !isCarousel && hasDeepText) {
                    if (f.paddingLeft === 0 && f.paddingRight === 0 && f.width > 80) {
                      problems.push("[ISSUE] text flush against L/R edges -- needs horizontal padding (16px)");
                    }
                    if (f.paddingTop === 0 && f.paddingBottom === 0 && f.childCount > 1) {
                      problems.push("[ISSUE] text with no vertical padding -- needs top/bottom padding");
                    }
                  }
                  if (!isSeparator && !isCarousel) {
                    if (f.paddingLeft === 0 !== (f.paddingRight === 0) && f.paddingLeft + f.paddingRight > 0) {
                      problems.push(`[ISSUE] one-sided horizontal padding (L=${f.paddingLeft}, R=${f.paddingRight}) -- should be symmetric`);
                    }
                    if (f.paddingTop === 0 !== (f.paddingBottom === 0) && f.paddingTop + f.paddingBottom > 4) {
                      problems.push(`[ISSUE] one-sided vertical padding (T=${f.paddingTop}, B=${f.paddingBottom}) -- should be symmetric`);
                    }
                  }
                  if (isButton) {
                    const vPad = f.paddingTop + f.paddingBottom;
                    if (vPad > 40) problems.push(`[ISSUE] excessive button vertical padding (${vPad}px) -- should be 24-32px total`);
                  }
                  if (!isButton && f.depth > 0) {
                    if (f.paddingTop > 48 || f.paddingBottom > 48) problems.push(`[ISSUE] excessive vertical padding (T=${f.paddingTop}, B=${f.paddingBottom})`);
                    if (f.paddingLeft > 48 || f.paddingRight > 48) problems.push(`[ISSUE] excessive horizontal padding (L=${f.paddingLeft}, R=${f.paddingRight})`);
                  }
                  if (f.paddingLeft !== f.paddingRight && f.paddingLeft > 0 && f.paddingRight > 0) {
                    problems.push(`[ISSUE] asymmetric LR padding (${f.paddingLeft} vs ${f.paddingRight})`);
                  }
                  if (f.paddingTop !== f.paddingBottom && f.paddingTop > 0 && f.paddingBottom > 0) {
                    problems.push(`[ISSUE] asymmetric TB padding (${f.paddingTop} vs ${f.paddingBottom})`);
                  }
                  if ([f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft, f.itemSpacing].some((v) => v % 1 !== 0)) {
                    problems.push("[ISSUE] fractional values (should be whole numbers on 4px grid)");
                  }
                  if (f.itemSpacing < 0) problems.push(`[ISSUE] NEGATIVE spacing (${f.itemSpacing})`);
                  if (f.itemSpacing > 48 && !isCarousel) problems.push(`[ISSUE] very large spacing (${f.itemSpacing})`);
                  if (f.parentWidth && f.width > f.parentWidth) {
                    problems.push(`[ISSUE] frame width (${f.width}) exceeds parent width (${f.parentWidth}) -- overflowing. Set sizingH=FILL`);
                  }
                  const siblings = frames.filter((s) => s.parentId === f.parentId && s.id !== f.id);
                  const sameName = siblings.filter((s) => s.name === f.name);
                  if (sameName.length > 0) {
                    const ref = sameName[0];
                    if (ref.paddingTop !== f.paddingTop || ref.paddingRight !== f.paddingRight || ref.paddingBottom !== f.paddingBottom || ref.paddingLeft !== f.paddingLeft || ref.itemSpacing !== f.itemSpacing) {
                      problems.push(`[ISSUE] INCONSISTENT with sibling "${ref.name}" (id=${ref.id})`);
                    }
                  }
                  const samePrefix = siblings.filter((s) => {
                    const prefix = f.name.split(" ").slice(0, 2).join(" ");
                    return prefix.length > 3 && s.name.startsWith(prefix) && s.name !== f.name;
                  });
                  if (samePrefix.length > 0) {
                    const ref = samePrefix[0];
                    if (ref.paddingTop !== f.paddingTop || ref.paddingBottom !== f.paddingBottom || ref.paddingLeft !== f.paddingLeft || ref.paddingRight !== f.paddingRight) {
                      problems.push(`[ISSUE] padding differs from similar sibling "${ref.name}"`);
                    }
                  }
                  if (f.sizingV === "FIXED" && f.childCount <= 3 && f.height > 100 && !isImage && !isCarousel) {
                    const expectedH = f.paddingTop + f.paddingBottom + f.childCount * 30 + (f.childCount - 1) * f.itemSpacing;
                    if (f.height > expectedH * 2) {
                      problems.push(`[ISSUE] height (${f.height}px) excessive for ${f.childCount} children -- consider sizingV=HUG`);
                    }
                  }
                  let desc = `- id="${f.id}" name="${f.name}" depth=${f.depth}` + (f.parentName ? ` parent="${f.parentName}"` : "") + (f.parentLayoutMode ? ` parentLayout=${f.parentLayoutMode}` : "") + (f.parentWidth ? ` parentWidth=${f.parentWidth}` : "") + ` size=${f.width}x${f.height} layout=${f.layoutMode} padding=[${f.paddingTop},${f.paddingRight},${f.paddingBottom},${f.paddingLeft}] spacing=${f.itemSpacing} align=${f.primaryAxisAlign}/${f.counterAxisAlign} sizing=${f.sizingH}/${f.sizingV} clips=${f.clipsContent} children(${f.childCount}): [${f.childSummary}]`;
                  const node = figma.getNodeById(f.id);
                  if (node) {
                    let walk = node.parent;
                    for (let d = 0; d < 2 && walk; d++) {
                      if (walk.type === "FRAME") {
                        const wf = walk;
                        if ((wf.layoutMode === "HORIZONTAL" || wf.layoutMode === "VERTICAL") && (wf.paddingLeft >= 8 || wf.paddingRight >= 8 || wf.paddingTop >= 8 || wf.paddingBottom >= 8)) {
                          desc += ` ancestorPad="${wf.name}":[${wf.paddingTop},${wf.paddingRight},${wf.paddingBottom},${wf.paddingLeft}]`;
                          break;
                        }
                      }
                      walk = walk.parent;
                    }
                  }
                  if (problems.length > 0) {
                    desc += `
  ** ${problems.join("\n  ** ")}`;
                  }
                  return desc;
                }).join("\n");
              }, parseCleanupResponse2 = function(rawResult) {
                var _a2, _b2, _c, _d;
                let result = [];
                if (Array.isArray(rawResult)) {
                  result = rawResult;
                } else if (rawResult && typeof rawResult === "object") {
                  const wrapper = rawResult.frames || rawResult.result || rawResult.results || rawResult.content;
                  if (Array.isArray(wrapper)) {
                    result = wrapper;
                  } else {
                    const keys = Object.keys(rawResult);
                    if (keys.length === 1 && Array.isArray(rawResult[keys[0]])) {
                      result = rawResult[keys[0]];
                    } else if (rawResult.id) {
                      result = [rawResult];
                    } else {
                      const rawStr = JSON.stringify(rawResult);
                      const arrMatch = rawStr.match(/\[[\s\S]*?\{[\s\S]*?"id"[\s\S]*?\}[\s\S]*?\]/);
                      if (arrMatch) {
                        const parsed = JSON.parse(arrMatch[0]);
                        if (Array.isArray(parsed)) {
                          result = parsed;
                        }
                      }
                    }
                  }
                }
                for (const s of result) {
                  const raw = s;
                  if (raw.padding !== void 0) {
                    const p = raw.padding;
                    if (s.paddingTop === void 0) s.paddingTop = p;
                    if (s.paddingRight === void 0) s.paddingRight = p;
                    if (s.paddingBottom === void 0) s.paddingBottom = p;
                    if (s.paddingLeft === void 0) s.paddingLeft = p;
                    delete raw.padding;
                  }
                  const hPad = (_b2 = (_a2 = raw.paddingH) != null ? _a2 : raw.paddingX) != null ? _b2 : raw.paddingHorizontal;
                  if (hPad !== void 0) {
                    if (s.paddingLeft === void 0) s.paddingLeft = hPad;
                    if (s.paddingRight === void 0) s.paddingRight = hPad;
                    delete raw.paddingH;
                    delete raw.paddingX;
                    delete raw.paddingHorizontal;
                  }
                  const vPad = (_d = (_c = raw.paddingV) != null ? _c : raw.paddingY) != null ? _d : raw.paddingVertical;
                  if (vPad !== void 0) {
                    if (s.paddingTop === void 0) s.paddingTop = vPad;
                    if (s.paddingBottom === void 0) s.paddingBottom = vPad;
                    delete raw.paddingV;
                    delete raw.paddingY;
                    delete raw.paddingVertical;
                  }
                  if (raw.spacing !== void 0 && s.itemSpacing === void 0) {
                    s.itemSpacing = raw.spacing;
                    delete raw.spacing;
                  }
                }
                return result;
              }, applyCleanupSettings2 = function(settings, frames, passLabel) {
                var _a2, _b2, _c;
                const frameDepthMap = /* @__PURE__ */ new Map();
                for (const f of frames) frameDepthMap.set(f.id, f.depth);
                const sorted = [...settings].sort(
                  (a, b) => {
                    var _a3, _b3;
                    return ((_a3 = frameDepthMap.get(b.id)) != null ? _a3 : 0) - ((_b3 = frameDepthMap.get(a.id)) != null ? _b3 : 0);
                  }
                );
                let applied = 0;
                const changes = [];
                for (const s of sorted) {
                  const node = figma.getNodeById(s.id);
                  if (!node || node.type !== "FRAME") continue;
                  const frame = node;
                  const isRoot = ((_a2 = frameDepthMap.get(s.id)) != null ? _a2 : 0) === 0;
                  const origWidth = frame.width;
                  const fnLower = frame.name.toLowerCase();
                  const isVisualGuard = /image|photo|thumbnail|hero|banner|avatar|icon|carousel|slider|swiper|separator|divider/i.test(fnLower);
                  const parentFrame = node.parent && "width" in node.parent ? node.parent : null;
                  const isOverflowing = parentFrame && frame.width > parentFrame.width;
                  if (isVisualGuard && !isOverflowing) {
                    delete s.sizingH;
                    delete s.sizingV;
                  }
                  const parentNode = node.parent;
                  if (parentNode && "layoutMode" in parentNode && parentNode.layoutMode === "NONE") {
                    if (s.sizingH) {
                      console.log(`[${passLabel}] Skipping sizingH=${s.sizingH} on "${frame.name}" \u2014 parent NONE`);
                      rejectedFixReasons.push(`"${frame.name}" (${s.id}): sizingH=${s.sizingH} rejected \u2014 parent has layoutMode=NONE`);
                      delete s.sizingH;
                    }
                    if (s.sizingV) {
                      console.log(`[${passLabel}] Skipping sizingV=${s.sizingV} on "${frame.name}" \u2014 parent NONE`);
                      rejectedFixReasons.push(`"${frame.name}" (${s.id}): sizingV=${s.sizingV} rejected \u2014 parent has layoutMode=NONE`);
                      delete s.sizingV;
                    }
                  }
                  if (frame.layoutMode === "NONE" || !frame.layoutMode) {
                    console.log(`[${passLabel}] Skipping "${frame.name}" \u2014 layoutMode=NONE (no effect)`);
                    rejectedFixReasons.push(`"${frame.name}" (${s.id}): all changes rejected \u2014 frame has layoutMode=NONE`);
                    continue;
                  }
                  if (frame.layoutMode === "HORIZONTAL" || frame.layoutMode === "VERTICAL") {
                    const before = {
                      pT: frame.paddingTop,
                      pR: frame.paddingRight,
                      pB: frame.paddingBottom,
                      pL: frame.paddingLeft,
                      iS: frame.itemSpacing,
                      cS: (_b2 = frame.counterAxisSpacing) != null ? _b2 : 0,
                      align: frame.primaryAxisAlignItems || "MIN",
                      crossAlign: frame.counterAxisAlignItems || "MIN",
                      sizH: frame.layoutSizingHorizontal || "FIXED",
                      sizV: frame.layoutSizingVertical || "FIXED",
                      clips: frame.clipsContent
                    };
                    recordFrameValues2(s.id, {
                      paddingTop: before.pT,
                      paddingRight: before.pR,
                      paddingBottom: before.pB,
                      paddingLeft: before.pL,
                      itemSpacing: before.iS
                    });
                    let oscillatingProps = [];
                    if (s.paddingTop !== void 0 && isOscillating2(s.id, "paddingTop", s.paddingTop, before.pT)) {
                      oscillatingProps.push(`padTop ${before.pT}\u2192${s.paddingTop}`);
                      delete s.paddingTop;
                    }
                    if (s.paddingRight !== void 0 && isOscillating2(s.id, "paddingRight", s.paddingRight, before.pR)) {
                      oscillatingProps.push(`padRight ${before.pR}\u2192${s.paddingRight}`);
                      delete s.paddingRight;
                    }
                    if (s.paddingBottom !== void 0 && isOscillating2(s.id, "paddingBottom", s.paddingBottom, before.pB)) {
                      oscillatingProps.push(`padBot ${before.pB}\u2192${s.paddingBottom}`);
                      delete s.paddingBottom;
                    }
                    if (s.paddingLeft !== void 0 && isOscillating2(s.id, "paddingLeft", s.paddingLeft, before.pL)) {
                      oscillatingProps.push(`padLeft ${before.pL}\u2192${s.paddingLeft}`);
                      delete s.paddingLeft;
                    }
                    if (s.itemSpacing !== void 0 && isOscillating2(s.id, "itemSpacing", s.itemSpacing, before.iS)) {
                      oscillatingProps.push(`spacing ${before.iS}\u2192${s.itemSpacing}`);
                      delete s.itemSpacing;
                    }
                    if (oscillatingProps.length > 0) {
                      console.log(`[${passLabel}] Blocked oscillation on "${frame.name}": ${oscillatingProps.join(", ")}`);
                    }
                    const hasRemainingChange = s.paddingTop !== void 0 || s.paddingRight !== void 0 || s.paddingBottom !== void 0 || s.paddingLeft !== void 0 || s.itemSpacing !== void 0 || s.sizingH !== void 0 || s.sizingV !== void 0 || s.clipsContent !== void 0 || s.counterAxisSpacing !== void 0;
                    if (!hasRemainingChange) continue;
                    if (s.paddingTop !== void 0) frame.paddingTop = s.paddingTop;
                    if (s.paddingRight !== void 0) frame.paddingRight = s.paddingRight;
                    if (s.paddingBottom !== void 0) frame.paddingBottom = s.paddingBottom;
                    if (s.paddingLeft !== void 0) frame.paddingLeft = s.paddingLeft;
                    if (s.itemSpacing !== void 0) frame.itemSpacing = s.itemSpacing;
                    if (s.counterAxisSpacing !== void 0) frame.counterAxisSpacing = s.counterAxisSpacing;
                    if (s.alignment && ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"].includes(s.alignment)) {
                      if (before.align === "MIN" || frame.children.length <= 2) {
                        frame.primaryAxisAlignItems = s.alignment;
                      } else {
                        console.log(`[${passLabel}] Protecting alignment on "${frame.name}" (${before.align} \u2192 ${s.alignment} blocked \u2014 non-MIN with ${frame.children.length} children)`);
                      }
                    }
                    if (s.counterAlignment && ["MIN", "CENTER", "MAX"].includes(s.counterAlignment)) {
                      frame.counterAxisAlignItems = s.counterAlignment;
                    }
                    if (s.sizingH && ["FILL", "HUG", "FIXED"].includes(s.sizingH)) {
                      try {
                        frame.layoutSizingHorizontal = s.sizingH;
                      } catch (_e) {
                      }
                    }
                    if (s.sizingV && ["FILL", "HUG", "FIXED"].includes(s.sizingV)) {
                      try {
                        frame.layoutSizingVertical = s.sizingV;
                      } catch (_e) {
                      }
                    }
                    if (s.clipsContent !== void 0) frame.clipsContent = s.clipsContent;
                    const after = {
                      pT: frame.paddingTop,
                      pR: frame.paddingRight,
                      pB: frame.paddingBottom,
                      pL: frame.paddingLeft,
                      iS: frame.itemSpacing,
                      cS: (_c = frame.counterAxisSpacing) != null ? _c : 0,
                      align: frame.primaryAxisAlignItems || "MIN",
                      crossAlign: frame.counterAxisAlignItems || "MIN",
                      sizH: frame.layoutSizingHorizontal || "FIXED",
                      sizV: frame.layoutSizingVertical || "FIXED",
                      clips: frame.clipsContent
                    };
                    const realChanges = [];
                    if (before.pT !== after.pT || before.pR !== after.pR || before.pB !== after.pB || before.pL !== after.pL) {
                      realChanges.push(`padding [${before.pT},${before.pR},${before.pB},${before.pL}]\u2192[${after.pT},${after.pR},${after.pB},${after.pL}]`);
                    }
                    if (before.iS !== after.iS) realChanges.push(`spacing ${before.iS}\u2192${after.iS}`);
                    if (before.cS !== after.cS) realChanges.push(`counterSpacing ${before.cS}\u2192${after.cS}`);
                    if (before.align !== after.align) realChanges.push(`align ${before.align}\u2192${after.align}`);
                    if (before.crossAlign !== after.crossAlign) realChanges.push(`crossAlign ${before.crossAlign}\u2192${after.crossAlign}`);
                    if (before.sizH !== after.sizH) realChanges.push(`sizingH ${before.sizH}\u2192${after.sizH}`);
                    if (before.sizV !== after.sizV) realChanges.push(`sizingV ${before.sizV}\u2192${after.sizV}`);
                    if (before.clips !== after.clips) realChanges.push(`clipsContent ${before.clips}\u2192${after.clips}`);
                    if (realChanges.length > 0) {
                      applied++;
                      changes.push(`"${frame.name}": ${realChanges.join(", ")}`);
                      console.log(`[${passLabel}] Updated "${frame.name}": ${realChanges.join(", ")}`);
                      recordFrameValues2(s.id, {
                        paddingTop: after.pT,
                        paddingRight: after.pR,
                        paddingBottom: after.pB,
                        paddingLeft: after.pL,
                        itemSpacing: after.iS
                      });
                    }
                    if (isRoot) {
                      frame.counterAxisSizingMode = "FIXED";
                      frame.primaryAxisSizingMode = "AUTO";
                      frame.resize(origWidth, frame.height);
                    }
                  }
                }
                return { applied, changes };
              }, enforcePostLLMConsistency2 = function(frames, passLabel) {
                let count = 0;
                const changes = [];
                const groups = /* @__PURE__ */ new Map();
                for (const fi of frames) {
                  const key = `${fi.parentId}::${fi.name}`;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key).push({ id: fi.id, name: fi.name });
                }
                for (const [_key, group] of groups) {
                  if (group.length < 2) continue;
                  const live = [];
                  for (const g of group) {
                    const n = figma.getNodeById(g.id);
                    if (!n || n.type !== "FRAME") continue;
                    const f = n;
                    live.push({ node: f, pT: f.paddingTop, pR: f.paddingRight, pB: f.paddingBottom, pL: f.paddingLeft });
                  }
                  if (live.length < 2) continue;
                  const padCounts = /* @__PURE__ */ new Map();
                  for (const l of live) {
                    const pk = `${l.pT},${l.pR},${l.pB},${l.pL}`;
                    padCounts.set(pk, (padCounts.get(pk) || 0) + 1);
                  }
                  let bestP = "";
                  let bestC = 0;
                  for (const [pk, cnt] of padCounts) {
                    if (cnt > bestC) {
                      bestC = cnt;
                      bestP = pk;
                    }
                  }
                  const [tT, tR, tB, tL] = bestP.split(",").map(Number);
                  for (const l of live) {
                    if (l.pT === tT && l.pR === tR && l.pB === tB && l.pL === tL) continue;
                    const oldP = `[${l.pT},${l.pR},${l.pB},${l.pL}]`;
                    l.node.paddingTop = tT;
                    l.node.paddingRight = tR;
                    l.node.paddingBottom = tB;
                    l.node.paddingLeft = tL;
                    count++;
                    changes.push(`"${l.node.name}": pad ${oldP}->[${tT},${tR},${tB},${tL}] (sibling fix)`);
                    console.log(`[${passLabel}] "${l.node.name}": pad ${oldP}->[${tT},${tR},${tB},${tL}]`);
                  }
                }
                return { count, changes };
              }, recordFrameValues2 = function(frameId, props) {
                if (!frameValueHistory.has(frameId)) frameValueHistory.set(frameId, /* @__PURE__ */ new Map());
                const propMap = frameValueHistory.get(frameId);
                for (const [k, v] of Object.entries(props)) {
                  if (!propMap.has(k)) propMap.set(k, /* @__PURE__ */ new Set());
                  propMap.get(k).add(v);
                }
              }, isOscillating2 = function(frameId, prop, newVal, currentVal) {
                if (newVal === currentVal) return true;
                const propMap = frameValueHistory.get(frameId);
                if (!propMap) return false;
                const history = propMap.get(prop);
                if (!history || history.size < 2) return false;
                return history.has(newVal);
              };
              var collectCleanupFrames = collectCleanupFrames2, fixPositionAndBounds = fixPositionAndBounds2, enforceNoneLayoutConsistency = enforceNoneLayoutConsistency2, buildFrameDescriptions = buildFrameDescriptions2, parseCleanupResponse = parseCleanupResponse2, applyCleanupSettings = applyCleanupSettings2, enforcePostLLMConsistency = enforcePostLLMConsistency2, recordFrameValues = recordFrameValues2, isOscillating = isOscillating2;
              const MAX_CU_DEPTH = 5;
              const allFrames = [];
              for (const node of [...selection]) {
                collectCleanupFrames2(node, allFrames, 0, null, null, null, null);
              }
              let rootContext = "";
              for (const node of [...selection]) {
                if (node.type === "FRAME") {
                  const rf = node;
                  rootContext = `Root frame: id="${rf.id}" name="${rf.name}" size=${Math.round(rf.width)}x${Math.round(rf.height)} layoutMode=${rf.layoutMode || "NONE"}`;
                }
              }
              let phase0Count = 0;
              const phase0Changes = [];
              for (const node of [...selection]) {
                fixPositionAndBounds2(node, 0);
              }
              if (phase0Count > 0) {
                console.log(`[Cleanup] Phase 0a: Fixed position/bounds on ${phase0Count} elements`);
              }
              for (const node of [...selection]) {
                enforceNoneLayoutConsistency2(node, 0);
              }
              if (phase0Count > 0) {
                console.log(`[Cleanup] Phase 0 total: ${phase0Count} fixes`);
              }
              if (allFrames.length === 0) {
                figma.notify("No frames found. Select a frame to clean up.", { timeout: 3e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobIdCU, summary: "No frames to clean up." });
                break;
              }
              let preFixCount = 0;
              const preFixChanges = [];
              const individuallyFixedIds = /* @__PURE__ */ new Set();
              for (const fi of allFrames) {
                const node = figma.getNodeById(fi.id);
                if (!node || node.type !== "FRAME") continue;
                const frame = node;
                const nameLower = fi.name.toLowerCase();
                const isImageFrame = /image|photo|thumbnail|hero|banner|avatar|icon/i.test(nameLower);
                const isCarouselFrame = /carousel|slider|swiper/i.test(nameLower);
                const isSepFrame = /separator|divider|line|rule/i.test(nameLower);
                const isVisualFrame = isImageFrame || isCarouselFrame || isSepFrame;
                const isButton = /button|btn|cta/i.test(nameLower);
                const hasText = fi.childSummary.includes("(TEXT)");
                const hasDeepText = hasText || /labels|content|body|description|title|subtitle|text|paragraph|caption/i.test(fi.childSummary);
                const localFixes = [];
                if (!isVisualFrame && fi.parentLayoutMode === "VERTICAL" && fi.sizingH === "FIXED" && fi.depth > 0) {
                  try {
                    frame.layoutSizingHorizontal = "FILL";
                    fi.sizingH = "FILL";
                    localFixes.push("sizingH FIXED->FILL");
                  } catch (_e) {
                  }
                }
                if (!isVisualFrame && fi.parentLayoutMode === "HORIZONTAL" && fi.sizingV === "FIXED" && fi.depth > 0 && fi.height > 60) {
                  try {
                    frame.layoutSizingVertical = "FILL";
                    fi.sizingV = "FILL";
                    localFixes.push("sizingV FIXED->FILL");
                  } catch (_e) {
                  }
                }
                const round4 = (v) => Math.round(v / 4) * 4;
                if (frame.paddingTop % 1 !== 0) {
                  const nv = round4(frame.paddingTop);
                  localFixes.push(`padTop ${frame.paddingTop}->${nv}`);
                  frame.paddingTop = nv;
                  fi.paddingTop = nv;
                }
                if (frame.paddingRight % 1 !== 0) {
                  const nv = round4(frame.paddingRight);
                  localFixes.push(`padRight ${frame.paddingRight}->${nv}`);
                  frame.paddingRight = nv;
                  fi.paddingRight = nv;
                }
                if (frame.paddingBottom % 1 !== 0) {
                  const nv = round4(frame.paddingBottom);
                  localFixes.push(`padBot ${frame.paddingBottom}->${nv}`);
                  frame.paddingBottom = nv;
                  fi.paddingBottom = nv;
                }
                if (frame.paddingLeft % 1 !== 0) {
                  const nv = round4(frame.paddingLeft);
                  localFixes.push(`padLeft ${frame.paddingLeft}->${nv}`);
                  frame.paddingLeft = nv;
                  fi.paddingLeft = nv;
                }
                if (frame.itemSpacing % 1 !== 0) {
                  const nv = round4(frame.itemSpacing);
                  localFixes.push(`spacing ${frame.itemSpacing}->${nv}`);
                  frame.itemSpacing = nv;
                  fi.itemSpacing = nv;
                }
                if (frame.itemSpacing < 0) {
                  localFixes.push(`spacing ${frame.itemSpacing}->0`);
                  frame.itemSpacing = 0;
                  fi.itemSpacing = 0;
                }
                if (isButton && fi.sizingV === "FIXED" && frame.clipsContent) {
                  try {
                    frame.layoutSizingVertical = "HUG";
                    fi.sizingV = "HUG";
                    localFixes.push("sizingV FIXED->HUG (button)");
                  } catch (_e) {
                  }
                }
                if (!isVisualFrame && !isButton && hasDeepText && fi.width > 80) {
                  let ancestorHasPadLR = false;
                  let ancestorHasPadTB = false;
                  let walkNode = node.parent;
                  for (let walkDepth = 0; walkDepth < 3 && walkNode; walkDepth++) {
                    if (walkNode.type === "FRAME") {
                      const wf = walkNode;
                      if ((wf.layoutMode === "HORIZONTAL" || wf.layoutMode === "VERTICAL") && wf.paddingLeft >= 12 && wf.paddingRight >= 12) {
                        ancestorHasPadLR = true;
                      }
                      if ((wf.layoutMode === "HORIZONTAL" || wf.layoutMode === "VERTICAL") && wf.paddingTop >= 12 && wf.paddingBottom >= 12) {
                        ancestorHasPadTB = true;
                      }
                    }
                    walkNode = walkNode.parent;
                  }
                  if (fi.paddingLeft === 0 && fi.paddingRight === 0 && !ancestorHasPadLR) {
                    frame.paddingLeft = 16;
                    fi.paddingLeft = 16;
                    frame.paddingRight = 16;
                    fi.paddingRight = 16;
                    localFixes.push("padLR 0->16 (text flush)");
                  }
                  if (fi.paddingTop === 0 && fi.paddingBottom === 0 && fi.childCount > 1 && !ancestorHasPadTB) {
                    frame.paddingTop = 12;
                    fi.paddingTop = 12;
                    frame.paddingBottom = 12;
                    fi.paddingBottom = 12;
                    localFixes.push("padTB 0->12 (text flush)");
                  }
                }
                if (!isSepFrame && !isCarouselFrame) {
                  if (fi.paddingTop === 0 && fi.paddingBottom > 4) {
                    frame.paddingTop = fi.paddingBottom;
                    fi.paddingTop = fi.paddingBottom;
                    localFixes.push(`padTop 0->${fi.paddingBottom} (symmetric)`);
                  } else if (fi.paddingBottom === 0 && fi.paddingTop > 4) {
                    frame.paddingBottom = fi.paddingTop;
                    fi.paddingBottom = fi.paddingTop;
                    localFixes.push(`padBot 0->${fi.paddingTop} (symmetric)`);
                  }
                  if (fi.paddingLeft === 0 && fi.paddingRight > 4) {
                    frame.paddingLeft = fi.paddingRight;
                    fi.paddingLeft = fi.paddingRight;
                    localFixes.push(`padLeft 0->${fi.paddingRight} (symmetric)`);
                  } else if (fi.paddingRight === 0 && fi.paddingLeft > 4) {
                    frame.paddingRight = fi.paddingLeft;
                    fi.paddingRight = fi.paddingLeft;
                    localFixes.push(`padRight 0->${fi.paddingLeft} (symmetric)`);
                  }
                }
                if (!isVisualFrame && fi.sizingV === "FIXED" && fi.childCount <= 3 && fi.height > 100) {
                  const expectedH = fi.paddingTop + fi.paddingBottom + fi.childCount * 30 + (fi.childCount - 1) * Math.max(fi.itemSpacing, 0);
                  if (fi.height > expectedH * 2) {
                    try {
                      frame.layoutSizingVertical = "HUG";
                      fi.sizingV = "HUG";
                      localFixes.push(`sizingV FIXED->HUG (${fi.height}px excessive)`);
                    } catch (_e) {
                    }
                  }
                }
                if (isButton) {
                  if (fi.paddingTop > 20) {
                    const nv = 16;
                    localFixes.push(`padTop ${fi.paddingTop}->${nv} (btn)`);
                    frame.paddingTop = nv;
                    fi.paddingTop = nv;
                  }
                  if (fi.paddingBottom > 20) {
                    const nv = 16;
                    localFixes.push(`padBot ${fi.paddingBottom}->${nv} (btn)`);
                    frame.paddingBottom = nv;
                    fi.paddingBottom = nv;
                  }
                  if (fi.paddingLeft > 32) {
                    const nv = 24;
                    localFixes.push(`padLeft ${fi.paddingLeft}->${nv} (btn)`);
                    frame.paddingLeft = nv;
                    fi.paddingLeft = nv;
                  }
                  if (fi.paddingRight > 32) {
                    const nv = 24;
                    localFixes.push(`padRight ${fi.paddingRight}->${nv} (btn)`);
                    frame.paddingRight = nv;
                    fi.paddingRight = nv;
                  }
                }
                if (!isButton && fi.depth > 0 && !isVisualFrame) {
                  if (fi.paddingTop > 48) {
                    const nv = 24;
                    localFixes.push(`padTop ${fi.paddingTop}->${nv}`);
                    frame.paddingTop = nv;
                    fi.paddingTop = nv;
                  }
                  if (fi.paddingBottom > 48) {
                    const nv = 24;
                    localFixes.push(`padBot ${fi.paddingBottom}->${nv}`);
                    frame.paddingBottom = nv;
                    fi.paddingBottom = nv;
                  }
                  if (fi.paddingLeft > 48) {
                    const nv = 24;
                    localFixes.push(`padLeft ${fi.paddingLeft}->${nv}`);
                    frame.paddingLeft = nv;
                    fi.paddingLeft = nv;
                  }
                  if (fi.paddingRight > 48) {
                    const nv = 24;
                    localFixes.push(`padRight ${fi.paddingRight}->${nv}`);
                    frame.paddingRight = nv;
                    fi.paddingRight = nv;
                  }
                }
                if (fi.parentWidth && fi.width > fi.parentWidth && fi.parentLayoutMode && fi.parentLayoutMode !== "NONE" && fi.depth > 0) {
                  try {
                    if (fi.parentLayoutMode === "VERTICAL") {
                      frame.layoutSizingHorizontal = "FILL";
                      fi.sizingH = "FILL";
                      localFixes.push(`sizingH->FILL (${fi.width}>${fi.parentWidth})`);
                    }
                  } catch (_e) {
                  }
                }
                if (fi.clipsContent && fi.sizingH === "FIXED" && (!fi.parentLayoutMode || fi.parentLayoutMode === "NONE") && !isVisualFrame) {
                  frame.clipsContent = false;
                  fi.clipsContent = false;
                  localFixes.push("clipsContent true->false (FIXED+NONE parent)");
                }
                if (localFixes.length > 0) {
                  preFixCount++;
                  individuallyFixedIds.add(fi.id);
                  preFixChanges.push(`"${fi.name}": ${localFixes.join(", ")}`);
                  console.log(`[Cleanup pre-fix] "${fi.name}": ${localFixes.join(", ")}`);
                }
              }
              const siblingGroups = /* @__PURE__ */ new Map();
              for (const fi of allFrames) {
                const key = `${fi.parentId}::${fi.name}`;
                if (!siblingGroups.has(key)) siblingGroups.set(key, []);
                siblingGroups.get(key).push(fi);
              }
              for (const [_key, group] of siblingGroups) {
                if (group.length < 2) continue;
                const fixedMembers = group.filter((g) => individuallyFixedIds.has(g.id));
                let bT, bR, bB, bL;
                if (fixedMembers.length > 0) {
                  const best = fixedMembers.reduce((a, b) => {
                    const aSum = a.paddingTop + a.paddingRight + a.paddingBottom + a.paddingLeft;
                    const bSum = b.paddingTop + b.paddingRight + b.paddingBottom + b.paddingLeft;
                    return bSum > aSum ? b : a;
                  });
                  bT = best.paddingTop;
                  bR = best.paddingRight;
                  bB = best.paddingBottom;
                  bL = best.paddingLeft;
                } else {
                  const padCounts = /* @__PURE__ */ new Map();
                  for (const g of group) {
                    const pk = `${g.paddingTop},${g.paddingRight},${g.paddingBottom},${g.paddingLeft}`;
                    padCounts.set(pk, (padCounts.get(pk) || 0) + 1);
                  }
                  let bestPad = "";
                  let bestCount = 0;
                  for (const [key, count] of padCounts) {
                    if (count > bestCount) {
                      bestCount = count;
                      bestPad = key;
                    }
                  }
                  [bT, bR, bB, bL] = bestPad.split(",").map(Number);
                }
                for (const fi of group) {
                  if (fi.paddingTop === bT && fi.paddingRight === bR && fi.paddingBottom === bB && fi.paddingLeft === bL) continue;
                  const node = figma.getNodeById(fi.id);
                  if (!node || node.type !== "FRAME") continue;
                  const frame = node;
                  const oldPad = `[${fi.paddingTop},${fi.paddingRight},${fi.paddingBottom},${fi.paddingLeft}]`;
                  frame.paddingTop = bT;
                  fi.paddingTop = bT;
                  frame.paddingRight = bR;
                  fi.paddingRight = bR;
                  frame.paddingBottom = bB;
                  fi.paddingBottom = bB;
                  frame.paddingLeft = bL;
                  fi.paddingLeft = bL;
                  preFixCount++;
                  preFixChanges.push(`"${fi.name}": pad ${oldPad}->[${bT},${bR},${bB},${bL}] (same-name sibling match)`);
                  console.log(`[Cleanup pre-fix] "${fi.name}": pad ${oldPad}->[${bT},${bR},${bB},${bL}] (same-name sibling match)`);
                }
              }
              for (const fi of allFrames) {
                const nameLower = fi.name.toLowerCase();
                if (/image|photo|thumbnail|hero|banner|avatar|icon|carousel|slider|swiper|separator|divider|line|rule/i.test(nameLower)) continue;
                const preFSiblings = allFrames.filter((s) => s.parentId === fi.parentId && s.id !== fi.id);
                const preFPrefix = fi.name.split(" ").slice(0, 2).join(" ");
                const preFSimilar = preFSiblings.filter((s) => preFPrefix.length > 3 && s.name.startsWith(preFPrefix) && s.name !== fi.name);
                if (preFSimilar.length === 0) continue;
                const group = [fi, ...preFSimilar];
                const padCounts = /* @__PURE__ */ new Map();
                for (const g of group) {
                  const key = `${g.paddingTop},${g.paddingRight},${g.paddingBottom},${g.paddingLeft}`;
                  padCounts.set(key, (padCounts.get(key) || 0) + 1);
                }
                let bestPad = `${fi.paddingTop},${fi.paddingRight},${fi.paddingBottom},${fi.paddingLeft}`;
                let bestCount = 0;
                for (const [key, count] of padCounts) {
                  if (count > bestCount) {
                    bestCount = count;
                    bestPad = key;
                  }
                }
                const [bT, bR, bB, bL] = bestPad.split(",").map(Number);
                if (fi.paddingTop !== bT || fi.paddingRight !== bR || fi.paddingBottom !== bB || fi.paddingLeft !== bL) {
                  const node = figma.getNodeById(fi.id);
                  if (!node || node.type !== "FRAME") continue;
                  const frame = node;
                  const oldPad = `[${fi.paddingTop},${fi.paddingRight},${fi.paddingBottom},${fi.paddingLeft}]`;
                  frame.paddingTop = bT;
                  fi.paddingTop = bT;
                  frame.paddingRight = bR;
                  fi.paddingRight = bR;
                  frame.paddingBottom = bB;
                  fi.paddingBottom = bB;
                  frame.paddingLeft = bL;
                  fi.paddingLeft = bL;
                  preFixCount++;
                  preFixChanges.push(`"${fi.name}": pad ${oldPad}->[${bT},${bR},${bB},${bL}] (similar sibling match)`);
                  console.log(`[Cleanup pre-fix] "${fi.name}": pad ${oldPad}->[${bT},${bR},${bB},${bL}] (similar sibling match)`);
                }
              }
              if (preFixCount > 0) {
                console.log(`[Cleanup] Pre-fixed ${preFixCount} frames locally before LLM analysis`);
              }
              sendToUI({ type: "status", message: `Analyzing ${allFrames.length} frame${allFrames.length > 1 ? "s" : ""} for cleanup...` });
              const MAX_CLEANUP_PASSES = 5;
              async function captureScreenshot() {
                try {
                  const rootNode = selection[0];
                  if (rootNode && "exportAsync" in rootNode) {
                    const scale = Math.min(2, 1200 / Math.max(rootNode.width, 1));
                    const pngBytes = await rootNode.exportAsync({
                      format: "PNG",
                      constraint: { type: "SCALE", value: Math.max(0.5, scale) }
                    });
                    return uint8ToBase64(pngBytes);
                  }
                } catch (e) {
                  console.warn(`[Cleanup] Screenshot export failed: ${e.message}`);
                }
                return "";
              }
              const fixRulesText = `Apply fixes using these Figma layout rules:
- sizingH="FILL" makes a child stretch to its parent width. ONLY works when the parent has layoutMode=VERTICAL or HORIZONTAL (not NONE).
- sizingH="FILL" does NOT work if parentLayout=NONE. Skip sizing changes for those frames.
- sizingV="HUG" makes a frame shrink-wrap its content vertically. Use this to fix oversized buttons/cards.
- Buttons should have ~12-16px vertical padding, ~16-24px horizontal. Anything over 20px vertical is excessive.
- Cards and content sections should have ~12-20px padding on all sides.
- Padding should be symmetric: paddingLeft = paddingRight, paddingTop = paddingBottom.
- Sibling frames with the SAME NAME must have IDENTICAL padding, spacing, and sizing.
- DO NOT add padding to image/photo/carousel/separator/divider frames.
- DO NOT add padding to a frame if its parent already has padding >= 12px on that side (padding is inherited visually).
- DO NOT change alignment unless you are CERTAIN it is wrong. Alignment values like SPACE_BETWEEN are usually intentional (e.g., for label+value rows, headers with actions).
- Round fractional values to nearest multiple of 4 (14.5->16).
- Negative spacing must become 0 or a small positive value.
- NEVER change "layoutMode".

Respond ONLY with JSON: {"frames": [{"id": "<frame id>", ...properties to change...}, ...]}
Available properties: paddingTop, paddingRight, paddingBottom, paddingLeft, itemSpacing, counterAxisSpacing, sizingH ("FILL"|"HUG"|"FIXED"), sizingV ("FILL"|"HUG"|"FIXED"), clipsContent (boolean).`;
              let totalLLMApplied = 0;
              let totalPostFix = 0;
              const allLLMChanges = [];
              const allPostFixChanges = [];
              const frameValueHistory = /* @__PURE__ */ new Map();
              const rejectedFixReasons = [];
              sendToUI({ type: "status", message: `Cleanup pass 1/${MAX_CLEANUP_PASSES}: analyzing layout...` });
              figma.notify(`Cleanup pass 1/${MAX_CLEANUP_PASSES}: analyzing layout...`, { timeout: 3e3 });
              let screenshotBase64 = await captureScreenshot();
              let problemList = "";
              if (screenshotBase64) {
                const visualPrompt = `Examine this mobile app screenshot carefully. List every visual layout problem you can see.

Look for:
1. Text that is cropped, clipped, cut off, or overlapping other elements
2. Buttons or sections that are way too tall (excessive internal whitespace)
3. Elements that overflow or extend beyond their container (visible on right side being cut off)
4. Inconsistent spacing: groups of similar items (cards, list rows, buttons) with different gaps between them
5. Inconsistent padding: similar items with different amounts of internal space
6. Misaligned elements that should line up vertically or horizontally
7. Text jammed against container edges with no breathing room
8. Excessive empty space/gaps between sections

Be specific: describe WHERE each problem is and WHAT is wrong.
Example: "The Buy Now button has excessive vertical height \u2014 appears to be ~150px tall when it should be ~50px"
Example: "The review cards have inconsistent internal spacing"

List ALL problems, even minor ones. Number each problem.`;
                try {
                  console.log(`[Cleanup Pass 1] Sending visual analysis request...`);
                  const visualResult = await fetchViaUI("/plan?lenient=true&analyze=true&mode=visualReview", {
                    intent: visualPrompt,
                    selection: { nodes: [] },
                    designSystem: { textStyles: [], fillStyles: [], components: [], variables: [] },
                    apiKey: _userApiKey,
                    provider: _selectedProvider,
                    model: _selectedModel,
                    imageBase64: screenshotBase64
                  });
                  problemList = visualResult && visualResult.text ? visualResult.text : JSON.stringify(visualResult);
                  console.log(`[Cleanup Pass 1] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                  console.log(`[Cleanup Pass 1] VISUAL PROBLEMS FOUND:`);
                  console.log(`[Cleanup Pass 1] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                  console.log(problemList);
                  console.log(`[Cleanup Pass 1] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                } catch (err) {
                  console.warn(`[Cleanup Pass 1] Visual analysis failed: ${err.message}`);
                }
              }
              sendToUI({ type: "status", message: `Cleanup pass 2/${MAX_CLEANUP_PASSES}: mapping fixes...` });
              figma.notify(`Cleanup pass 2/${MAX_CLEANUP_PASSES}: generating fixes...`, { timeout: 3e3 });
              let frameDescriptions = buildFrameDescriptions2(allFrames);
              const fixPrompt = (problemList ? `A senior UI reviewer found these VISUAL PROBLEMS in the layout:

${problemList}

MAP each problem above to the correct frame below and generate fixes.

` : "") + `${rootContext}

Below are the auto-layout frames you can modify.
Frames marked with ** have programmatically-detected issues.

${frameDescriptions}

` + fixRulesText + `
Fix EVERY visual problem. Return ALL frames that need changes \u2014 typically most frames need at least one fix.` + (problemList ? `

IMPORTANT: Address EVERY problem from the visual review above. Do not skip any.` : "");
              console.log(`[Cleanup Pass 2] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
              console.log(`[Cleanup Pass 2] FIX PROMPT (${fixPrompt.length} chars):`);
              console.log(`[Cleanup Pass 2] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
              console.log(fixPrompt);
              console.log(`[Cleanup Pass 2] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
              try {
                const fixResult = await fetchViaUI("/plan?lenient=true&analyze=true&mode=fix", {
                  intent: fixPrompt,
                  selection: { nodes: [] },
                  designSystem: { textStyles: [], fillStyles: [], components: [], variables: [] },
                  apiKey: _userApiKey,
                  provider: _selectedProvider,
                  model: _selectedModel,
                  imageBase64: screenshotBase64 || void 0
                });
                console.log(`[Cleanup Pass 2] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                console.log(`[Cleanup Pass 2] LLM RESPONSE:`);
                console.log(`[Cleanup Pass 2] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                console.log(JSON.stringify(fixResult, null, 2));
                console.log(`[Cleanup Pass 2] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                const settings = parseCleanupResponse2(fixResult);
                console.log(`[Cleanup Pass 2] Parsed ${settings.length} frame fixes`);
                if (settings.length > 0) {
                  const result = applyCleanupSettings2(settings, allFrames, "Cleanup Pass 2");
                  totalLLMApplied += result.applied;
                  allLLMChanges.push(...result.changes);
                }
              } catch (err) {
                console.warn(`[Cleanup Pass 2] Fix mapping failed: ${err.message}`);
              }
              for (let pass = 3; pass <= MAX_CLEANUP_PASSES; pass++) {
                sendToUI({ type: "status", message: `Cleanup pass ${pass}/${MAX_CLEANUP_PASSES}: verifying...` });
                figma.notify(`Cleanup pass ${pass}/${MAX_CLEANUP_PASSES}: verifying layout...`, { timeout: 3e3 });
                screenshotBase64 = await captureScreenshot();
                frameDescriptions = buildFrameDescriptions2(allFrames);
                const verifyPrompt = `CRITICAL QA CHECK \u2014 Examine the screenshot carefully for ANY remaining layout problems.

${rootContext}

Current frame state:
${frameDescriptions}

` + fixRulesText + `

` + (rejectedFixReasons.length > 0 ? `IMPORTANT \u2014 The following fixes were already attempted and CANNOT be applied (do NOT suggest them again):
` + rejectedFixReasons.map((r) => `- ${r}`).join("\n") + `

` : "") + `SYSTEMATICALLY CHECK each of the following. For each issue found, return the fix:
1. TEXT OVERLAP: Any text clashing with or overlapping other text/elements?
2. EDGE TOUCHING: Any element touching its container edge with <8px margin?
3. EXCESSIVE GAPS: Any gap >40px between sections that should be closer together?
4. CLIPPING/OVERFLOW: Any content cut off or overflowing its container?
5. OVERSIZED ELEMENTS: Buttons/chips taller than 60px? Elements stretched too wide?
6. PADDING INCONSISTENCY: Similar containers with very different padding values?
7. MISALIGNMENT: Sibling elements that should be aligned but are offset?
8. WRONG PROPORTIONS: Sections taking up too much or too little space?

Return fixes for ALL problems found. Only return {"frames": []} if ALL 8 checks pass with ZERO issues.
Do NOT re-fix things that are already correct \u2014 only fix remaining problems.`;
                console.log(`[Cleanup Pass ${pass}] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                console.log(`[Cleanup Pass ${pass}] VERIFY PROMPT (${verifyPrompt.length} chars)`);
                console.log(`[Cleanup Pass ${pass}] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                try {
                  const verifyResult = await fetchViaUI("/plan?lenient=true&analyze=true&mode=verify", {
                    intent: verifyPrompt,
                    selection: { nodes: [] },
                    designSystem: { textStyles: [], fillStyles: [], components: [], variables: [] },
                    apiKey: _userApiKey,
                    provider: _selectedProvider,
                    model: _selectedModel,
                    imageBase64: screenshotBase64 || void 0
                  });
                  console.log(`[Cleanup Pass ${pass}] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                  console.log(`[Cleanup Pass ${pass}] VERIFY RESPONSE:`);
                  console.log(`[Cleanup Pass ${pass}] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                  console.log(JSON.stringify(verifyResult, null, 2));
                  console.log(`[Cleanup Pass ${pass}] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
                  const settings = parseCleanupResponse2(verifyResult);
                  console.log(`[Cleanup Pass ${pass}] Parsed ${settings.length} remaining fixes`);
                  if (settings.length === 0) {
                    console.log(`[Cleanup Pass ${pass}] LLM confirms layout is clean \u2014 stopping.`);
                    figma.notify(`Layout verified clean after ${pass} passes.`, { timeout: 3e3 });
                    break;
                  }
                  const result = applyCleanupSettings2(settings, allFrames, `Cleanup Pass ${pass}`);
                  totalLLMApplied += result.applied;
                  allLLMChanges.push(...result.changes);
                  if (result.applied === 0) {
                    console.log(`[Cleanup Pass ${pass}] No actual changes applied \u2014 converged. Stopping.`);
                    break;
                  }
                } catch (err) {
                  console.warn(`[Cleanup Pass ${pass}] Verify failed: ${err.message}`);
                  break;
                }
              }
              const postResult = enforcePostLLMConsistency2(allFrames, "Final post-fix");
              totalPostFix += postResult.count;
              allPostFixChanges.push(...postResult.changes);
              const totalFixed = totalLLMApplied + preFixCount + totalPostFix + phase0Count;
              if (totalFixed > 0) {
                const allChanges = [...phase0Changes, ...preFixChanges, ...allLLMChanges, ...allPostFixChanges];
                const summary = `Cleaned up ${totalFixed} frame${totalFixed > 1 ? "s" : ""}: ${allChanges.slice(0, 3).join("; ")}${allChanges.length > 3 ? ` \u2026 +${allChanges.length - 3} more` : ""}`;
                figma.notify(summary, { timeout: 5e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobIdCU, summary });
              } else {
                figma.notify("No layout changes were needed.", { timeout: 3e3 });
                sendToUI({ type: "job-complete", jobId: nativeJobIdCU, summary: "No changes applied." });
              }
            } catch (err) {
              figma.notify(`Failed to clean up layout: ${err.message}`, { timeout: 4e3 });
              sendToUI({ type: "job-error", jobId: nativeJobIdCU, error: `Failed: ${err.message}` });
            }
            break;
          }
          const isGenerateIntent = figma.currentPage.selection.length === 0 || /\b(add|create|generate|make|build|design)\b.+\b(frames?|screens?|pages?|views?|layouts?|mobile|desktop|variants?)\b/i.test(intentText) || /\b(new|mobile|desktop)\b.+\b(frames?|screens?|pages?|views?|layouts?)\b/i.test(intentText) || /\b(frames?|screens?|pages?)\b.+\bfor\b/i.test(intentText) || /\b(dark|light)\s+mode\s+(variant|version|copy|of)\b/i.test(intentText) || /\bvariant\b.+\b(of|for)\b/i.test(intentText);
          const jobId = ++_nextJobId;
          const job = { id: jobId, cancelled: false };
          _activeJobs.set(jobId, job);
          if (isGenerateIntent) {
            const prompt = intentText;
            const currentSelection = figma.currentPage.selection;
            if (currentSelection.length > 1) {
              _activeJobs.delete(jobId);
              const allFrameData = currentSelection.map((node) => ({
                snapshot: snapshotNode(node, 0),
                position: { x: Math.round(node.x), y: Math.round(node.y), width: Math.round(node.width), height: Math.round(node.height), name: node.name },
                nodeId: node.id
              }));
              console.log(`[run] Multi-frame generate: ${allFrameData.length} frames for "${prompt.slice(0, 60)}"`);
              for (const frameData of allFrameData) {
                const mjobId = ++_nextJobId;
                const mjob = { id: mjobId, cancelled: false };
                _activeJobs.set(mjobId, mjob);
                const singleSelection = { nodes: [frameData.snapshot] };
                console.log(`[run] Starting generate job ${mjobId} for frame "${frameData.snapshot.name}" (${frameData.position.width}x${frameData.position.height} at ${frameData.position.x},${frameData.position.y})`);
                sendToUI({ type: "job-started", jobId: mjobId, prompt: `${prompt} (${frameData.snapshot.name})` });
                runGenerateJob(mjob, prompt, singleSelection, frameData.position, [frameData.nodeId]).catch((err) => {
                  console.error(`[run] Unhandled error in generate job ${mjobId}:`, err);
                  if (!mjob.cancelled) {
                    sendToUI({ type: "job-error", jobId: mjobId, error: `Generation failed: ${err.message}` });
                  }
                  _activeJobs.delete(mjobId);
                });
              }
            } else {
              const singleNodeIds = currentSelection.map((n) => n.id);
              console.log(`[run] Starting generate job ${jobId}: "${prompt.slice(0, 60)}"`);
              sendToUI({ type: "job-started", jobId, prompt });
              runGenerateJob(job, prompt, void 0, void 0, singleNodeIds.length > 0 ? singleNodeIds : void 0).catch((err) => {
                console.error(`[run] Unhandled error in generate job ${jobId}:`, err);
                if (!job.cancelled) {
                  sendToUI({ type: "job-error", jobId, error: `Generation failed: ${err.message}` });
                }
                _activeJobs.delete(jobId);
              });
            }
          } else {
            const selectionSnapshot = extractSelectionSnapshot();
            console.log(`[run] Starting edit job ${jobId}: "${intentText.slice(0, 60)}" (${selectionSnapshot.nodes.length} nodes)`);
            sendToUI({ type: "job-started", jobId, prompt: intentText });
            runEditJob(job, intentText, selectionSnapshot).catch((err) => {
              console.error(`[run] Unhandled error in edit job ${jobId}:`, err);
              if (!job.cancelled) {
                sendToUI({ type: "job-error", jobId, error: `Edit failed: ${err.message}` });
              }
              _activeJobs.delete(jobId);
            });
          }
          break;
        }
        // ── Export design to JSON ──────────────────────────────────
        case "export-json": {
          const hasSelection = figma.currentPage.selection.length > 0;
          sendToUI({
            type: "status",
            message: hasSelection ? "Extracting selected nodes\u2026" : "Extracting entire page\u2026"
          });
          const rawNodes = hasSelection ? [...figma.currentPage.selection] : [...figma.currentPage.children];
          const sourceNodes = rawNodes.filter(
            (n) => !(n.type === "FRAME" && n.name === CHANGE_LOG_FRAME_NAME)
          );
          const exportSelection = {
            nodes: sourceNodes.map((node) => snapshotNode(node, 0))
          };
          sendToUI({ type: "status", message: "Encoding images\u2026" });
          for (let i = 0; i < exportSelection.nodes.length; i++) {
            await embedImagesInSnapshot(exportSelection.nodes[i], sourceNodes[i]);
          }
          const exportDesignSystem = await extractDesignSystemSnapshot();
          const exportData = {
            exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
            pageName: figma.currentPage.name,
            selection: exportSelection,
            designSystem: exportDesignSystem
          };
          const safeName = figma.currentPage.name.replace(/[^a-zA-Z0-9_-]/g, "_");
          const filename = `design-export-${safeName}.json`;
          sendToUI({ type: "export-json-result", data: exportData, filename });
          break;
        }
        // ── Generate Design Docs (markdown) ────────────────────────
        case "generate-docs": {
          try {
            sendToUI({ type: "status", message: "Extracting design tokens\u2026" });
            const result = await generateDesignDocs();
            sendToUI({ type: "docs-result", markdown: result.markdown, filename: result.filename });
          } catch (err) {
            sendToUI({ type: "docs-error", error: err.message || "Failed to generate docs." });
          }
          break;
        }
        // ── Import design from JSON ───────────────────────────────
        case "import-json": {
          try {
            const rawImportNodes = msg.data.selection.nodes;
            if (!Array.isArray(rawImportNodes) || rawImportNodes.length === 0) {
              sendToUI({ type: "import-json-error", error: "No nodes found in the JSON." });
              return;
            }
            const nodes = rawImportNodes.filter(
              (n) => n.name !== CHANGE_LOG_FRAME_NAME
            );
            sendToUI({ type: "status", message: `Creating ${nodes.length} node(s)\u2026` });
            _importStats = { texts: 0, frames: 0, images: 0, failed: 0, errors: [] };
            clearStyleMaps();
            const importNames = nodes.map((n) => n.name || "").join(" ");
            _currentThemeMode = detectThemeMode(importNames);
            console.log(`[import] Theme mode detected: ${_currentThemeMode}`);
            const exportedNames = new Set(nodes.map((n) => n.name));
            const pageChildren = figma.currentPage.children;
            const matchingOriginals = pageChildren.filter(
              (c) => exportedNames.has(c.name)
            );
            let offsetX = 0;
            let anchorY = null;
            const IMPORT_GAP = 200;
            if (matchingOriginals.length > 0) {
              let maxRight = -Infinity;
              let minY = Infinity;
              let maxBottom = -Infinity;
              for (const orig of matchingOriginals) {
                const right = orig.x + orig.width;
                if (right > maxRight) maxRight = right;
                if (orig.y < minY) minY = orig.y;
                const bottom = orig.y + orig.height;
                if (bottom > maxBottom) maxBottom = bottom;
              }
              const desiredX = maxRight + IMPORT_GAP;
              anchorY = minY;
              let totalImportW = 0;
              let totalImportH = maxBottom - minY;
              for (const snap of nodes) {
                const w = snap.width || 0;
                const relX = (snap.x || 0) - nodes.reduce((m, n) => Math.min(m, n.x || 0), Infinity);
                if (relX + w > totalImportW) totalImportW = relX + w;
              }
              const importLeft = desiredX;
              const importRight = desiredX + totalImportW;
              const importTop = minY;
              const importBottom = minY + totalImportH;
              let blocked = false;
              for (const child of pageChildren) {
                if (exportedNames.has(child.name)) continue;
                const cLeft = child.x;
                const cRight = child.x + child.width;
                const cTop = child.y;
                const cBottom = child.y + child.height;
                if (cLeft < importRight && cRight > importLeft && cTop < importBottom && cBottom > importTop) {
                  blocked = true;
                  if (cRight + IMPORT_GAP > desiredX) {
                    offsetX = cRight + IMPORT_GAP;
                  }
                }
              }
              if (!blocked) {
                offsetX = desiredX;
              }
            } else if (pageChildren.length > 0) {
              let maxRight = -Infinity;
              for (const child of pageChildren) {
                const right = child.x + child.width;
                if (right > maxRight) maxRight = right;
              }
              offsetX = maxRight + IMPORT_GAP;
            }
            let minSnapX = Infinity;
            let minSnapY = Infinity;
            for (const snap of nodes) {
              if (snap.x != null && snap.x < minSnapX) minSnapX = snap.x;
              if (snap.y != null && snap.y < minSnapY) minSnapY = snap.y;
            }
            if (!isFinite(minSnapX)) minSnapX = 0;
            if (!isFinite(minSnapY)) minSnapY = 0;
            const created = [];
            for (const snap of nodes) {
              try {
                const node = await createNodeFromSnapshot(snap, figma.currentPage);
                if (node) {
                  node.x = offsetX + ((snap.x || 0) - minSnapX);
                  node.y = (anchorY != null ? anchorY : 0) + ((snap.y || 0) - minSnapY);
                  created.push(node);
                }
              } catch (nodeErr) {
                _importStats.failed++;
                _importStats.errors.push(`Root "${snap.name}": ${nodeErr.message}`);
              }
            }
            if (created.length > 0) {
              figma.currentPage.selection = created;
              figma.viewport.scrollAndZoomIntoView(created);
            }
            const statsMsg = `Import: ${_importStats.frames} frames, ${_importStats.texts} texts, ${_importStats.images} images`;
            const failMsg = _importStats.failed > 0 ? `, ${_importStats.failed} failed` : "";
            figma.notify(statsMsg + failMsg, { timeout: 6e3 });
            if (_importStats.errors.length > 0) {
              console.warn("Import errors:", _importStats.errors.slice(0, 10));
            }
            sendToUI({
              type: "import-json-success",
              summary: `Imported ${created.length} node(s). ${_importStats.texts} text, ${_importStats.frames} frames, ${_importStats.images} images.${failMsg}`
            });
          } catch (err) {
            sendToUI({ type: "import-json-error", error: `Import failed: ${err.message}` });
          }
          break;
        }
        // ── Generate Frame (parallel job-based) ────────────────────
        case "generate": {
          const prompt = msg.prompt || "";
          const currentSelection = figma.currentPage.selection;
          if (currentSelection.length > 1) {
            const allFrameData = currentSelection.map((node) => ({
              snapshot: snapshotNode(node, 0),
              position: { x: Math.round(node.x), y: Math.round(node.y), width: Math.round(node.width), height: Math.round(node.height), name: node.name }
            }));
            console.log(`[generate] Multi-frame: ${allFrameData.length} frames for "${prompt.slice(0, 60)}"`);
            for (const frameData of allFrameData) {
              const jobId = ++_nextJobId;
              const job = { id: jobId, cancelled: false };
              _activeJobs.set(jobId, job);
              const singleSelection = { nodes: [frameData.snapshot] };
              console.log(`[generate] Starting job ${jobId} for frame "${frameData.snapshot.name}" (${frameData.position.width}x${frameData.position.height})`);
              sendToUI({ type: "job-started", jobId, prompt: `${prompt} (${frameData.snapshot.name})` });
              runGenerateJob(job, prompt, singleSelection, frameData.position).catch((err) => {
                console.error(`[generate] Unhandled error in job ${jobId}:`, err);
                if (!job.cancelled) {
                  sendToUI({ type: "job-error", jobId, error: `Generation failed: ${err.message}` });
                }
                _activeJobs.delete(jobId);
              });
            }
          } else {
            const jobId = ++_nextJobId;
            const job = { id: jobId, cancelled: false };
            _activeJobs.set(jobId, job);
            console.log(`[generate] Starting job ${jobId}: "${prompt.slice(0, 60)}"`);
            sendToUI({ type: "job-started", jobId, prompt });
            runGenerateJob(job, prompt).catch((err) => {
              console.error(`[generate] Unhandled error in job ${jobId}:`, err);
              if (!job.cancelled) {
                sendToUI({ type: "job-error", jobId, error: `Generation failed: ${err.message}` });
              }
              _activeJobs.delete(jobId);
            });
          }
          break;
        }
        // ── Revert ────────────────────────────────────────────────
        case "revert-last": {
          if (!lastRevertState) {
            lastRevertState = await loadRevertState();
          }
          if (!lastRevertState) {
            sendToUI({ type: "revert-error", error: "Nothing to revert." });
            return;
          }
          sendToUI({ type: "status", message: "Reverting\u2026" });
          await revertLast();
          await figma.clientStorage.deleteAsync("lastRevertState");
          sendToUI({ type: "revert-success" });
          break;
        }
        // ── Extract Full Design System ────────────────────────────
        case "extract-design-system": {
          try {
            sendToUI({ type: "extract-ds-progress", page: "Starting\u2026", pageIndex: 0, totalPages: figma.root.children.length });
            const ds = await extractFullDocumentDesignSystem();
            sendToUI({
              type: "extract-ds-complete",
              summary: buildDSSummary(ds)
            });
            figma.notify(`Design system extracted: ${ds.colorPalette.length} colors, ${ds.components.length} components, ${ds.variables.length} variables`, { timeout: 4e3 });
          } catch (err) {
            if (err.message === "Extraction cancelled") {
              figma.notify("Design system extraction cancelled.", { timeout: 3e3 });
              sendToUI({ type: "extract-ds-error", error: "Cancelled" });
            } else {
              console.error("[extractFullDS] Error:", err);
              sendToUI({ type: "extract-ds-error", error: err.message || "Unknown error" });
              figma.notify(`Design system extraction failed: ${err.message}`, { timeout: 5e3, error: true });
            }
          }
          break;
        }
        // ── Cancel Design System Extraction ───────────────────────
        case "cancel-extract-ds": {
          _extractDSCancelled = true;
          break;
        }
      }
    } catch (err) {
      const errMsg = err.message || String(err);
      const isRateLimit = errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit");
      const displayMsg = isRateLimit ? "Rate limited \u2014 wait ~60 seconds and try again." : errMsg;
      sendToUI({ type: "apply-error", error: displayMsg });
      figma.notify(displayMsg, { timeout: 6e3, error: true });
    }
  };
})();
