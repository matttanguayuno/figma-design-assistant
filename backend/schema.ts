// backend/schema.ts
// Zod schemas for validating operation batches from the LLM.

import { z } from "zod";

// ── Layout Spec ─────────────────────────────────────────────────────

export const LayoutSpecSchema = z.object({
  direction: z.enum(["HORIZONTAL", "VERTICAL"]).optional(),
  spacingToken: z.string().optional(),
  paddingToken: z.string().optional(),
});

// ── Individual Operation Schemas ────────────────────────────────────

const InsertComponentSchema = z.object({
  type: z.literal("INSERT_COMPONENT"),
  componentKey: z.string().min(1),
  parentId: z.string().min(1),
});

const CreateFrameSchema = z.object({
  type: z.literal("CREATE_FRAME"),
  parentId: z.string().min(1),
  name: z.string().min(1),
  layout: LayoutSpecSchema.optional(),
});

const SetTextSchema = z.object({
  type: z.literal("SET_TEXT"),
  nodeId: z.string().min(1),
  text: z.string(),
});

const ApplyTextStyleSchema = z.object({
  type: z.literal("APPLY_TEXT_STYLE"),
  nodeId: z.string().min(1),
  styleId: z.string().min(1),
});

const ApplyFillStyleSchema = z.object({
  type: z.literal("APPLY_FILL_STYLE"),
  nodeId: z.string().min(1),
  styleId: z.string().min(1),
});

const RenameNodeSchema = z.object({
  type: z.literal("RENAME_NODE"),
  nodeId: z.string().min(1),
  name: z.string().min(1),
});

const SetImageSchema = z.object({
  type: z.literal("SET_IMAGE"),
  nodeId: z.string().min(1),
  imagePrompt: z.string().min(1),
});

const ResizeNodeSchema = z.object({
  type: z.literal("RESIZE_NODE"),
  nodeId: z.string().min(1),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

const MoveNodeSchema = z.object({
  type: z.literal("MOVE_NODE"),
  nodeId: z.string().min(1),
  x: z.number(),
  y: z.number(),
});

const CloneNodeSchema = z.object({
  type: z.literal("CLONE_NODE"),
  nodeId: z.string().min(1),
  parentId: z.string().min(1),
  insertIndex: z.number().int().nonnegative().optional(),
});

const DeleteNodeSchema = z.object({
  type: z.literal("DELETE_NODE"),
  nodeId: z.string().min(1),
});

const DuplicateFrameSchema = z.object({
  type: z.literal("DUPLICATE_FRAME"),
  nodeId: z.string().min(1),
  variantIntent: z.string().optional(),
});

const SetFillColorSchema = z.object({
  type: z.literal("SET_FILL_COLOR"),
  nodeId: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color like #FF0000"),
});

const SetLayoutModeSchema = z.object({
  type: z.literal("SET_LAYOUT_MODE"),
  nodeId: z.string().min(1),
  layoutMode: z.enum(["HORIZONTAL", "VERTICAL", "NONE"]),
  wrap: z.boolean().optional(),
});

const SetLayoutPropsSchema = z.object({
  type: z.literal("SET_LAYOUT_PROPS"),
  nodeId: z.string().min(1),
  paddingTop: z.number().nonnegative().optional(),
  paddingRight: z.number().nonnegative().optional(),
  paddingBottom: z.number().nonnegative().optional(),
  paddingLeft: z.number().nonnegative().optional(),
  itemSpacing: z.number().nonnegative().optional(),
  counterAxisSpacing: z.number().nonnegative().optional(),
});

const SetSizeModeSchema = z.object({
  type: z.literal("SET_SIZE_MODE"),
  nodeId: z.string().min(1),
  horizontal: z.enum(["FIXED", "FILL", "HUG"]).optional(),
  vertical: z.enum(["FIXED", "FILL", "HUG"]).optional(),
});

// ── Discriminated Union ─────────────────────────────────────────────

export const OperationSchema = z.discriminatedUnion("type", [
  InsertComponentSchema,
  CreateFrameSchema,
  SetTextSchema,
  ApplyTextStyleSchema,
  ApplyFillStyleSchema,
  RenameNodeSchema,
  SetImageSchema,
  ResizeNodeSchema,
  MoveNodeSchema,
  CloneNodeSchema,
  DeleteNodeSchema,
  DuplicateFrameSchema,
  SetFillColorSchema,
  SetLayoutModeSchema,
  SetLayoutPropsSchema,
  SetSizeModeSchema,
]);

// ── Batch ────────────────────────────────────────────────────────────

export const OperationBatchSchema = z.object({
  operations: z.array(OperationSchema).max(50),
});

export type ValidatedOperationBatch = z.infer<typeof OperationBatchSchema>;
