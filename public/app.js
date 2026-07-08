// ---------- ambient particle field ----------

function initParticles() {
  const canvas = document.getElementById("particles");
  const ctx = canvas.getContext("2d");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let particles = [];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  const COUNT = 46;
  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.15,
      a: Math.random() * 0.5 + 0.15
    });
  }

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(79, 216, 232, ${p.a})`;
      ctx.fill();
    }
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  // Draw a static frame even with reduced motion, so the field isn't empty.
  frame();
}
initParticles();

const gate = document.getElementById("gate");
const gateInput = document.getElementById("gate-input");
const gateSubmit = document.getElementById("gate-submit");
const app = document.getElementById("app");
const log = document.getElementById("log");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const resetBtn = document.getElementById("reset-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const filesBtn = document.getElementById("files-btn");
const filesPanel = document.getElementById("files-panel");
const filesClose = document.getElementById("files-close");
const filesList = document.getElementById("files-list");
const fileInput = document.getElementById("file-input");
const attachedRow = document.getElementById("attached-row");
const toolsBtn = document.getElementById("tools-btn");
const toolsPanel = document.getElementById("tools-panel");
const toolsClose = document.getElementById("tools-close");
const toolsList = document.getElementById("tools-list");
const uiChangesBtn = document.getElementById("ui-changes-btn");
const uiChangesPanel = document.getElementById("ui-changes-panel");
const uiChangesClose = document.getElementById("ui-changes-close");
const uiChangesList = document.getElementById("ui-changes-list");
const orbStatus = document.getElementById("orb-status");
const mainRing = document.getElementById("main-ring");
const modeToggle = document.getElementById("mode-toggle");
const voiceIndicator = document.getElementById("voice-indicator");
const voiceStatus = document.getElementById("voice-status");
const workspaceEmpty = document.getElementById("workspace-empty");
const workspaceCards = document.getElementById("workspace-cards");
const topbarClock = document.getElementById("topbar-clock");
const cameraToggle = document.getElementById("camera-toggle");
const cameraFeed = document.getElementById("camera-feed");
const cameraCanvas = document.getElementById("camera-canvas");
const cameraOffMsg = document.getElementById("camera-off-msg");

let token = localStorage.getItem("jarvis_token") || "";
let fileLibrary = [];
let attachedIds = new Set();
let voiceMode = false;

function authHeaders() {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function tryConnect(candidateToken) {
  const res = await fetch("/api/status", { headers: { Authorization: `Bearer ${candidateToken}` } });
  if (!res.ok) throw new Error("unauthorized");
  return res.json();
}

async function boot() {
  if (!token) return showGate();
  try {
    const status = await tryConnect(token);
    onConnected(status);
  } catch {
    showGate();
  }
}

function showGate() {
  gate.classList.remove("hidden");
  app.classList.add("hidden");
  gateInput.focus();
}

function setOrbStatus(text, active = false) {
  orbStatus.textContent = text;
  mainRing.classList.toggle("active", active);
}

function startClock() {
  function tick() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const date = now.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
    topbarClock.textContent = `${time} · ${date}`;
  }
  tick();
  setInterval(tick, 1000);
}
startClock();

function onConnected(status) {
  gate.classList.add("hidden");
  app.classList.remove("hidden");
  statusDot.classList.add("online");
  statusText.textContent = `${status.model} · ${status.workspace}`;
  setOrbStatus("online");
  input.focus();
  refreshFiles();
  refreshPendingTools();
  refreshPendingUIChanges();
}

// Ready for when tools return real content to show — not called anywhere yet.
function addWorkspaceCard({ title, description, imageUrl, url }) {
  workspaceEmpty.classList.add("hidden");
  const card = document.createElement("div");
  card.className = "workspace-card";
  card.innerHTML = `
    ${imageUrl ? `<img src="${imageUrl}" alt="">` : ""}
    ${title ? `<div class="card-title">${title}</div>` : ""}
    ${description ? `<div class="card-desc">${description}</div>` : ""}
    ${url ? `<a href="${url}" target="_blank" rel="noopener">${url}</a>` : ""}
  `;
  workspaceCards.prepend(card);
}

async function refreshPendingTools() {
  const res = await fetch("/api/tools/pending", { headers: authHeaders() });
  const pending = res.ok ? await res.json() : [];
  toolsBtn.textContent = pending.length > 0 ? `tools (${pending.length})` : "tools";
  toolsList.innerHTML = "";
  if (pending.length === 0) {
    toolsList.innerHTML = `<div class="msg-label">nothing pending</div>`;
    return;
  }
  for (const t of pending) {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `
      <div class="tool-name">${t.name}</div>
      <div class="tool-desc">${t.description || ""}</div>
      <pre>${(t.source || "").replace(/</g, "&lt;")}</pre>
      <div class="tool-actions">
        <button class="approve">approve</button>
        <button class="reject">reject</button>
      </div>
    `;
    card.querySelector(".approve").addEventListener("click", async () => {
      const res = await fetch(`/api/tools/pending/${t.name}/approve`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        card.querySelector(".tool-actions").innerHTML = `<span class="msg-label">failed: ${data.error}</span>`;
        return;
      }
      if (data.mode === "github") {
        card.querySelector(".tool-actions").innerHTML = `<span class="msg-label">pushed to ${data.detail} — Render will rebuild shortly.</span>`;
      } else {
        card.querySelector(".tool-actions").innerHTML = `<span class="msg-label">approved — Jarvis is restarting…</span>`;
        setTimeout(() => reconnectAfterRestart(), 2500);
      }
    });
    card.querySelector(".reject").addEventListener("click", async () => {
      await fetch(`/api/tools/pending/${t.name}/reject`, { method: "POST", headers: authHeaders() });
      refreshPendingTools();
    });
    toolsList.appendChild(card);
  }
}

async function reconnectAfterRestart(attempt = 1) {
  try {
    await tryConnect(token);
    refreshPendingTools();
    statusText.textContent += " · tool loaded";
  } catch {
    if (attempt < 6) setTimeout(() => reconnectAfterRestart(attempt + 1), 1500);
  }
}

toolsBtn.addEventListener("click", () => toolsPanel.classList.toggle("hidden"));
toolsClose.addEventListener("click", () => toolsPanel.classList.add("hidden"));

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDiff(parts) {
  return parts.map((part) => {
    const cls = part.added ? "diff-add" : part.removed ? "diff-remove" : "diff-context";
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact
    return lines.map((line) => `<div class="${cls}">${prefix}${escapeHtml(line)}</div>`).join("");
  }).join("");
}

async function refreshPendingUIChanges() {
  const res = await fetch("/api/ui-changes/pending", { headers: authHeaders() });
  const pending = res.ok ? await res.json() : [];
  uiChangesBtn.textContent = pending.length > 0 ? `ui (${pending.length})` : "ui";
  uiChangesList.innerHTML = "";
  if (pending.length === 0) {
    uiChangesList.innerHTML = `<div class="msg-label">nothing pending</div>`;
    return;
  }
  for (const c of pending) {
    const card = document.createElement("div");
    card.className = "ui-change-card";
    card.innerHTML = `
      <div class="file-name">${c.file}</div>
      <div class="change-reason">${c.reason || ""}</div>
      <div class="diff-view">${renderDiff(c.diff)}</div>
      <div class="tool-actions">
        <button class="approve">approve</button>
        <button class="reject">reject</button>
      </div>
    `;
    card.querySelector(".approve").addEventListener("click", async () => {
      const res = await fetch(`/api/ui-changes/pending/${c.file}/approve`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        card.querySelector(".tool-actions").innerHTML = `<span class="msg-label">failed: ${data.error}</span>`;
        return;
      }
      card.querySelector(".tool-actions").innerHTML = data.mode === "github"
        ? `<span class="msg-label">pushed to ${data.detail} — Render will rebuild and redeploy shortly.</span>`
        : `<span class="msg-label">applied locally — backup saved (${data.detail}). Refresh to load it.</span>`;
    });
    card.querySelector(".reject").addEventListener("click", async () => {
      await fetch(`/api/ui-changes/pending/${c.file}/reject`, { method: "POST", headers: authHeaders() });
      refreshPendingUIChanges();
    });
    uiChangesList.appendChild(card);
  }
}

uiChangesBtn.addEventListener("click", () => uiChangesPanel.classList.toggle("hidden"));
uiChangesClose.addEventListener("click", () => uiChangesPanel.classList.add("hidden"));

async function refreshFiles() {
  const res = await fetch("/api/files", { headers: authHeaders() });
  fileLibrary = res.ok ? await res.json() : [];
  renderFiles();
}

function renderFiles() {
  filesList.innerHTML = "";
  if (fileLibrary.length === 0) {
    filesList.innerHTML = `<div class="msg-label">no files uploaded yet</div>`;
  }
  for (const f of fileLibrary) {
    const row = document.createElement("div");
    row.className = "file-row" + (attachedIds.has(f.file_id) ? " selected" : "");
    row.innerHTML = `<span class="name">${f.filename}</span><span class="meta">${Math.round(f.size_bytes / 1024)}KB</span><span class="del">✕</span>`;
    row.querySelector(".name").addEventListener("click", () => toggleAttach(f.file_id));
    row.querySelector(".meta").addEventListener("click", () => toggleAttach(f.file_id));
    row.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${f.filename} from the library?`)) return;
      await fetch(`/api/files/${f.file_id}`, { method: "DELETE", headers: authHeaders() });
      attachedIds.delete(f.file_id);
      refreshFiles();
      renderAttached();
    });
    filesList.appendChild(row);
  }
}

