// backend/validator.ts
// Validates LLM-returned operation batches against:
//   1. Zod schema (structural correctness)
//   2. Reference integrity (all IDs exist in the design system snapshot)

import { OperationBatchSchema, OperationSchema, ValidatedOperationBatch } from "./schema";

// ── Types mirroring the plugin payload ──────────────────────────────

interface DesignSystemSnapshot {
  textStyles: { id: string; name: string }[];
  fillStyles: { id: string; name: string }[];
  components: { key: string; name: string }[];
  variables: { id: string; name: string }[];
}

interface SelectionNode {
  id: string;
  name: string;
  type: string;
  childrenCount: number;
  children?: SelectionNode[];
}

interface SelectionSnapshot {
  nodes: SelectionNode[];
}

export interface ValidationResult {
  valid: boolean;
  batch?: ValidatedOperationBatch;
  errors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function collectNodeIds(nodes: SelectionNode[], out: Set<string>): void {
  for (const n of nodes) {
    out.add(n.id);
    if (n.children) {
      collectNodeIds(n.children, out);
    }
  }
}

// ── Validate ────────────────────────────────────────────────────────

export function validateOperationBatch(
  raw: unknown,
  selection: SelectionSnapshot,
  designSystem: DesignSystemSnapshot,
  lenient: boolean = false
): ValidationResult {
  const errors: string[] = [];

  // Build lookup sets (used by both strict and lenient modes)
  const nodeIds = new Set<string>();
  collectNodeIds(selection.nodes, nodeIds);
  const textStyleIds = new Set(designSystem.textStyles.map((s) => s.id));
  const fillStyleIds = new Set(designSystem.fillStyles.map((s) => s.id));
  const componentKeys = new Set(designSystem.components.map((c) => c.key));

  // \u2500\u2500 Lenient mode: parse operations individually, skip bad ones \u2500\u2500
  if (lenient) {
    const rawObj = raw as any;
    const rawOps = rawObj?.operations;
    if (!Array.isArray(rawOps)) {
      return { valid: false, errors: ["operations is not an array"] };
    }

    const validOps: any[] = [];
    for (let i = 0; i < rawOps.length; i++) {
      const opResult = OperationSchema.safeParse(rawOps[i]);
      if (!opResult.success) {
        console.warn(`[validator] Lenient: skip op ${i} (schema): ${opResult.error.issues[0]?.message}`);
        continue;
      }

      const op = opResult.data;
      let valid = true;

      // Check nodeId reference
      if ("nodeId" in op && !nodeIds.has(op.nodeId)) {
        console.warn(`[validator] Lenient: skip op ${i} (nodeId "${op.nodeId}" not in selection)`);
        valid = false;
      }

      // Check parentId reference
      if ("parentId" in op && !nodeIds.has(op.parentId)) {
        console.warn(`[validator] Lenient: skip op ${i} (parentId not in selection)`);
        valid = false;
      }

      // Check componentKey reference
      if (op.type === "INSERT_COMPONENT" && !componentKeys.has(op.componentKey)) {
        console.warn(`[validator] Lenient: skip op ${i} (componentKey not found)`);
        valid = false;
      }

      // Check styleId references
      if (op.type === "APPLY_TEXT_STYLE" && !textStyleIds.has(op.styleId)) {
        console.warn(`[validator] Lenient: skip op ${i} (text styleId not found)`);
        valid = false;
      }
      if (op.type === "APPLY_FILL_STYLE" && !fillStyleIds.has(op.styleId)) {
        console.warn(`[validator] Lenient: skip op ${i} (fill styleId not found)`);
        valid = false;
      }

      if (valid) validOps.push(op);
    }

    console.log(`[validator] Lenient: ${validOps.length}/${rawOps.length} operations valid`);
    // Empty operations is valid — the LLM may decide pre-processing did everything
    return {
      valid: validOps.length >= 0,
      batch: { operations: validOps } as ValidatedOperationBatch,
      errors: [],
    };
  }

  // 1. Schema validation
  const parseResult = OperationBatchSchema.safeParse(raw);
  if (!parseResult.success) {
    return {
      valid: false,
      errors: parseResult.error.issues.map(
        (i) => `[${i.path.join(".")}] ${i.message}`
      ),
    };
  }

  const batch = parseResult.data;

  // 2. Reference integrity
  for (let i = 0; i < batch.operations.length; i++) {
    const op = batch.operations[i];
    const prefix = `operations[${i}]`;

    switch (op.type) {
      case "INSERT_COMPONENT": {
        if (!componentKeys.has(op.componentKey)) {
          errors.push(
            `${prefix}: componentKey "${op.componentKey}" not found in design system`
          );
        }
        if (!nodeIds.has(op.parentId)) {
          errors.push(
            `${prefix}: parentId "${op.parentId}" not found in selection`
          );
        }
        break;
      }

      case "CREATE_FRAME": {
        if (!nodeIds.has(op.parentId)) {
          errors.push(
            `${prefix}: parentId "${op.parentId}" not found in selection`
          );
        }
        break;
      }

      case "SET_TEXT": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        break;
      }

      case "APPLY_TEXT_STYLE": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        if (!textStyleIds.has(op.styleId)) {
          errors.push(
            `${prefix}: styleId "${op.styleId}" not found in text styles`
          );
        }
        break;
      }

      case "APPLY_FILL_STYLE": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        if (!fillStyleIds.has(op.styleId)) {
          errors.push(
            `${prefix}: styleId "${op.styleId}" not found in fill styles`
          );
        }
        break;
      }

      case "RENAME_NODE": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        break;
      }

      case "SET_IMAGE": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        break;
      }

      case "RESIZE_NODE": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        if (!op.width && !op.height) {
          errors.push(
            `${prefix}: RESIZE_NODE must specify at least one of width or height`
          );
        }
        break;
      }

      case "MOVE_NODE": {
        if (!nodeIds.has(op.nodeId)) {
          errors.push(
            `${prefix}: nodeId "${op.nodeId}" not found in selection`
          );
        }
        break;
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, batch, errors: [] };
}
