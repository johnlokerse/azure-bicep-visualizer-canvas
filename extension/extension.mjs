import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { ensureBicepRuntime } from "./bootstrap.mjs";
import { startCanvas } from "./server.mjs";

const panels = new Map();
let runtimeError;
const runtimeReady = ensureBicepRuntime().catch((error) => {
  runtimeError = error;
  console.error(error.message);
  return null;
});
const object = (properties = {}, required = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const path = { type: "string", minLength: 1 };
function panel(ctx) {
  const entry = panels.get(ctx.instanceId);
  if (!entry) throw new CanvasError("panel_not_open", "Open the visualizer first.");
  return entry;
}

await joinSession({
  canvases: [createCanvas({
    id: "bicep-visualizer",
    displayName: "Bicep Visualizer",
    description: "The original Bicep resource graph with live dependencies, nested modules, layout, source navigation, problems, and PNG export.",
    inputSchema: object({
      rootPath: { ...path, description: "Absolute repository or workspace directory. Defaults to this session's working directory." },
      filePath: { ...path, description: "Bicep entrypoint, absolute or relative to rootPath. Omit to show the file picker." },
    }),
    actions: [
      {
        name: "get_state",
        description: "Get the current workspace, entrypoint, diagnostics, and upstream version.",
        inputSchema: object(),
        handler: (ctx) => panel(ctx).state(),
      },
      {
        name: "open_file",
        description: "Visualize a Bicep entrypoint in this panel's workspace.",
        inputSchema: object({ filePath: path }, ["filePath"]),
        handler: (ctx) => panel(ctx).select(ctx.input.filePath),
      },
      {
        name: "refresh",
        description: "Reload saved files and refresh the graph.",
        inputSchema: object(),
        handler: (ctx) => panel(ctx).refresh(),
      },
      {
        name: "reveal_node",
        description: "Resolve a graph node to its source and show the highlighted declaration.",
        inputSchema: object({ nodeId: path }, ["nodeId"]),
        handler: (ctx) => panel(ctx).revealNode(ctx.input.nodeId),
      },
    ],
    open: async (ctx) => {
      const runtime = await runtimeReady;
      if (!runtime) throw new CanvasError("runtime_setup_failed", runtimeError.message);
      let entry = panels.get(ctx.instanceId);
      if (!entry) {
        entry = await startCanvas(ctx.input ?? {}, runtime);
        panels.set(ctx.instanceId, entry);
      }
      return { title: "Bicep Visualizer", url: entry.url };
    },
    onClose: async (ctx) => {
      const entry = panels.get(ctx.instanceId);
      panels.delete(ctx.instanceId);
      await entry?.close();
    },
  })],
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([...panels.values()].map((entry) => entry.close()));
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
