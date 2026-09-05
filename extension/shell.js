const $ = (id) => document.getElementById(id);
let state;
let files = [];
let activeFile;
let showPicker = false;
let savePending;
let detailsMode;
const themeKey = "bicep-visualizer.theme";

async function api(route, data) {
  const response = await fetch(route, data === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !message;
}
function run(callback) {
  return (...args) => {
    try { return Promise.resolve(callback(...args)).catch((error) => notice(error.message, true)); }
    catch (error) { notice(error.message, true); }
  };
}
function update(next) {
  state = next;
  $("filename").textContent = state.filePath ? state.filePath.split("/").at(-1) : "No file selected";
  $("filename").title = state.filePath ?? "";
  $("workspace").value = state.rootPath;
  $("source").disabled = !state.filePath;
  $("problem-count").textContent = state.diagnostics.length;
  if (state.error) notice(state.error, true);
  if (activeFile !== state.filePath) {
    activeFile = state.filePath;
    $("details").hidden = true;
    if (activeFile) {
      showPicker = false;
      $("graph").src = `graph?file=${encodeURIComponent(activeFile)}`;
    } else $("graph").removeAttribute("src");
  }
  $("picker").hidden = Boolean(activeFile) && !showPicker;
  $("graph").hidden = !activeFile || showPicker;
  if (detailsMode === "problems" && !$("details").hidden) problems();
}
function renderFiles() {
  const filter = $("filter").value.toLowerCase();
  const matches = files.filter((file) => file.toLowerCase().includes(filter));
  $("files").replaceChildren();
  $("file-status").textContent = matches.length ? `${matches.length} Bicep files` : "No matching Bicep files in this workspace.";
  for (const file of matches) {
    const button = document.createElement("button");
    button.textContent = file;
    button.onclick = run(async () => {
      button.disabled = true;
      notice("Loading Bicep language server and resource graph...");
      try {
        const next = await api("select", { filePath: file });
        showPicker = false;
        update(next);
        notice("");
      } finally { button.disabled = false; }
    });
    $("files").append(button);
  }
}
async function loadFiles() {
  $("file-status").textContent = "Finding Bicep files...";
  const result = await api("files");
  files = result.files;
  renderFiles();
}
function reveal(source) {
  detailsMode = "source";
  $("details").hidden = false;
  $("details-title").textContent = source.filePath.split("/").at(-1);
  const content = $("details-content");
  content.replaceChildren();
  const link = document.createElement("a");
  link.textContent = "Open in VS Code";
  link.className = "source-link";
  let editorPath = source.filePath.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(editorPath)) editorPath = `/${editorPath}`;
  link.href = `vscode://file${encodeURI(editorPath).replaceAll("#", "%23").replaceAll("?", "%3F")}:${(source.range?.start.line ?? 0) + 1}:${(source.range?.start.character ?? 0) + 1}`;
  content.append(link);
  const pre = document.createElement("pre");
  pre.className = "code";
  const start = source.range?.start.line ?? 0;
  const end = source.range?.end.line ?? start;
  source.content.split(/\r?\n/).forEach((text, i) => {
    const line = document.createElement("span");
    line.className = `code-line${i >= start && i <= end ? " selected" : ""}`;
    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = i + 1;
    line.append(number, document.createTextNode(text));
    pre.append(line);
  });
  content.append(pre);
  requestAnimationFrame(() => pre.children[start]?.scrollIntoView({ block: "center" }));
}
function problems() {
  detailsMode = "problems";
  $("details").hidden = false;
  $("details-title").textContent = `Problems (${state.diagnostics.length})`;
  const content = $("details-content");
  content.replaceChildren();
  if (!state.diagnostics.length) content.textContent = "No problems reported by Bicep.";
  for (const problem of state.diagnostics) {
    const button = document.createElement("button");
    button.className = "problem";
    button.append(document.createTextNode(`${problem.severity === 1 ? "Error" : problem.severity === 2 ? "Warning" : "Info"} ${problem.code ?? ""}: ${problem.message}`));
    const location = document.createElement("small");
    location.textContent = `${decodeURIComponent(new URL(problem.uri).pathname)}:${problem.range.start.line + 1}`;
    button.append(location);
    button.onclick = run(async () => reveal(await api("source", { uri: problem.uri, range: problem.range })));
    content.append(button);
  }
}
function theme() {
  const selected = $("theme").value;
  const mode = document.documentElement.dataset.colorMode ?? document.body.dataset.colorMode;
  const dark = mode === "dark" || (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const kind = selected === "auto" ? (dark ? "vscode-dark" : "vscode-light") : selected;
  $("graph").contentDocument?.body?.setAttribute("data-vscode-theme-kind", kind);
}
$("theme").value = localStorage.getItem(themeKey) ?? "auto";
$("theme").onchange = () => { localStorage.setItem(themeKey, $("theme").value); theme(); };
$("graph").onload = theme;
const observer = new MutationObserver(theme);
observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode", "data-dark-theme", "data-light-theme"] });
observer.observe(document.body, { attributes: true, attributeFilter: ["data-color-mode"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
$("filter").oninput = renderFiles;
$("choose").onclick = run(async () => { showPicker = true; update(state); await loadFiles(); $("filter").focus(); });
$("workspace-form").onsubmit = run(async (event) => {
  event.preventDefault();
  notice("");
  update(await api("workspace", { rootPath: $("workspace").value }));
  await loadFiles();
});
$("refresh").onclick = run(async () => { notice(""); update(await api("refresh", {})); if (showPicker || !activeFile) await loadFiles(); });
$("source").onclick = run(async () => reveal(await api("source", {})));
$("problems").onclick = problems;
$("close-details").onclick = () => { $("details").hidden = true; detailsMode = null; };
window.addEventListener("bicep-error", (event) => notice(event.detail, true));
window.bicepChooseExport = (name) => new Promise((resolve, reject) => {
  if (savePending) { reject(new Error("An export dialog is already open.")); return; }
  savePending = { resolve, reject };
  $("export-name").value = name ?? "bicep-graph.png";
  $("save-dialog").showModal();
  $("export-name").focus();
});
$("save-form").onsubmit = (event) => {
  event.preventDefault();
  const pending = savePending;
  savePending = null;
  $("save-dialog").close();
  pending?.resolve({ name: $("export-name").value, folder: $("export-folder").value.trim() });
};
function cancelSave() {
  const pending = savePending;
  savePending = null;
  $("save-dialog").close();
  pending?.reject(new DOMException("Export cancelled.", "AbortError"));
}
$("cancel-save").onclick = cancelSave;
$("save-dialog").oncancel = (event) => { event.preventDefault(); cancelSave(); };
const events = new EventSource("events");
events.addEventListener("state", (event) => update(JSON.parse(event.data)));
events.addEventListener("selected", (event) => update(JSON.parse(event.data)));
events.addEventListener("source", (event) => reveal(JSON.parse(event.data)));
events.addEventListener("problems", (event) => { update(JSON.parse(event.data)); problems(); });
events.addEventListener("failure", (event) => notice(JSON.parse(event.data).message, true));
events.addEventListener("exported", (event) => {
  const result = JSON.parse(event.data);
  notice(`PNG saved: ${result.filePath} `);
  const link = document.createElement("a");
  link.textContent = "View PNG";
  link.href = result.url;
  link.target = "_blank";
  link.rel = "noopener";
  $("notice").append(link);
});
events.onerror = () => notice("Connection lost. Reconnecting to the canvas...", true);
events.onopen = () => notice("");
window.addEventListener("pagehide", () => { events.close(); observer.disconnect(); });
await run(async () => {
  update(await api("state"));
  if (!activeFile) await loadFiles();
})();
