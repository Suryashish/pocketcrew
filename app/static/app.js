"use strict";

const $ = (id) => document.getElementById(id);

const TEMPLATES = [
  { name: "Coder", emoji: "🧑‍💻", role: "Programming help, debugging and code review",
    instructions: "You are a senior software engineer. Give working code first, then a short explanation. Point out bugs and edge cases plainly. Ask for the language or error message when it is missing. Keep answers tight." },
  { name: "Writer", emoji: "✍️", role: "Drafts and polishes emails, posts and messages",
    instructions: "You are a sharp editor and copywriter. Write in clear, natural language and match the tone the user asks for. When editing, return the improved text first, then at most two notes on what changed. Never pad." },
  { name: "Tutor", emoji: "🎓", role: "Explains concepts step by step and quizzes the user",
    instructions: "You are a patient tutor. Explain one idea at a time using simple words and a concrete example. After explaining, ask one short question to check understanding. Encourage the user and correct mistakes gently." },
  { name: "Coach", emoji: "🏋️", role: "Fitness, habits and daily accountability",
    instructions: "You are an upbeat, practical coach. Give specific, realistic plans and ask about constraints such as time, equipment and injuries. Hold the user accountable for what they said they would do. You are not a doctor; say so for medical questions." },
  { name: "Researcher", emoji: "🔎", role: "Summarises documents and answers questions from them",
    instructions: "You are a careful research assistant. Answer from the reference material you have been given and say clearly when it does not cover the question. Prefer short summaries with the key facts and numbers. Never invent sources." },
];

let agents = [];
let editing = null;      // agent being edited, or null while hiring
let signupMode = true;
let linkPoll = null;

// --- helpers ---------------------------------------------------------------

async function api(method, path, body) {
  const options = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const error = new Error((data && typeof data.detail === "string" && data.detail) || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message || "";
  node.hidden = !message;
}

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2, .7, .2, 1)";
const swaps = new WeakMap();

/** Change a node's text with a short cross-fade instead of an instant swap. */
async function swapText(node, text) {
  if (node.textContent === text && !swaps.has(node)) return;
  const ticket = (swaps.get(node) || 0) + 1;
  swaps.set(node, ticket);
  if (still || !node.animate || !node.textContent) {
    node.textContent = text;
  } else {
    const out = node.animate({ opacity: [1, 0], transform: ["none", "translateY(-5px)"] }, { duration: 170, easing: "ease-in", fill: "forwards" });
    await out.finished.catch(() => {});
    out.cancel();
    if (swaps.get(node) !== ticket) return;  // a newer change took over
    node.textContent = text;
  }
  if (!still && node.animate) node.animate({ opacity: [0, 1], transform: ["translateY(7px)", "none"] }, { duration: 380, easing: EASE });
  if (swaps.get(node) === ticket) swaps.delete(node);
}

/** Run `change` (which alters the dialog's content) and glide the dialog to its new height. */
function morphDialog(change) {
  const dialog = $("agent-dialog");
  const before = dialog.open ? dialog.getBoundingClientRect().height : 0;
  change();
  if (still || !before || !dialog.animate) return;
  const after = dialog.getBoundingClientRect().height;
  if (Math.abs(after - before) < 2) return;
  dialog.style.overflow = "hidden";  // no scrollbar flash while it resizes
  const glide = dialog.animate({ height: [`${before}px`, `${after}px`] }, { duration: 420, easing: EASE });
  glide.finished.catch(() => {}).then(() => { dialog.style.overflow = ""; });
}

const seen = { agents: new Set(), memory: new Set(), docs: new Set() };
/** True the first time an id is drawn, so only new items play their entrance animation. */
function fresh(kind, id) {
  if (seen[kind].has(id)) return false;
  seen[kind].add(id);
  return true;
}

async function busy(button, work) {
  const label = button.textContent;
  button.disabled = true;
  try { return await work(); } finally { button.disabled = false; button.textContent = label; }
}

// --- auth ------------------------------------------------------------------

function setAuthMode(signup) {
  signupMode = signup;
  $("auth-title").textContent = signup ? "Create your account" : "Welcome back";
  $("auth-submit").textContent = signup ? "Sign up" : "Log in";
  $("auth-switch-text").textContent = signup ? "Already have an account?" : "New here?";
  $("auth-switch").textContent = signup ? "Log in" : "Sign up";
  $("auth-password").autocomplete = signup ? "new-password" : "current-password";
  showError("auth-error", "");
}

