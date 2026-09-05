import { ContentLengthDecoder } from "./language-server.mjs";

const notifications = [];
const write = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  process.stdout.write(frame.subarray(0, 7));
  process.stdout.write(frame.subarray(7));
};
const decoder = new ContentLengthDecoder((message) => {
  if (message.method === "initialize") {
    write({ id: "configuration", method: "workspace/configuration", params: { items: [{ section: "bicep" }, { section: "unknown" }] } });
    write({ id: message.id, result: { capabilities: {} } });
  } else if (message.method === "exit") {
    process.exit(0);
  } else if (message.method === "test/exit") {
    process.exit(23);
  } else if (message.method === "test/wait") {
    // Deliberately leave pending to exercise timeout/cancellation.
  } else if (message.method === "test/messages") {
    write({ id: message.id, result: notifications });
  } else if (message.method === "test/error") {
    write({ id: message.id, error: { code: -32000, message: "Expected failure" } });
  } else if (message.method === "shutdown") {
    write({ id: message.id, result: null });
  } else {
    notifications.push(message);
    if (message.method === "textDocument/didOpen") {
      write({ method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics: [] } });
    }
  }
});
process.stdin.on("data", (chunk) => decoder.push(chunk));
