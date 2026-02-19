# DesignOps AI — V1

A safe, design-system-aware AI assistant that modifies the current Figma file using structured operations. This is a **structured modifier**, not a full design generator.

## Project Structure

```
designops-ai/
  figma-plugin/
    manifest.json          # Figma plugin manifest
    code.ts                # Plugin sandbox logic (selection, apply, revert, logging)
    ui.html                # Plugin UI (single self-contained HTML file)
    ui.ts                  # TypeScript mirror of ui.html <script> (for dev reference)
    types.ts               # Shared plugin types (snapshots, messages, audit)
  backend/
    server.ts              # Express server — POST /plan endpoint
    llm.ts                 # Anthropic Claude API wrapper
    promptBuilder.ts       # System + user prompt construction
    schema.ts              # Zod schemas for operation validation
    validator.ts           # Schema + reference-integrity validation
  shared/
    operationSchema.ts     # Operation types shared between plugin & backend
```

## V1 Supported Operations

| Operation | Description |
|-----------|-------------|
| `INSERT_COMPONENT` | Insert an existing component by key into a parent |
| `CREATE_FRAME` | Create a new auto-layout frame |
| `SET_TEXT` | Change text content of a text node |
| `APPLY_TEXT_STYLE` | Apply a local text style to a text node |
| `APPLY_FILL_STYLE` | Apply a local fill/paint style to a node |
| `RENAME_NODE` | Rename any node |

## Prerequisites

- **Node.js** 18+
- **npm** 9+
- An **Anthropic API key** (Claude)
- **Figma Desktop** app (for loading the plugin)

## Setup

```bash
cd designops-ai

# Install dependencies
npm install

# Copy the env example and add your API key
cp .env.example .env
# Edit .env → set ANTHROPIC_API_KEY
```

## Development

### 1. Build the Figma Plugin

```bash
# One-time build
npm run build:plugin

# Watch mode (rebuilds on save)
npm run watch:plugin
```

This compiles `figma-plugin/code.ts` → `figma-plugin/code.js`.

### 2. Load in Figma

1. Open the **Figma Desktop** app
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Select `designops-ai/figma-plugin/manifest.json`
4. The plugin appears as **DesignOps AI** in the dev plugins list

### 3. Start the Backend

```bash
# With hot-reload
npm run dev:backend

# Or one-shot
npm run start:backend
```

The server starts on `http://localhost:3001`.

### 4. Use the Plugin

1. Select one or more nodes in Figma
2. Open the **DesignOps AI** plugin
3. Type your intent (e.g., "Rename all selected frames to use BEM naming")
4. Click **Preview Plan** — the plugin extracts snapshots, calls the backend, and shows planned operations
5. Click **Apply Changes** — operations are applied to the document
6. Click **Revert Last** — undoes the last batch of changes

## Safety Guarantees

- Only operates on **selected nodes**
- Never **deletes** nodes
- Never **invents** styles or components — only references existing design system entries
- All operations are **schema-validated** (Zod) before execution
- Full **revert** support persisted via `clientStorage`
- **Audit log** written to a hidden frame in the document

## Development Order (Recommended)

1. ✅ Static plugin without AI — test UI and message passing
2. ✅ Hardcoded operations — test all 6 operation applicators
3. ✅ Backend connection — end-to-end with LLM
4. ✅ Schema validation (Zod + reference integrity)
5. ✅ Revert feature
6. ✅ Audit logging

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/plan` | Generate validated operation batch from intent + snapshots |

### POST /plan — Request Body

```json
{
  "intent": "Rename all selected frames to follow BEM convention",
  "selection": {
    "nodes": [
      { "id": "1:23", "name": "Frame 1", "type": "FRAME", "childrenCount": 3 }
    ]
  },
  "designSystem": {
    "textStyles": [{ "id": "S:abc", "name": "Heading/H1" }],
    "fillStyles": [{ "id": "S:def", "name": "Primary/Blue" }],
    "components": [{ "key": "abc123", "name": "Button/Primary" }],
    "variables": [{ "id": "V:1", "name": "spacing/sm" }]
  }
}
```

### POST /plan — Response

```json
{
  "operations": [
    { "type": "RENAME_NODE", "nodeId": "1:23", "name": "block__element" }
  ]
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `PORT` | No | Backend port (default: 3001) |

## License

Private — internal use only.