$("auth-switch").addEventListener("click", (e) => { e.preventDefault(); setAuthMode(!signupMode); });

for (const opener of document.querySelectorAll("[data-auth]")) {
  opener.addEventListener("click", () => {
    setAuthMode(opener.dataset.auth === "signup");
    $("auth-dialog").showModal();
    $("auth-email").focus();
  });
}
for (const closer of document.querySelectorAll("[data-close]")) {
  closer.addEventListener("click", () => closer.closest("dialog").close());
}

$("auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  busy($("auth-submit"), async () => {
    try {
      const user = await api("POST", signupMode ? "/api/auth/signup" : "/api/auth/login", {
        email: $("auth-email").value, password: $("auth-password").value,
      });
      $("auth-password").value = "";
      await enter(user);
    } catch (err) { showError("auth-error", err.message); }
  });
});

$("logout").addEventListener("click", async () => {
  await api("POST", "/api/auth/logout").catch(() => {});
  clearInterval(linkPoll);
  $("app").hidden = true;
  $("auth").hidden = false;
});

async function enter(user) {
  if ($("auth-dialog").open) $("auth-dialog").close();
  $("auth").hidden = true;
  window.scrollTo(0, 0);
  $("app").hidden = false;
  $("user-email").textContent = user.email;
  await Promise.all([loadAgents(), loadTelegram(), loadMemory(), loadStatus()]);
}

// --- status ----------------------------------------------------------------

async function loadStatus() {
  let status;
  try { status = await api("GET", "/api/status"); } catch { return; }
  const pill = $("model-pill");
  const ok = status.llm.reachable && status.llm.model_ready;
  pill.textContent = (ok ? "● " : "○ ") + status.llm.model;
  pill.classList.toggle("bad", !ok);
  let message = "";
  if (status.llm.key_missing) message = "No GEMINI_API_KEY is set on this server, so agents can't answer yet. Add it to .env and restart.";
  else if (!status.llm.reachable) message = "The Gemma model server isn't reachable. Agents can't answer until it is.";
  else if (!status.llm.model_ready) message = `The model ${status.llm.model} isn't available on the model server yet.`;
  $("banner").textContent = message;
  $("banner").hidden = !message;
}

// --- agents ----------------------------------------------------------------

async function loadAgents() {
  agents = await api("GET", "/api/agents");
  const box = $("agents");
  box.replaceChildren();
  if (!agents.length) box.append(el("p", { class: "muted" }, "No agents yet. Hire your first one."));
  for (const [i, agent] of agents.entries()) {
    box.append(el("button", { class: fresh("agents", agent.id) ? "agent new" : "agent", style: `--i:${i}`, onclick: () => openDialog(agent) },
      el("span", { class: "emoji" }, agent.emoji),
      el("span", { class: "name" }, agent.name),
      el("span", { class: "role" }, agent.role || "No role set")));
  }
}

function fillForm(data) {
  $("f-emoji").value = data.emoji || "🤖";
  $("f-name").value = data.name || "";
  $("f-role").value = data.role || "";
  $("f-instructions").value = data.instructions || "";
}

function showTab(name) {
  for (const button of $("tabs").children) button.classList.toggle("active", button.dataset.tab === name);
  morphDialog(() => {
    for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== name;
  });
  if (name === "knowledge") loadDocs();
  if (name === "chat") loadChat();
}

function openDialog(agent) {
  stopVoice();
  editing = agent || null;
  $("dialog-title").textContent = agent ? `${agent.emoji} ${agent.name}` : "Hire an agent";
  $("agent-save").textContent = agent ? "Save" : "Hire";
  $("agent-delete").hidden = !agent;
  $("draft-box").hidden = !!agent;
  $("tabs").hidden = !agent;
  $("draft-input").value = "";
  showError("agent-error", "");
  fillForm(agent || {});
  showTab("profile");
  if (!$("agent-dialog").open) $("agent-dialog").showModal();
}