function toggleAttach(fileId) {
  if (attachedIds.has(fileId)) attachedIds.delete(fileId);
  else attachedIds.add(fileId);
  renderFiles();
  renderAttached();
}

function renderAttached() {
  attachedRow.innerHTML = "";
  attachedRow.classList.toggle("hidden", attachedIds.size === 0);
  for (const id of attachedIds) {
    const f = fileLibrary.find((x) => x.file_id === id);
    if (!f) continue;
    const chip = document.createElement("span");
    chip.className = "attached-chip";
    chip.textContent = f.filename;
    attachedRow.appendChild(chip);
  }
}

filesBtn.addEventListener("click", () => filesPanel.classList.toggle("hidden"));
filesClose.addEventListener("click", () => filesPanel.classList.add("hidden"));

fileInput.addEventListener("change", async () => {
  for (const file of fileInput.files) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Upload failed: ${err.error || res.status}`);
    }
  }
  fileInput.value = "";
  refreshFiles();
});

gateSubmit.addEventListener("click", async () => {
  const candidate = gateInput.value.trim();
  if (!candidate) return;
  try {
    const status = await tryConnect(candidate);
    token = candidate;
    localStorage.setItem("jarvis_token", token);
    onConnected(status);
  } catch {
    gateInput.value = "";
    gateInput.placeholder = "wrong token — try again";
  }
});

gateInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") gateSubmit.click();
});

function addMessage(role, text, pending = false) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}${pending ? " pending" : ""}`;
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "you" : "jarvis";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(body);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return body;
}

// ---------- camera / vision mode ----------

let cameraStream = null;

cameraToggle.addEventListener("click", async () => {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    cameraFeed.classList.add("hidden");
    cameraOffMsg.classList.remove("hidden");
    cameraToggle.textContent = "turn on";
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraFeed.srcObject = cameraStream;
    cameraFeed.classList.remove("hidden");
    cameraOffMsg.classList.add("hidden");
    cameraToggle.textContent = "turn off";
  } catch (err) {
    alert(`Couldn't access the camera: ${err.message}`);
  }
});

