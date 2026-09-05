(() => {
  const base = new URL(".", location.href);
  const emit = (data) => window.dispatchEvent(new MessageEvent("message", { data, origin: location.origin }));
  let ready = false;
  let currentDocument;
  const stream = new EventSource(new URL("events", base));
  stream.addEventListener("document", (event) => {
    currentDocument = JSON.parse(event.data);
    if (ready) emit(currentDocument);
  });
  stream.addEventListener("state", (event) => {
    const state = JSON.parse(event.data);
    if (state.filePath) currentDocument = { method: "documentDidChange", params: { documentUri: state.filePath } };
  });
  stream.addEventListener("open", () => { if (ready && currentDocument) emit(currentDocument); });
  window.acquireVsCodeApi = () => ({
    postMessage: async (message) => {
      if (message.method === "ready") ready = true;
      try {
        const response = await fetch(new URL("message", base), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message),
        });
        const data = await response.json();
        if (message.id) emit(data);
        else if (!response.ok) throw new Error(data.error);
      } catch (error) {
        if (message.id) emit({ id: message.id, error: { message: error.message } });
        window.parent.dispatchEvent(new CustomEvent("bicep-error", { detail: error.message }));
      }
    },
  });
  // Keep the upstream renderer untouched; supply the two VS Code/browser services it expects.
  window.showSaveFilePicker = async (options) => {
    const destination = await window.parent.bicepChooseExport(options.suggestedName);
    return {
      createWritable: async () => ({
        write: async (blob) => {
          const target = new URL("export", base);
          target.searchParams.set("name", destination.name);
          target.searchParams.set("folder", destination.folder);
          const response = await fetch(target, { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
          const data = await response.json();
          if (!response.ok) {
            window.parent.dispatchEvent(new CustomEvent("bicep-error", { detail: data.error }));
            // The upstream exporter treats AbortError as handled, rather than silently downloading elsewhere.
            throw new DOMException(data.error, "AbortError");
          }
        },
        close: async () => {},
      }),
    };
  };
  window.addEventListener("pagehide", () => stream.close(), { once: true });
})();
