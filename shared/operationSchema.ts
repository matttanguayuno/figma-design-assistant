// shared/operationSchema.ts
// Shared operation types used by both the Figma plugin and the backend.

export type LayoutSpec = {
  direction?: "HORIZONTAL" | "VERTICAL";
  spacingToken?: string;
  paddingToken?: string;
};

export type Operation =
  | {
      type: "INSERT_COMPONENT";
      componentKey: string;
      parentId: string;
    }
  | {
      type: "CREATE_FRAME";
      parentId: string;
      name: string;
      layout?: LayoutSpec;
    }
  | {
      type: "SET_TEXT";
      nodeId: string;
      text: string;
    }
  | {
      type: "APPLY_TEXT_STYLE";
      nodeId: string;
      styleId: string;
    }
  | {
      type: "APPLY_FILL_STYLE";
      nodeId: string;
      styleId: string;
    }
  | {
      type: "RENAME_NODE";
      nodeId: string;
      name: string;
    }
  | {
      type: "SET_IMAGE";
      nodeId: string;
      imagePrompt: string;
      imageBase64?: string; // resolved by backend — base64 encoded image bytes
    }
  | {
      type: "RESIZE_NODE";
      nodeId: string;
      width?: number;
      height?: number;
    }
  | {
      type: "MOVE_NODE";
      nodeId: string;
      x: number;
      y: number;
    }
  | {
      type: "CLONE_NODE";
      nodeId: string;
      parentId: string;
      insertIndex?: number;
    }
  | {
      type: "DELETE_NODE";
      nodeId: string;
    }
  | {
      type: "DUPLICATE_FRAME";
      nodeId: string;
      variantIntent?: string;
    }
  | {
      type: "SET_FILL_COLOR";
      nodeId: string;
      color: string; // hex color e.g. "#1A1A2E"
    }
  | {
      type: "SET_LAYOUT_MODE";
      nodeId: string;
      layoutMode: "HORIZONTAL" | "VERTICAL" | "NONE";
      wrap?: boolean;
    }
  | {
      type: "SET_LAYOUT_PROPS";
      nodeId: string;
      paddingTop?: number;
      paddingRight?: number;
      paddingBottom?: number;
      paddingLeft?: number;
      itemSpacing?: number;
      counterAxisSpacing?: number;
    }
  | {
      type: "SET_SIZE_MODE";
      nodeId: string;
      horizontal?: "FIXED" | "FILL" | "HUG";
      vertical?: "FIXED" | "FILL" | "HUG";
    };

export type OperationBatch = {
  operations: Operation[];
};
