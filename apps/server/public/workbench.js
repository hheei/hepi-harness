const $ = id => document.getElementById(id);
let selected = "";
let files = [];
const token = $("token");
const workspace = $("workspace");
function headers() { return { authorization: "Bearer " + token.value, "content-type": "application/json" }; }
async function call(operation, path) {
  const response = await fetch("/api/workbench", { method: "POST", headers: headers(), body: JSON.stringify({ workspaceId: workspace.value, operation, ...(path ? { path } : {}) }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.code ?? result.error ?? "Request failed");
  return result.value;
}
function showFiles(paths, onClick) {
  $("files").replaceChildren(...paths.map(path => {
    const button = document.createElement("button");
    button.className = "file";
    button.textContent = path;
    button.onclick = () => run(() => onClick(path));
    return button;
  }));
}
async function run(action) {
  try { await action(); } catch (error) { $("status").textContent = error.message; $("content").textContent = ""; }
}
async function load(operation) {
  for (const button of document.querySelectorAll("nav button")) button.setAttribute("aria-pressed", String(button.dataset.view === (operation === "read" ? "preview" : operation)));
  if ((operation === "read" || operation === "diff") && !selected) { $("status").textContent = "Select a file"; return; }
  $("status").textContent = "Loading";
  const value = await call(operation, operation === "read" || operation === "diff" ? selected : undefined);
  if (operation === "changes") {
    if (value.state !== "available") throw new Error(value.error.message);
    showFiles(value.files.map(file => file.path), async path => { selected = path; await load("diff"); });
    $("status").textContent = value.files.length + " changed files";
    $("content").textContent = value.files.map(file => file.status + (file.staged ? " (staged) " : " ") + file.path).join("\n");
  } else {
    $("status").textContent = selected + (operation === "read" ? " · " + value.sizeBytes + " bytes" + (value.truncated ? " · preview truncated" : "") : "");
    $("content").textContent = operation === "read" ? (value.binary ? "Binary file" : value.content) : value;
  }
}
async function connect() {
  const response = await fetch("/api/workspaces", { headers: headers() });
  if (!response.ok) throw new Error("Authentication failed");
  const value = await response.json();
  workspace.replaceChildren(...value.workspaces.map(item => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.id; return option; }));
  await openWorkspace();
}
async function openWorkspace() {
  selected = ""; $("content").textContent = "";
  if (!workspace.value) { showFiles([], () => {}); $("status").textContent = "No configured workspace"; return; }
  files = await call("files");
  showFiles(files, async path => { selected = path; await load("read"); });
  $("status").textContent = files.length + " files";
}
$("connect").onclick = () => run(connect);
workspace.onchange = () => run(openWorkspace);
for (const button of document.querySelectorAll("nav button")) button.onclick = () => run(async () => {
  if (button.dataset.view === "preview") { showFiles(files, async path => { selected = path; await load("read"); }); await load("read"); }
  else await load(button.dataset.view);
});
