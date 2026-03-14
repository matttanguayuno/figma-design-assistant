/**
 * V2 Snapshot Builder — Merge scene graph → Figma SnapshotNode tree
 *
 * Takes TextRegion[], ContainerRegion[], IconRegion[] and builds
 * a SnapshotNode tree using absolute positioning (no auto-layout).
 */

import type {
  Bbox,
  TextRegion,
  ContainerRegion,
  IconRegion,
  SceneGraph,
  SnapshotNode,
} from "./types";

let nodeIdCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${nodeIdCounter++}`;
}

/**
 * Build a Figma SnapshotNode tree from the scene graph.
 */
export function buildSnapshot(scene: SceneGraph): SnapshotNode {
  nodeIdCounter = 0;

  const { viewport, texts, containers, icons } = scene;

  // Root frame = the full screenshot viewport
  const root: SnapshotNode = {
    id: nextId("root"),
    name: "V2 Reconstruction",
    type: "FRAME",
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
    childrenCount: 0,
    layoutMode: "NONE",
    clipsContent: true,
    fillColor: "#ffffff",
    children: [],
  };

  // Flatten the container tree for assignment purposes
  const flatContainers = flattenContainers(containers);

  // Convert containers to SnapshotNodes (preserving hierarchy)
  const containerNodes = new Map<string, SnapshotNode>();
  for (const c of containers) {
    const cNode = containerToSnapshot(c, containerNodes);
    root.children!.push(cNode);
  }

  // Assign text regions to their deepest containing container
  for (const text of texts) {
    const textNode = textToSnapshot(text);
    const parent = findDeepestContainer(text.bbox, flatContainers, containerNodes);
    if (parent) {
      // Adjust position relative to the parent container
      textNode.x -= getBboxForContainer(parent, flatContainers).x;
      textNode.y -= getBboxForContainer(parent, flatContainers).y;
      parent.children = parent.children || [];
      parent.children.push(textNode);
      parent.childrenCount = parent.children.length;
    } else {
      root.children!.push(textNode);
    }
  }

  // Assign icons to their deepest containing container
  for (const icon of icons) {
    const iconNode = iconToSnapshot(icon);
    const parent = findDeepestContainer(icon.bbox, flatContainers, containerNodes);
    if (parent) {
      iconNode.x -= getBboxForContainer(parent, flatContainers).x;
      iconNode.y -= getBboxForContainer(parent, flatContainers).y;
      parent.children = parent.children || [];
      parent.children.push(iconNode);
      parent.childrenCount = parent.children.length;
    } else {
      root.children!.push(iconNode);
    }
  }

  root.childrenCount = root.children!.length;
  return root;
}

/**
 * Flatten the container hierarchy for lookup.
 */
function flattenContainers(containers: ContainerRegion[]): ContainerRegion[] {
  const result: ContainerRegion[] = [];
  function walk(c: ContainerRegion) {
    result.push(c);
    for (const child of c.children) walk(child);
  }
  for (const c of containers) walk(c);
  return result;
}

/**
 * Convert a ContainerRegion (with children) to a SnapshotNode.
 */
function containerToSnapshot(
  c: ContainerRegion,
  nodeMap: Map<string, SnapshotNode>,
  parentBbox?: Bbox,
): SnapshotNode {
  const relX = parentBbox ? c.bbox.x - parentBbox.x : c.bbox.x;
  const relY = parentBbox ? c.bbox.y - parentBbox.y : c.bbox.y;

  const node: SnapshotNode = {
    id: nextId("container"),
    name: c.id,
    type: "FRAME",
    x: relX,
    y: relY,
    width: c.bbox.w,
    height: c.bbox.h,
    childrenCount: c.children.length,
    layoutMode: "NONE",
    fillColor: c.fillColor,
    cornerRadius: c.cornerRadius,
    clipsContent: true,
    children: [],
  };

  // Stroke
  if (c.strokeColor) {
    node.strokeColor = c.strokeColor;
    node.strokeWeight = c.strokeWeight || 1;
  }

  // Shadow
  if (c.shadow) {
    node.effects = [
      {
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.15 },
        offset: { x: c.shadow.offsetX, y: c.shadow.offsetY },
        radius: c.shadow.blur,
        visible: true,
      },
    ];
  }

  // Recurse into child containers
  for (const child of c.children) {
    node.children!.push(containerToSnapshot(child, nodeMap, c.bbox));
  }

  nodeMap.set(c.id, node);
  return node;
}

/**
 * Convert a TextRegion to a SnapshotNode.
 */
function textToSnapshot(t: TextRegion): SnapshotNode {
  // Map fontWeight to Figma font style
  let fontStyle = "Regular";
  if (t.fontWeight >= 700) fontStyle = "Bold";
  else if (t.fontWeight >= 600) fontStyle = "Semi Bold";
  else if (t.fontWeight >= 500) fontStyle = "Medium";

  return {
    id: nextId("text"),
    name: t.text.substring(0, 30),
    type: "TEXT",
    x: t.bbox.x,
    y: t.bbox.y,
    width: t.bbox.w,
    height: t.bbox.h,
    childrenCount: 0,
    characters: t.text,
    fontSize: t.fontSize,
    fontFamily: "Inter",
    fontStyle,
    fillColor: t.fillColor,
    textAlignHorizontal: t.textAlign || "LEFT",
    textAlignVertical: "TOP",
    textAutoResize: "WIDTH_AND_HEIGHT",
    lineHeight: t.lineHeight,
  };
}

/**
 * Convert an IconRegion to a SnapshotNode (RECTANGLE with image fill).
 */
function iconToSnapshot(icon: IconRegion): SnapshotNode {
  return {
    id: nextId("icon"),
    name: icon.id,
    type: "RECTANGLE",
    x: icon.bbox.x,
    y: icon.bbox.y,
    width: icon.bbox.w,
    height: icon.bbox.h,
    childrenCount: 0,
    imageData: icon.imageData,
    cornerRadius: icon.borderRadius,
  };
}

/**
 * Find the deepest container whose bbox fully contains the given bbox.
 * Returns the SnapshotNode (not the ContainerRegion).
 */
function findDeepestContainer(
  bbox: Bbox,
  flatContainers: ContainerRegion[],
  nodeMap: Map<string, SnapshotNode>,
): SnapshotNode | null {
  // Center of the target element
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;

  let best: ContainerRegion | null = null;
  let bestArea = Infinity;

  for (const c of flatContainers) {
    // Check if the center point is inside this container
    if (
      cx >= c.bbox.x &&
      cx <= c.bbox.x + c.bbox.w &&
      cy >= c.bbox.y &&
      cy <= c.bbox.y + c.bbox.h
    ) {
      const area = c.bbox.w * c.bbox.h;
      if (area < bestArea) {
        bestArea = area;
        best = c;
      }
    }
  }

  if (!best) return null;
  return nodeMap.get(best.id) || null;
}

/**
 * Get the absolute bbox for a container (used for coordinate conversion).
 */
function getBboxForContainer(
  node: SnapshotNode,
  flatContainers: ContainerRegion[],
): Bbox {
  const c = flatContainers.find(c => c.id === node.name);
  if (c) return c.bbox;
  return { x: node.x, y: node.y, w: node.width, h: node.height };
}