function captureFrame() {
  if (!cameraStream || !cameraFeed.videoWidth) return null;
  cameraCanvas.width = cameraFeed.videoWidth;
  cameraCanvas.height = cameraFeed.videoHeight;
  cameraCanvas.getContext("2d").drawImage(cameraFeed, 0, 0);
  return cameraCanvas.toDataURL("image/jpeg", 0.8).split(",")[1];
}

async function sendMessage(text, fileIds = []) {
  if (!text.trim() && fileIds.length === 0) return;
  sendBtn.disabled = true;
  setOrbStatus("thinking…", true);
  let pendingBody = null;

  try {
    const imageBase64 = captureFrame();
    const label = fileIds.length ? `${text}${text ? " " : ""}[${fileIds.length} file(s) attached]` : text;
    addMessage("user", label);
    pendingBody = addMessage("assistant", "", true);
    pendingBody.innerHTML = '<span class="jarvis-ring ring-sm"></span>';
    attachedIds.clear();
    renderAttached();
    renderFiles();

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message: text, fileIds, imageBase64 })
    });
    const data = await res.json();
    pendingBody.parentElement.classList.remove("pending");
    pendingBody.textContent = res.ok ? data.reply : `Error: ${data.error}`;
    if (!res.ok) pendingBody.parentElement.style.borderLeftColor = "#C9584B";
    refreshPendingTools();
    refreshPendingUIChanges();
  } catch (err) {
    if (pendingBody) {
      pendingBody.parentElement.classList.remove("pending");
      pendingBody.textContent = `Connection error: ${err.message}`;
      pendingBody.parentElement.style.borderLeftColor = "#C9584B";
    } else {
      addMessage("assistant", `Something broke before sending: ${err.message}`);
    }
  } finally {
    sendBtn.disabled = false;
    if (voiceMode) {
      setOrbStatus("listening for wake word…");
      voiceStatus.textContent = "listening for wake word…";
    } else {
      setOrbStatus("online");
      input.focus();
    }
  }
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const fileIds = Array.from(attachedIds);
  input.value = "";
  input.style.height = "auto";
  sendMessage(text, fileIds);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

