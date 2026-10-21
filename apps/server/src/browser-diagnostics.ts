import { BrowserDurableSession } from "@hepi/session/browser";
import type { SessionState } from "@hepi/session";
const tokenInput = document.querySelector<HTMLInputElement>("#token")!;
const conversations = document.querySelector<HTMLSelectElement>("#conversations")!;
const status = document.querySelector<HTMLElement>("#status")!;
const messages = document.querySelector<HTMLElement>("#messages")!;
const text = document.querySelector<HTMLTextAreaElement>("#text")!;
let token = "";
let session: BrowserDurableSession | undefined;
const fail = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); };
async function api(path: string, method = "GET") {
  const response = await fetch(path, { method, headers: { authorization: "Bearer " + token } });
  if (!response.ok) throw new Error("Request failed: " + response.status);
  return response.json();
}
function render(state: SessionState) {
  messages.replaceChildren();
  const entries = [...state.entries];
  if (state.partial) entries.push({ id: "partial", role: "assistant", text: state.partial });
  for (const entry of entries) {
    const article = document.createElement("article"); article.dataset.role = entry.role;
    const label = document.createElement("strong"); label.textContent = entry.role + "\n";
    article.append(label, document.createTextNode(entry.text)); messages.append(article);
  }
  status.textContent = state.busy ? "Running…" : "Connected";
}
async function open(id: string) {
  session?.close();
  messages.replaceChildren(); status.textContent = "Connecting…";
  session = new BrowserDurableSession(location.origin, token, id, render, fail);
  await session.connect();
}
async function refresh(preferred?: string) {
  const data = await api("/api/conversations");
  conversations.replaceChildren();
  for (const item of data.conversations) { const option = new Option(item.id, item.id); conversations.add(option); }
  if (preferred) conversations.value = preferred;
  if (conversations.value) await open(conversations.value);
}
document.querySelector("#connect")!.addEventListener("click", () => { token = tokenInput.value; void refresh().catch(fail); });
conversations.addEventListener("change", () => { void open(conversations.value).catch(fail); });
document.querySelector("#create")!.addEventListener("click", () => { void api("/api/conversations", "POST").then(data => refresh(data.conversationId)).catch(fail); });
document.querySelector("#disconnect")!.addEventListener("click", () => { session?.close(); session = undefined; status.textContent = "Disconnected"; });
document.querySelector("#abort")!.addEventListener("click", () => { if (session) void session.abort().catch(fail); });
document.querySelector("#composer")!.addEventListener("submit", (event) => {
  event.preventDefault(); const value = text.value.trim();
  if (!session || !value) return;
  const current = session;
  void current.submit(crypto.randomUUID(), value).then(() => { if (session === current && text.value.trim() === value) text.value = ""; }).catch(fail);
});
window.addEventListener("pagehide", () => session?.close());
