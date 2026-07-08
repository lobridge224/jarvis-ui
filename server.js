import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_DIR || path.join(__dirname, "workspace"));
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
const FILES_REGISTRY = path.join(__dirname, "data", "files.json");
const COMMAND_LOG = path.join(__dirname, "data", "commands.log");
const TOOLS_DIR = path.join(__dirname, "tools");
const PENDING_DIR = path.join(TOOLS_DIR, "pending");
const PUBLIC_DIR = path.join(__dirname, "public");
const UI_PENDING_DIR = path.join(__dirname, "ui-pending");
const BACKUPS_DIR = path.join(__dirname, "backups");
const MAX_BACKUPS = 20;
const EDITABLE_UI_FILES = ["app.js", "style.css", "index.html"];
const FILES_API_BETA_HEADER = "files-api-2025-04-14";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const PERSONA_FILE = path.join(__dirname, "persona.txt");
const MODEL = process.env.MODEL || "claude-sonnet-5";
const MAX_HISTORY_MESSAGES = 60;
const MAX_TOOL_ROUNDS = 6;

const DEFAULT_PERSONA = `You are Jarvis, a personal AI assistant running locally on the user's own computer.
You have real access to files inside a designated workspace folder via tools — use them whenever a
task needs actual file content, not just conversation. Be direct and efficient. Confirm before
overwriting a file that already has meaningful content. If a request would require touching files
outside the workspace, say so plainly instead of guessing a path.`;

async function getPersona() {
  try {
    return (await fs.readFile(PERSONA_FILE, "utf8")).trim() || DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
}

// ---------- workspace-scoped file tools ----------

function safeResolve(relPath) {
  const target = path.resolve(WORKSPACE_ROOT, relPath || ".");
  if (target !== WORKSPACE_ROOT && !target.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`"${relPath}" is outside the workspace — request denied.`);
  }
  return target;
}

const builtinTools = [
  { type: "web_search_20250305", name: "web_search" },
  {
    name: "list_files",
    description: "List files and folders at a path inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from the workspace root. Use '.' for the root." }
      },
      required: ["path"]
    }
  },
  {
    name: "read_file",
    description: "Read the text contents of a file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path from the workspace root." }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path from the workspace root." },
        content: { type: "string", description: "Full text content to write." }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list_uploaded_files",
    description: "List files previously uploaded to Jarvis's file library. These were uploaded via the Files API and are available from any device, not just this one.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "create_tool",
    description: "Propose a brand new tool to extend your own capabilities. The code is staged in a pending folder for human approval and will NOT run until approved — do not assume it's active yet. Use this when the user asks for a capability you don't currently have.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short snake_case tool name, e.g. get_weather. Must be unique." },
        description: { type: "string", description: "Description of what the tool does, written for a model deciding when to call it." },
        input_schema: { type: "object", description: "A valid JSON schema object describing the tool's input parameters (type, properties, required)." },
        code: { type: "string", description: "The JS statements for the body of an async function run(input) that returns a string. Node built-ins and global fetch are available. Do not import packages that aren't already dependencies (express, multer)." }
      },
      required: ["name", "description", "input_schema", "code"]
    }
  },
  {
    name: "propose_ui_change",
    description: "Propose a change to Jarvis's own interface — app.js, style.css, or index.html. Provide the COMPLETE new content of the file, not a fragment or diff. This is staged for human approval and shown as a diff; it will NOT take effect until approved. Only one pending proposal is kept per file — a new proposal for the same file replaces the previous one. Before editing app.js or index.html, use read_file-style knowledge of the current file (ask the user to confirm current contents if unsure) since element IDs referenced in app.js must still exist in index.html or the change will be rejected automatically.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["app.js", "style.css", "index.html"], description: "Which UI file to change." },
        content: { type: "string", description: "The full new file content." },
        reason: { type: "string", description: "A short, human-readable explanation of what this changes and why. Shown to the user during review." }
      },
      required: ["file", "content", "reason"]
    }
  },
  {
    name: "run_system_command",
    description: "Run a PowerShell command on the user's computer — open an application, check system info, or perform an OS-level action. Runs immediately with no approval step, by the user's explicit choice, so get the command right the first time. A short list of catastrophic patterns (mass deletion, formatting drives, download-and-execute, reading secrets, shutdown/restart) are blocked regardless. Every command is logged to data/commands.log for the user to review.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The PowerShell command to run." },
        description: { type: "string", description: "One short line explaining what this does and why — shown in the audit log." }
      },
      required: ["command", "description"]
    }
  }
];

