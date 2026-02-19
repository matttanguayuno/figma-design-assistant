// figma-plugin/ui.ts
// This file mirrors the inline <script> in ui.html for type-safety during
// development. The actual runtime script is embedded directly in ui.html
// because Figma plugins require a single self-contained HTML file for the UI.
//
// If you prefer to bundle separately (e.g. with esbuild), compile this file
// and replace the <script> block in ui.html with the output.

import { OperationBatch, Operation } from "../shared/operationSchema";
import { UIToPluginMessage, PluginToUIMessage } from "./types";

// ── DOM References ────────────────────────────────────────────────

const intentEl = document.getElementById("intent") as HTMLTextAreaElement;
const btnPreview = document.getElementById("btn-preview") as HTMLButtonElement;
const btnApply = document.getElementById("btn-apply") as HTMLButtonElement;
const btnRevert = document.getElementById("btn-revert") as HTMLButtonElement;
const planOutput = document.getElementById("plan-output") as HTMLDivElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;
const menuToggle = document.getElementById("menu-toggle") as HTMLButtonElement;
const menuDropdown = document.getElementById("menu-dropdown") as HTMLDivElement;
const menuExportJson = document.getElementById("menu-export-json") as HTMLButtonElement;
const menuImportJson = document.getElementById("menu-import-json") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;

// ── Helpers ───────────────────────────────────────────────────────

function setStatus(msg: string, type?: "success" | "error"): void {
  statusBar.textContent = msg;
  statusBar.className = "status-bar" + (type ? ` ${type}` : "");
}

function formatOp(op: Operation): string {
  switch (op.type) {
    case "INSERT_COMPONENT":
      return `INSERT_COMPONENT → key: ${op.componentKey}, parent: ${op.parentId}`;
    case "CREATE_FRAME":
      return `CREATE_FRAME → name: "${op.name}", parent: ${op.parentId}`;
    case "SET_TEXT":
      return `SET_TEXT → node: ${op.nodeId}, text: "${op.text}"`;
    case "APPLY_TEXT_STYLE":
      return `APPLY_TEXT_STYLE → node: ${op.nodeId}, style: ${op.styleId}`;
    case "APPLY_FILL_STYLE":
      return `APPLY_FILL_STYLE → node: ${op.nodeId}, style: ${op.styleId}`;
    case "RENAME_NODE":
      return `RENAME_NODE → node: ${op.nodeId}, name: "${op.name}"`;
    default:
      return JSON.stringify(op);
  }
}

function postToPlugin(msg: UIToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, "*");
}

// ── Button Handlers ───────────────────────────────────────────────

btnPreview.addEventListener("click", () => {
  const intent = intentEl.value.trim();
  if (!intent) {
    setStatus("Please enter an intent first.", "error");
    return;
  }
  btnPreview.disabled = true;
  btnApply.disabled = true;
  planOutput.textContent = "Loading…";
  setStatus("Requesting plan…");
  postToPlugin({ type: "preview-plan", intent });
});

btnApply.addEventListener("click", () => {
  btnApply.disabled = true;
  setStatus("Applying changes…");
  postToPlugin({ type: "apply-changes" });
});

btnRevert.addEventListener("click", () => {
  setStatus("Reverting…");
  postToPlugin({ type: "revert-last" });
});

// ── Menu Toggle ───────────────────────────────────────────────────

menuToggle.addEventListener("click", (e: MouseEvent) => {
  e.stopPropagation();
  const isOpen = menuDropdown.classList.toggle("show");
  menuToggle.classList.toggle("open", isOpen);
});

document.addEventListener("click", (e: MouseEvent) => {
  if (!menuDropdown.contains(e.target as Node) && e.target !== menuToggle) {
    menuDropdown.classList.remove("show");
    menuToggle.classList.remove("open");
  }
});

// ── Menu: Export design to JSON ───────────────────────────────────

menuExportJson.addEventListener("click", () => {
  menuDropdown.classList.remove("show");
  menuToggle.classList.remove("open");
  setStatus("Exporting design to JSON…");
  postToPlugin({ type: "export-json" });
});
// \u2500\u2500 Menu: Import design from JSON \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

menuImportJson.addEventListener("click", () => {
  menuDropdown.classList.remove("show");
  menuToggle.classList.remove("open");
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  setStatus("Reading JSON file\u2026");
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      if (!data.selection || !data.selection.nodes) {
        setStatus("Invalid JSON: missing selection.nodes", "error");
        return;
      }
      setStatus("Importing design\u2026");
      postToPlugin({ type: "import-json", data });
    } catch (err: any) {
      setStatus("Invalid JSON file: " + err.message, "error");
    }
  };
  reader.onerror = () => setStatus("Failed to read file.", "error");
  reader.readAsText(file);
});
function downloadJson(data: object): void {
  const json = JSON.stringify(data, null, 2);
  const dataUri = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const a = document.createElement("a");
  a.href = dataUri;
  a.download = "design-export.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Receive from Plugin ───────────────────────────────────────────

window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage as PluginToUIMessage;
  if (!msg) return;

  switch (msg.type) {
    case "plan-ready": {
      const ops = msg.batch.operations;
      planOutput.textContent = ops
        .map((op, i) => `${i + 1}. ${formatOp(op)}`)
        .join("\n");
      btnPreview.disabled = false;
      btnApply.disabled = false;
      setStatus(`Plan ready: ${ops.length} operation(s)`, "success");
      break;
    }
    case "apply-success": {
      planOutput.textContent = msg.summary;
      btnApply.disabled = true;
      setStatus("Changes applied successfully.", "success");
      break;
    }
    case "apply-error": {
      setStatus(msg.error, "error");
      btnPreview.disabled = false;
      break;
    }
    case "revert-success": {
      planOutput.textContent = "Reverted to previous state.";
      setStatus("Revert successful.", "success");
      break;
    }
    case "revert-error": {
      setStatus(msg.error, "error");
      break;
    }
    case "status": {
      setStatus(msg.message);
      break;
    }
    case "export-json-result": {
      downloadJson(msg.data);
      setStatus("JSON saved.", "success");
      break;
    }
    case "export-json-error": {
      setStatus(msg.error, "error");
      break;
    }
    case "import-json-success": {
      setStatus(msg.summary, "success");
      break;
    }
    case "import-json-error": {
      setStatus(msg.error, "error");
      break;
    }
  }
};
