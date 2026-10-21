const origin = process.env.HEPI_SERVER_URL ?? "http://127.0.0.1:8787";
const token = process.env.HEPI_AUTH_TOKEN;
if (!token) throw new Error("HEPI_AUTH_TOKEN required; start backend with paid-provider configuration first");
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const createdResponse = await fetch(origin + "/api/conversations", { method: "POST", headers });
if (!createdResponse.ok) throw new Error("create failed: " + createdResponse.status);
const created = await createdResponse.json();
const path = origin + "/api/conversations/" + created.conversationId;
const state = await (await fetch(path + "/state", { headers })).json();
// A conversation may have no selected model (its selection can be removed from the catalog), which is as unusable
// for a paid smoke as the offline default.
if (state.settings.model === null || state.settings.model.provider === "faux") throw new Error("Refusing faux: configure HEPI_PROVIDER/HEPI_MODEL on the backend");
const stream = await fetch(path + "/events", { headers, signal: AbortSignal.timeout(60000) });
if (!stream.ok || !stream.body) throw new Error("stream failed");
const reader = stream.body.getReader();
try {
  const response = await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: crypto.randomUUID(), text: "Reply with exactly: provider smoke OK" }) });
  if (!response.ok) throw new Error("submit failed: " + response.status);
  const decoder = new TextDecoder(); let pending = "";
  outer: while (true) {
    const chunk = await reader.read(); if (chunk.done) throw new Error("stream ended before response");
    pending += decoder.decode(chunk.value, { stream: true }); let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const line = frame.split("\n").find(value => value.startsWith("data: ")); if (!line) continue;
      const current = JSON.parse(line.slice(6)); const answer = current.entries?.findLast((entry: { role: string }) => entry.role === "assistant");
      if (answer && !current.busy) {
        if (answer.message.stopReason === "error" || answer.message.stopReason === "aborted" || !answer.text?.includes("provider smoke OK")) throw new Error("provider response failed; inspect conversation " + created.conversationId);
        console.log("Paid-provider SSE smoke passed", { conversationId: created.conversationId, model: current.settings.model }); break outer;
      }
    }
  }
} finally { await reader.cancel(); }
export {};