async function runTool(name, input) {
  try {
    if (name === "list_files") {
      const dir = safeResolve(input.path);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.length === 0) return "(empty directory)";
      return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort().join("\n");
    }
    if (name === "read_file") {
      const file = safeResolve(input.path);
      const stat = await fs.stat(file);
      if (stat.size > 200_000) return "File too large to read (over 200KB) — ask for a specific section instead.";
      return await fs.readFile(file, "utf8");
    }
    if (name === "write_file") {
      const file = safeResolve(input.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, input.content ?? "", "utf8");
      return `Wrote ${(input.content ?? "").length} characters to ${input.path}`;
    }
    if (name === "list_uploaded_files") {
      const files = await loadFiles();
      if (files.length === 0) return "(no files uploaded yet)";
      return files
        .map((f) => `${f.filename} — id:${f.file_id} — ${f.mime_type} — ${Math.round(f.size_bytes / 1024)}KB`)
        .join("\n");
    }
    if (name === "create_tool") {
      return await proposeTool(input);
    }
    if (name === "propose_ui_change") {
      return await proposeUIChange(input);
    }
    if (name === "run_system_command") {
      return await runSystemCommand(input);
    }
    if (dynamicToolRunners[name]) {
      return await dynamicToolRunners[name](input);
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ---------- system command execution (auto-run, by explicit user choice — see README) ----------

const DANGEROUS_PATTERNS = [
  /format\s+[a-z]:/i,
  /diskpart/i,
  /remove-item[^\n]*-recurse[^\n]*(c:\\?\s*$|c:\\windows|c:\\users\s*$)/i,
  /rm\s+-rf\s+(\/|c:)/i,
  /(iwr|invoke-webrequest|curl)[^\n]*\|\s*(iex|invoke-expression|sh|bash)/i,
  /\.env\b/i,
  /anthropic_api_key/i,
  /auth_token/i,
  /shutdown/i,
  /restart-computer/i
];

function isDangerousCommand(command) {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

async function logCommand(command, description, result) {
  const line = `[${new Date().toISOString()}] ${description || "(no description)"}\n  command: ${command}\n  result: ${String(result).slice(0, 500)}\n\n`;
  await fs.mkdir(path.dirname(COMMAND_LOG), { recursive: true });
  await fs.appendFile(COMMAND_LOG, line, "utf8").catch(() => {});
}

async function runSystemCommand({ command, description }) {
  if (!command || typeof command !== "string") return "Rejected: no command provided.";
  if (isDangerousCommand(command)) {
    await logCommand(command, description, "BLOCKED — matched a disabled pattern");
    return "Blocked: this matches a pattern that's disabled regardless of settings (mass deletion, formatting, download-and-execute, reading secrets, shutdown/restart). Not run.";
  }
  try {
    const { stdout, stderr } = await execAsync(command, { shell: "powershell.exe", timeout: 15000, windowsHide: true });
    const result = (stdout || stderr || "(no output)").toString().slice(0, 4000);
    await logCommand(command, description, result);
    return result;
  } catch (err) {
    const result = `Error: ${err.message}`;
    await logCommand(command, description, result);
    return result;
  }
}

// ---------- self-extension: UI file changes (higher risk than tools — see README) ----------

async function proposeUIChange({ file, content, reason }) {
  if (!EDITABLE_UI_FILES.includes(file)) {
    return `Rejected: "${file}" isn't an editable UI file. Must be one of: ${EDITABLE_UI_FILES.join(", ")}.`;
  }
  if (typeof content !== "string" || content.length === 0) {
    return "Rejected: content was empty.";
  }

  if (file === "app.js") {
    try {
      new Function(content); // full-script syntax check, not just a function body
    } catch (err) {
      return `Rejected: app.js doesn't parse (${err.message}). Fix the syntax and propose again.`;
    }
  }

  if (file === "style.css") {
    const opens = (content.match(/{/g) || []).length;
    const closes = (content.match(/}/g) || []).length;
    if (opens !== closes) {
      return `Rejected: style.css braces don't balance (${opens} open vs ${closes} close). Fix and propose again.`;
    }
  }

  if (file === "index.html") {
    const currentAppJs = await fs.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8").catch(() => "");
    const ids = [...currentAppJs.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    const missing = ids.filter((id) => !new RegExp(`id=["']${id}["']`).test(content));
    if (missing.length > 0) {
      return `Rejected: the current app.js expects these element IDs, which are missing from your proposed HTML: ${missing.join(", ")}. If you're removing that functionality on purpose, propose the matching app.js change too.`;
    }
  }

  await fs.mkdir(UI_PENDING_DIR, { recursive: true });
  const record = { file, content, reason, proposedAt: new Date().toISOString() };
  await fs.writeFile(path.join(UI_PENDING_DIR, `${file}.json`), JSON.stringify(record, null, 2), "utf8");
  return `Proposed a change to ${file}, staged for approval in the UI-changes panel. Reason given: "${reason}". It will not take effect until the user approves it.`;
}

async function listPendingUIChanges() {
  await fs.mkdir(UI_PENDING_DIR, { recursive: true });
  const entries = await fs.readdir(UI_PENDING_DIR, { withFileTypes: true });
  const pending = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = JSON.parse(await fs.readFile(path.join(UI_PENDING_DIR, entry.name), "utf8"));
    const current = await fs.readFile(path.join(PUBLIC_DIR, record.file), "utf8").catch(() => "");
    const diff = diffLines(current, record.content);
    pending.push({ file: record.file, reason: record.reason, proposedAt: record.proposedAt, diff });
  }
  return pending;
}

async function backupPublicFolder() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUPS_DIR, stamp, "public");
  await fs.mkdir(dest, { recursive: true });
  const files = await fs.readdir(PUBLIC_DIR);
  for (const f of files) {
    const full = path.join(PUBLIC_DIR, f);
    if ((await fs.stat(full)).isFile()) await fs.copyFile(full, path.join(dest, f));
  }
  // Prune old backups beyond MAX_BACKUPS so this doesn't grow forever.
  const all = (await fs.readdir(BACKUPS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const toDelete = all.slice(0, Math.max(0, all.length - MAX_BACKUPS));
  for (const old of toDelete) {
    await fs.rm(path.join(BACKUPS_DIR, old), { recursive: true, force: true });
  }
  return stamp;
}

function githubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function getGitHubFileSha(repoPath) {
  const branch = process.env.GITHUB_BRANCH || "main";
  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${repoPath}?ref=${branch}`,
    { headers: githubHeaders() }
  );
  if (res.status === 404) return null; // file doesn't exist in the repo yet — that's fine, it's a create
  if (!res.ok) throw new Error(`GitHub API error reading "${repoPath}" (${res.status}): ${await res.text()}`);
  return (await res.json()).sha;
}

async function commitFileToGitHub(repoPath, content, message) {
  const sha = await getGitHubFileSha(repoPath);
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: process.env.GITHUB_BRANCH || "main"
  };
  if (sha) body.sha = sha; // required by GitHub's API when overwriting an existing file
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${repoPath}`, {
    method: "PUT",
    headers: { ...githubHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub commit failed for "${repoPath}" (${res.status}): ${await res.text()}`);
  return res.json();
}

async function approveUIChange(file) {
  const pendingPath = path.join(UI_PENDING_DIR, `${file}.json`);
  const record = JSON.parse(await fs.readFile(pendingPath, "utf8"));

  if (githubConfigured()) {
    await commitFileToGitHub(`public/${file}`, record.content, `Jarvis self-edit: ${record.reason || file}`);
    await fs.rm(pendingPath, { force: true });
    return { mode: "github", detail: `${process.env.GITHUB_REPO}@${process.env.GITHUB_BRANCH || "main"}` };
  }

  const stamp = await backupPublicFolder();
  await fs.writeFile(path.join(PUBLIC_DIR, file), record.content, "utf8");
  await fs.rm(pendingPath, { force: true });
  return { mode: "local", detail: stamp };
}

// ---------- self-extension: propose, validate, and load new tools ----------

let dynamicToolRunners = {};
let dynamicToolDefinitions = [];

function buildToolSource({ name, description, input_schema, code }) {
  return `export const definition = ${JSON.stringify({ name, description, input_schema }, null, 2)};

export async function run(input) {
${code}
}
`;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function proposeTool({ name, description, input_schema, code }) {
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(name || "")) {
    return "Rejected: tool name must be lowercase snake_case, 2-50 chars (e.g. get_weather).";
  }
  try {
    new AsyncFunction("input", code); // throws SyntaxError if the body doesn't parse
  } catch (err) {
    return `Rejected: the code doesn't parse (${err.message}). Fix the syntax and call create_tool again.`;
  }
  await fs.mkdir(PENDING_DIR, { recursive: true });
  const source = buildToolSource({ name, description, input_schema, code });
  await fs.writeFile(path.join(PENDING_DIR, `${name}.js`), source, "utf8");
  return `Proposed tool "${name}" is staged for approval — it will not run until the user approves it in the Jarvis UI (tools panel).`;
}

async function loadDynamicTools() {
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  await fs.mkdir(PENDING_DIR, { recursive: true });
  const entries = await fs.readdir(TOOLS_DIR, { withFileTypes: true });
  const runners = {};
  const definitions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const full = path.join(TOOLS_DIR, entry.name);
    try {
      const mod = await import(`${pathToFileURL(full).href}?v=${Date.now()}`);
      if (mod.definition && typeof mod.run === "function") {
        definitions.push(mod.definition);
        runners[mod.definition.name] = mod.run;
      }
    } catch (err) {
      console.error(`Failed to load tool "${entry.name}": ${err.message}`);
    }
  }
  dynamicToolRunners = runners;
  dynamicToolDefinitions = definitions;
  if (definitions.length > 0) {
    console.log(`Loaded ${definitions.length} self-added tool(s): ${definitions.map((d) => d.name).join(", ")}`);
  }
}

async function listPendingTools() {
  await fs.mkdir(PENDING_DIR, { recursive: true });
  const entries = await fs.readdir(PENDING_DIR, { withFileTypes: true });
  const pending = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.startsWith(".check-")) continue;
    const full = path.join(PENDING_DIR, entry.name);
    const source = await fs.readFile(full, "utf8");
    let meta = { name: entry.name.replace(/\.js$/, ""), description: "" };
    try {
      const mod = await import(`${pathToFileURL(full).href}?v=${Date.now()}`);
      if (mod.definition) meta = mod.definition;
    } catch {
      // leave fallback meta as-is; source is still shown for review
    }
    pending.push({ filename: entry.name, name: meta.name, description: meta.description, input_schema: meta.input_schema, source });
  }
  return pending;
}

// ---------- conversation persistence ----------

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function saveHistory(history) {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf8");
  return trimmed;
}

// ---------- uploaded files registry (metadata only — actual bytes live at Anthropic) ----------

async function loadFiles() {
  try {
    return JSON.parse(await fs.readFile(FILES_REGISTRY, "utf8"));
  } catch {
    return [];
  }
}

async function saveFiles(files) {
  await fs.mkdir(path.dirname(FILES_REGISTRY), { recursive: true });
  await fs.writeFile(FILES_REGISTRY, JSON.stringify(files, null, 2), "utf8");
}

async function uploadToFilesAPI(buffer, filename, mimeType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const res = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": FILES_API_BETA_HEADER
    },
    body: form
  });
  if (!res.ok) throw new Error(`Files API upload failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function deleteFromFilesAPI(fileId) {
  const res = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
    method: "DELETE",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": FILES_API_BETA_HEADER
    }
  });
  if (!res.ok && res.status !== 404) throw new Error(`Files API delete failed (${res.status}): ${await res.text()}`);
}

// ---------- Claude API ----------

async function callClaude(messages, persona) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to your .env file.");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": FILES_API_BETA_HEADER
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: persona,
      tools: [...builtinTools, ...dynamicToolDefinitions],
      messages
    })
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ---------- express app ----------

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!process.env.AUTH_TOKEN || token !== process.env.AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/api/status", requireAuth, (req, res) => {
  res.json({ workspace: WORKSPACE_ROOT, model: MODEL });
});

app.get("/api/files", requireAuth, async (req, res) => {
  res.json(await loadFiles());
});

app.post("/api/files", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file provided" });
  try {
    const uploaded = await uploadToFilesAPI(req.file.buffer, req.file.originalname, req.file.mimetype);
    const entry = {
      file_id: uploaded.id,
      filename: uploaded.filename || req.file.originalname,
      mime_type: uploaded.mime_type || req.file.mimetype,
      size_bytes: uploaded.size_bytes || req.file.size,
      uploaded_at: uploaded.created_at || new Date().toISOString()
    };
    const files = await loadFiles();
    files.push(entry);
    await saveFiles(files);
    res.json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/files/:id", requireAuth, async (req, res) => {
  try {
    await deleteFromFilesAPI(req.params.id);
    const files = (await loadFiles()).filter((f) => f.file_id !== req.params.id);
    await saveFiles(files);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", requireAuth, async (req, res) => {
  const message = (req.body?.message || "").toString();
  const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
  const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : null;
  if (!message.trim() && fileIds.length === 0 && !imageBase64) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const persona = await getPersona();
    let history = await loadHistory();

    let userContent = message;
    if (fileIds.length > 0 || imageBase64) {
      const registry = await loadFiles();
      const blocks = fileIds.map((id) => {
        const entry = registry.find((f) => f.file_id === id);
        const blockType = entry?.mime_type?.startsWith("image/") ? "image" : "document";
        return { type: blockType, source: { type: "file", file_id: id } };
      });
      if (imageBase64) {
        blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } });
      }
      blocks.push({ type: "text", text: message || "Take a look at what's attached." });
      userContent = blocks;
    }
    history.push({ role: "user", content: userContent });

    let finalText = "";
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callClaude(history, persona);
      const blocks = response.content || [];
      history.push({ role: "assistant", content: blocks });

      const toolUses = blocks.filter((b) => b.type === "tool_use");
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");

      if (toolUses.length === 0) {
        finalText = text;
        break;
      }

      const toolResults = [];
      for (const tu of toolUses) {
        const result = await runTool(tu.name, tu.input);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      history.push({ role: "user", content: toolResults });
      finalText = text; // keep any commentary in case max rounds is hit
    }

    history = await saveHistory(history);
    res.json({ reply: finalText || "(Jarvis returned no text — check server logs)" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tools/pending", requireAuth, async (req, res) => {
  res.json(await listPendingTools());
});

app.get("/api/tools/active", requireAuth, async (req, res) => {
  res.json(dynamicToolDefinitions);
});

app.post("/api/tools/pending/:name/approve", requireAuth, async (req, res) => {
  const name = path.basename(req.params.name).replace(/\.js$/, "");
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(name)) return res.status(400).json({ error: "invalid tool name" });
  const pendingPath = path.join(PENDING_DIR, `${name}.js`);
  try {
    if (githubConfigured()) {
      const content = await fs.readFile(pendingPath, "utf8");
      await commitFileToGitHub(`tools/${name}.js`, content, `Jarvis self-extension: new tool "${name}"`);
      await fs.rm(pendingPath, { force: true });
      return res.json({ ok: true, mode: "github", detail: `${process.env.GITHUB_REPO}@${process.env.GITHUB_BRANCH || "main"}` });
    }
    await fs.rename(pendingPath, path.join(TOOLS_DIR, `${name}.js`));
    res.json({ ok: true, mode: "local" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tools/pending/:name/reject", requireAuth, async (req, res) => {
  const name = path.basename(req.params.name).replace(/\.js$/, "");
  try {
    await fs.rm(path.join(PENDING_DIR, `${name}.js`), { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ui-changes/pending", requireAuth, async (req, res) => {
  res.json(await listPendingUIChanges());
});

app.post("/api/ui-changes/pending/:file/approve", requireAuth, async (req, res) => {
  const file = path.basename(req.params.file);
  if (!EDITABLE_UI_FILES.includes(file)) return res.status(400).json({ error: "invalid file" });
  try {
    const result = await approveUIChange(file);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ui-changes/pending/:file/reject", requireAuth, async (req, res) => {
  const file = path.basename(req.params.file);
  try {
    await fs.rm(path.join(UI_PENDING_DIR, `${file}.json`), { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/reset", requireAuth, async (req, res) => {
  await saveHistory([]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
await loadDynamicTools();
app.listen(PORT, () => {
  console.log(`Jarvis is running at http://localhost:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});