$("new-agent").addEventListener("click", () => openDialog(null));
$("dialog-close").addEventListener("click", () => $("agent-dialog").close());
$("tabs").addEventListener("click", (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

for (const template of TEMPLATES) {
  $("templates").append(el("button", { type: "button", onclick: () => fillForm(template) }, `${template.emoji} ${template.name}`));
}

async function draft() {
  const description = $("draft-input").value.trim();
  if (description.length < 4) { showError("agent-error", "Describe the agent in a few words first."); return; }
  showError("agent-error", "");
  await busy($("draft-btn"), async () => {
    $("draft-btn").textContent = "Writing…";
    try { fillForm(await api("POST", "/api/agents/draft", { description })); }
    catch (err) { showError("agent-error", err.message); }
  });
}
$("draft-btn").addEventListener("click", draft);
$("draft-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); draft(); } });

$("agent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  busy($("agent-save"), async () => {
    const body = {
      name: $("f-name").value, emoji: $("f-emoji").value || "🤖",
      role: $("f-role").value, instructions: $("f-instructions").value,
    };
    try {
      const saved = editing
        ? await api("PATCH", `/api/agents/${editing.id}`, body)
        : await api("POST", "/api/agents", body);
      const created = !editing;
      await loadAgents();
      if (created) { openDialog(saved); showTab("chat"); } else { $("agent-dialog").close(); }
    } catch (err) { showError("agent-error", err.message); }
  });
});

$("agent-delete").addEventListener("click", async () => {
  if (!editing || !confirm(`Delete ${editing.name}? Its knowledge and test chat are removed too.`)) return;
  try {
    await api("DELETE", `/api/agents/${editing.id}`);
    $("agent-dialog").close();
    await loadAgents();
  } catch (err) { showError("agent-error", err.message); }
});

// --- voice interview ---------------------------------------------------------
// Each question is read aloud, a 4-second countdown runs, then the microphone
// records until 3 seconds of silence. Nothing advances until the user presses
// Next, so they can re-record or edit the transcript first. Gemma only sees the
// finished answers. Typing always works as a fallback.

const VOICE_QUESTIONS = [
  "What should this agent help you with?",
  "How should it talk to you? For example friendly, strict, or straight to the point.",
  "Is there anything it should always do, or never do?",
  "Last one. Do you want to give it a name?",
];
const COUNTDOWN_SECONDS = 4;
const SILENCE_MS = 3000;
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { run: 0, take: 0, step: 0, answers: [], rec: null, typedOnly: !SpeechRec, phase: "idle" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_MIC = "I can't use the microphone here. Type your answer, then press Next.";

function voiceButtons() {
  const busy = ["thinking", "done"].includes(voice.phase);
  const last = voice.step >= VOICE_QUESTIONS.length - 1;
  $("voice-answer").disabled = busy;
  $("voice-next").disabled = busy || (voice.phase !== "failed" && !$("voice-answer").value.trim());
  $("voice-next").textContent = voice.phase === "failed" ? "Try again" : last ? "Build agent" : "Next";
  $("voice-skip").classList.toggle("gone", busy || voice.phase === "failed" || voice.step === 0);
}

function voicePhase(phase, caption) {
  voice.phase = phase;
  $("voice-orb").dataset.state = phase;
  if (phase !== "countdown") swapText($("voice-icon"), { speaking: "🔊", thinking: "✨", done: "✓" }[phase] || "🎙");
  if (caption !== undefined) swapText($("voice-caption"), caption);
  voiceButtons();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (!finished) { finished = true; clearTimeout(guard); resolve(); } };
    // Some browsers never fire `end` (no voices installed, tab in background), so never wait forever.
    const guard = setTimeout(finish, 2500 + text.length * 90);
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.03;
      utterance.onend = finish;
      utterance.onerror = finish;
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    } catch { finish(); }
  });
}

/** Stop speaking, counting down and recording, without triggering any follow-up step. */
function haltCapture() {
  voice.take += 1;
  const rec = voice.rec;
  voice.rec = null;
  if (rec) { rec.onend = null; try { rec.abort(); } catch { /* already stopped */ } }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  $("voice-ring").classList.remove("run");
}

function stopVoice() {
  voice.run += 1;  // cancels any in-flight question or build from the previous run
  haltCapture();
}

async function startCountdown() {
  haltCapture();
  const take = voice.take;
  voicePhase("countdown", "Get ready. Recording starts when the ring completes.");
  const ring = $("voice-ring");
  void ring.getBoundingClientRect();  // restart the ring animation from full
  ring.classList.add("run");
  for (let left = COUNTDOWN_SECONDS; left > 0; left--) {
    swapText($("voice-icon"), String(left));
    await pause(1000);
    if (take !== voice.take) return;
  }
  startListening();
}