resetBtn.addEventListener("click", async () => {
  if (!confirm("Clear Jarvis's memory of this conversation?")) return;
  await fetch("/api/reset", { method: "POST", headers: authHeaders() });
  log.innerHTML = "";
});

// ---------- voice mode (wake-word activated) ----------

const WAKE_PHRASES = ["hey jarvis", "jarvis"];
const micIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke-linecap="round"/></svg>';
const keyboardIcon = modeToggle.innerHTML;

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let isListening = false;
let awaitingWakeWord = true;

function safeStart() {
  if (isListening) return;
  try { recognizer.start(); } catch (err) { console.warn("recognizer start skipped:", err.message); }
}

function safeStop() {
  try { recognizer.stop(); } catch (err) { console.warn("recognizer stop skipped:", err.message); }
  isListening = false;
}

function armWakeWordListening() {
  awaitingWakeWord = true;
  setOrbStatus("listening for wake word…");
  voiceStatus.textContent = "listening for wake word…";
}

function armActiveListening() {
  awaitingWakeWord = false;
  setOrbStatus("listening…", true);
  voiceStatus.textContent = "listening…";
}

if (SpeechRecognitionAPI) {
  recognizer = new SpeechRecognitionAPI();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = "en-US";

  recognizer.onstart = () => { isListening = true; };

  recognizer.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript.trim();

    if (!result.isFinal) {
      if (!awaitingWakeWord) voiceStatus.textContent = transcript || "listening…";
      return;
    }

    if (awaitingWakeWord) {
      const lower = transcript.toLowerCase();
      const hit = WAKE_PHRASES.find((p) => lower.includes(p));
      if (!hit) return; // not the wake word — keep waiting, say nothing
      const after = lower.slice(lower.indexOf(hit) + hit.length).trim();
      if (after) {
        armWakeWordListening(); // command arrived in the same breath — handle then reset
        sendMessage(after);
      } else {
        armActiveListening(); // wake word only — wait for the actual command next
      }
      return;
    }

    // We were actively capturing a command — this transcript IS the command.
    armWakeWordListening();
    sendMessage(transcript);
  };

  recognizer.onerror = (event) => {
    isListening = false;
    voiceStatus.textContent = `mic error: ${event.error}`;
  };

  recognizer.onend = () => {
    isListening = false;
    // Small delay before auto-restart — restarting instantly is what caused the race.
    if (voiceMode) setTimeout(safeStart, 300);
  };
}

modeToggle.addEventListener("click", () => {
  if (!SpeechRecognitionAPI) {
    alert("Voice input isn't supported in this browser — try Chrome or Edge.");
    return;
  }
  voiceMode = !voiceMode;
  modeToggle.classList.toggle("active", voiceMode);
  modeToggle.innerHTML = voiceMode ? micIcon : keyboardIcon;
  modeToggle.title = voiceMode ? "switch to text" : "switch to voice";
  input.classList.toggle("hidden", voiceMode);
  voiceIndicator.classList.toggle("hidden", !voiceMode);

  if (voiceMode) {
    armWakeWordListening();
    safeStart();
  } else {
    setOrbStatus("online");
    safeStop();
    input.focus();
  }
});

boot();