function startListening() {
  const take = voice.take;
  const rec = new SpeechRec();
  voice.rec = rec;
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  let finalText = "";
  let quiet = null;
  const settle = () => { clearTimeout(quiet); quiet = setTimeout(() => { try { rec.stop(); } catch { /* ended */ } }, SILENCE_MS); };
  rec.onstart = () => {
    $("voice-answer").value = "";
    voicePhase("listening", "Recording. I'll stop after 3 seconds of silence, or tap the orb.");
    settle();
  };
  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += `${piece} `; else interim += piece;
    }
    $("voice-answer").value = (finalText + interim).trim();
    voiceButtons();
    settle();
  };
  rec.onerror = (event) => {
    if (["not-allowed", "service-not-allowed", "audio-capture", "network"].includes(event.error)) voice.typedOnly = true;
  };
  rec.onend = () => {
    clearTimeout(quiet);
    if (voice.rec !== rec || take !== voice.take) return;
    voice.rec = null;
    const last = voice.step >= VOICE_QUESTIONS.length - 1;
    if ($("voice-answer").value.trim()) {
      voicePhase("review", `Edit it if I misheard, or tap the orb to record again. Press ${last ? "Build agent" : "Next"} when you're happy.`);
    } else if (voice.typedOnly) {
      voicePhase("idle", NO_MIC);
    } else {
      voicePhase("idle", "I didn't hear anything. Tap the orb to try again, or type your answer.");
    }
  };
  try { rec.start(); } catch { voice.typedOnly = true; voice.rec = null; voicePhase("idle", NO_MIC); }
}

async function askQuestion() {
  const run = voice.run;
  [...$("voice-dots").children].forEach((dot, i) => {
    dot.className = i < voice.step ? "done" : i === voice.step ? "now" : "";
  });
  $("voice-answer").value = "";
  swapText($("voice-question"), VOICE_QUESTIONS[voice.step]);
  voicePhase("speaking", "");
  const take = voice.take;
  await speak(VOICE_QUESTIONS[voice.step]);
  if (run !== voice.run || take !== voice.take) return;
  if (voice.typedOnly) {
    voicePhase("idle", SpeechRec ? NO_MIC : "This browser can't listen. Type your answer, then press Next.");
    $("voice-answer").focus();
  } else {
    startCountdown();
  }
}

function commitAnswer(text) {
  haltCapture();
  voice.answers.push({ question: VOICE_QUESTIONS[voice.step], answer: text.slice(0, 1000) });
  if (voice.step + 1 < VOICE_QUESTIONS.length) {
    voice.step += 1;
    askQuestion();
  } else {
    buildFromVoice();
  }
}

async function buildFromVoice() {
  const run = voice.run;
  [...$("voice-dots").children].forEach((dot) => { dot.className = "done"; });
  swapText($("voice-question"), "Building your agent…");
  voicePhase("thinking", "Gemma is writing its name, role and instructions.");
  let saved;
  try {
    saved = await api("POST", "/api/agents/interview", { answers: voice.answers });
  } catch (err) {
    if (run !== voice.run) return;
    swapText($("voice-question"), "That didn't work.");
    voicePhase("failed", err.message);
    return;
  }
  await loadAgents().catch(() => {});
  if (run !== voice.run) return;
  swapText($("voice-question"), `Meet ${saved.emoji} ${saved.name}`);
  voicePhase("done", saved.role);
  await speak(`Meet ${saved.name}. ${saved.role.replace(/[.!?\s]+$/, "")}. It's in your crew now.`);
  if (run !== voice.run) return;
  openDialog(saved);
  showTab("chat");
}

function startVoice() {
  stopVoice();
  voice.step = 0;
  voice.answers = [];
  voice.typedOnly = !SpeechRec;
  $("voice-dots").replaceChildren(...VOICE_QUESTIONS.map(() => el("i")));
  $("voice-question").textContent = "";
  $("voice-caption").textContent = "";
  $("dialog-title").textContent = "Build by voice";
  showTab("voice");
  askQuestion();
}

$("voice-start").addEventListener("click", startVoice);
$("voice-cancel").addEventListener("click", () => openDialog(null));
$("voice-skip").addEventListener("click", () => commitAnswer("skip"));
$("voice-next").addEventListener("click", () => {
  if (voice.phase === "failed") return buildFromVoice();
  const text = $("voice-answer").value.trim();
  if (text) commitAnswer(text);
});
$("voice-orb").addEventListener("click", () => {
  if (["thinking", "done", "failed"].includes(voice.phase)) return;
  if (voice.phase === "listening" && voice.rec) { try { voice.rec.stop(); } catch { /* ended */ } return; }
  if (voice.phase === "countdown") { haltCapture(); voicePhase("idle", "Paused. Tap the orb to record, or type your answer."); return; }
  if (voice.typedOnly) { haltCapture(); voicePhase("idle", NO_MIC); $("voice-answer").focus(); return; }
  startCountdown();  // from speaking, idle or review: (re)record this answer
});
$("voice-answer").addEventListener("input", () => {
  // Typing takes over from the microphone so the transcript never overwrites the user's edits.
  if (["speaking", "countdown", "listening"].includes(voice.phase)) {
    haltCapture();
    voicePhase("review", "Press Next when you're happy, or tap the orb to record instead.");
  }
  voiceButtons();
});
$("agent-dialog").addEventListener("close", stopVoice);

// --- knowledge -------------------------------------------------------------

async function loadDocs() {
  if (!editing) return;
  const docs = await api("GET", `/api/agents/${editing.id}/docs`);
  const list = $("doc-list");
  list.replaceChildren();
  if (!docs.length) list.append(el("li", { class: "muted" }, "Nothing here yet."));
  for (const doc of docs) {
    list.append(el("li", { class: fresh("docs", doc.id) ? "new" : "" },
      el("span", {}, `${doc.title} · ${doc.chars.toLocaleString()} chars`),
      el("button", { title: "Remove", "aria-label": `Remove ${doc.title}`, onclick: async () => {
        await api("DELETE", `/api/docs/${doc.id}`).catch((err) => showError("doc-error", err.message));
        loadDocs();
      } }, "✕")));
  }
}

$("doc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("doc-text").value.trim();
  if (!text) { showError("doc-error", "Paste some text first, or upload a file."); return; }
  try {
    await api("POST", `/api/agents/${editing.id}/docs`, { title: $("doc-title").value, text });
    $("doc-title").value = ""; $("doc-text").value = "";
    showError("doc-error", "");
    loadDocs();
  } catch (err) { showError("doc-error", err.message); }
});

$("doc-file").addEventListener("change", async () => {
  const file = $("doc-file").files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    await api("POST", `/api/agents/${editing.id}/docs/upload`, form);
    showError("doc-error", "");
    loadDocs();
  } catch (err) { showError("doc-error", err.message); }
  $("doc-file").value = "";
});

// --- test chat -------------------------------------------------------------

// Light Markdown for agent replies. Text is escaped first, so only our own tags get through.
function renderReply(node, text) {
  const escaped = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  node.innerHTML = escaped.split("```").map((part, i) => (i % 2
    ? `<pre>${part.replace(/^[\w+#.-]*\n/, "").trim()}</pre>`
    : part
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>")
      .replace(/^(\s*)[*-]\s+/gm, "$1• ")
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+?)\*(?![*\w])/g, "$1<i>$2</i>")
  )).join("");
}

function addMessage(role, content) {
  const node = el("div", { class: `msg ${role}` });
  if (role === "assistant") renderReply(node, content); else node.textContent = content;
  $("chat-log").append(node);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return node;
}

async function loadChat() {
  if (!editing) return;
  $("chat-log").replaceChildren();
  const messages = await api("GET", `/api/agents/${editing.id}/chat`).catch(() => []);
  if (!messages.length) addMessage("note", `Say hi to ${editing.name}. This is a private test chat.`);
  for (const m of messages) addMessage(m.role, m.content);
  $("chat-input").focus();
}

$("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message || input.disabled) return;
  input.value = "";
  input.disabled = true;
  addMessage("user", message);
  const pending = addMessage("assistant thinking", `${editing.name} is thinking…`);
  try {
    renderReply(pending, (await api("POST", `/api/agents/${editing.id}/chat`, { message })).reply);
    pending.className = "msg assistant";
  } catch (err) {
    pending.className = "msg note";
    pending.textContent = `⚠️ ${err.message}`;
  }
  input.disabled = false;
  input.focus();
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
});

$("chat-reset").addEventListener("click", async () => {
  await api("DELETE", `/api/agents/${editing.id}/chat`).catch(() => {});
  loadChat();
});

// --- shared memory ---------------------------------------------------------

async function loadMemory() {
  const items = await api("GET", "/api/memory");
  const list = $("memory-list");
  list.replaceChildren();
  for (const item of items) {
    list.append(el("li", { class: fresh("memory", item.id) ? "new" : "" },
      el("span", {}, item.text),
      el("button", { title: "Forget", "aria-label": "Forget this", onclick: async () => {
        await api("DELETE", `/api/memory/${item.id}`).catch(() => {});
        loadMemory();
      } }, "✕")));
  }
}

$("memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("memory-input").value.trim();
  if (!text) return;
  try { await api("POST", "/api/memory", { text }); $("memory-input").value = ""; } catch (err) { alert(err.message); }
  loadMemory();
});

// --- telegram --------------------------------------------------------------

async function loadTelegram() {
  const state = await api("GET", "/api/telegram");
  renderTelegram(state);
  return state;
}

function renderTelegram(state, pending) {
  const body = $("telegram-body");
  body.replaceChildren();
  if (!state.configured || !state.bot) {
    body.append(el("p", { class: "muted small" }, state.configured
      ? "The Telegram bot token on this server isn't working. Check TELEGRAM_BOT_TOKEN."
      : "Telegram isn't set up on this server yet. The admin needs to add TELEGRAM_BOT_TOKEN to .env."));
    return;
  }
  const stack = el("div", { class: "stack" });
  if (state.links.length) {
    stack.append(el("p", { class: "small" }, "✅ Connected. Open the chat and just start typing."));
    const list = el("ul", { class: "list" });
    for (const link of state.links) {
      list.append(el("li", {},
        el("span", {}, link.display || "Telegram chat"),
        el("button", { title: "Disconnect", "aria-label": "Disconnect this chat", onclick: async () => {
          if (!confirm("Disconnect this Telegram chat?")) return;
          await api("DELETE", `/api/telegram/links/${link.id}`).catch(() => {});
          loadTelegram();
        } }, "✕")));
    }
    stack.append(list, el("a", { class: "btn dark full", href: `https://t.me/${state.bot}`, target: "_blank", rel: "noopener" }, `Open @${state.bot}`));
  } else if (!pending) {
    stack.append(el("p", { class: "muted small" }, "Talk to your whole crew from one Telegram chat. One tap, no setup."));
  }
  if (pending) {
    const qr = el("div", { class: "qr" });
    qr.innerHTML = pending.qr;  // SVG generated by our own server
    stack.append(
      el("a", { class: "btn accent full", href: pending.url, target: "_blank", rel: "noopener" }, "Open Telegram and press Start"),
      el("p", { class: "muted small" }, "On a computer? Scan this with your phone:"),
      qr,
      el("p", { class: "muted small waiting" }, el("span", { class: "spinner" }), `Waiting for you to press Start. The link is valid for ${pending.minutes} minutes.`));
  } else {
    stack.append(el("button", { class: state.links.length ? "btn ghost full" : "btn accent full", onclick: startLink },
      state.links.length ? "Connect another chat" : "Connect Telegram"));
  }
  body.append(stack);
}

async function startLink(e) {
  const button = e.currentTarget;
  button.disabled = true;
  let pending, before;
  try {
    before = (await api("GET", "/api/telegram")).links.length;
    pending = await api("POST", "/api/telegram/link");
  } catch (err) {
    button.disabled = false;
    alert(err.message);
    return;
  }
  const state = await api("GET", "/api/telegram");
  renderTelegram(state, pending);
  clearInterval(linkPoll);
  const started = Date.now();
  linkPoll = setInterval(async () => {
    const now = await api("GET", "/api/telegram").catch(() => null);
    if (!now) return;
    if (now.links.length > before || Date.now() - started > pending.minutes * 60000) {
      clearInterval(linkPoll);
      renderTelegram(now);
    }
  }, 2500);
}

// --- boot ------------------------------------------------------------------

(async () => {
  let user = null;
  try {
    user = await api("GET", "/api/me");
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
  $("loading").hidden = true;
  if (user) { await enter(user).catch(console.error); } else { $("auth").hidden = false; }
  setInterval(() => { if (!$("app").hidden) loadStatus(); }, 30000);
})();
