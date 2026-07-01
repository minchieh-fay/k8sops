const state = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  stream: null,
  kubeconfigValid: false,
  view: "setup"
};

const sessionListEl = document.querySelector("#session-list");
const setupViewEl = document.querySelector("#setup-view");
const chatViewEl = document.querySelector("#chat-view");
const setupNextBtnEl = document.querySelector("#setup-next-btn");
const setupNoteEl = document.querySelector("#setup-note");
const sessionTitleEl = document.querySelector("#session-title");
const sessionMetaEl = document.querySelector("#session-meta");
const sessionStatusEl = document.querySelector("#session-status");
const turnListEl = document.querySelector("#turn-list");
const eventListEl = document.querySelector("#event-list");
const kubeconfigInputEl = document.querySelector("#kubeconfig-input");
const kubeconfigHintEl = document.querySelector("#kubeconfig-hint");
const promptInputEl = document.querySelector("#prompt-input");
const imageInputEl = document.querySelector("#image-input");
const imagePreviewEl = document.querySelector("#image-preview");
const submitBtnEl = document.querySelector("#submit-btn");
const submitNoteEl = document.querySelector("#submit-note");
const newSessionBtnEl = document.querySelector("#new-session-btn");

newSessionBtnEl.addEventListener("click", openSetupView);
setupNextBtnEl.addEventListener("click", createSessionFromKubeconfig);
submitBtnEl.addEventListener("click", submitPrompt);
imageInputEl.addEventListener("change", renderSelectedImages);
kubeconfigInputEl.addEventListener("blur", validateKubeconfigText);

void bootstrap();

async function bootstrap() {
  await loadSessions();
  openSetupView();
}

async function loadSessions() {
  const response = await fetch("/api/sessions");
  const payload = await response.json();
  state.sessions = payload.items ?? [];
  renderSessionList();
}

function openSetupView() {
  state.view = "setup";
  state.kubeconfigValid = false;
  state.currentSessionId = null;
  state.currentSession = null;
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  kubeconfigInputEl.value = "";
  kubeconfigHintEl.textContent = "等待校验";
  delete kubeconfigHintEl.dataset.valid;
  setupNoteEl.textContent = "";
  renderView();
}

async function createSessionFromKubeconfig() {
  const kubeconfig = kubeconfigInputEl.value.trim();
  if (!validateKubeconfigText()) {
    setupNoteEl.textContent = "kubeconfig 前端校验未通过。";
    return;
  }

  setupNextBtnEl.disabled = true;
  setupNoteEl.textContent = "校验通过，正在创建会话...";
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ kubeconfig })
  });
  const payload = await response.json();
  setupNextBtnEl.disabled = false;

  if (!response.ok) {
    setupNoteEl.textContent = payload.message || "创建会话失败";
    return;
  }

  setupNoteEl.textContent = "";
  await loadSessions();
  await loadSession(payload.item.id);
  promptInputEl.focus();
}

async function loadSession(sessionId) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const payload = await response.json();
  state.currentSessionId = sessionId;
  state.currentSession = payload.item;
  state.view = "chat";
  renderCurrentSession();
  renderSessionList();
  renderView();
  openStream(sessionId);
}

function openStream(sessionId) {
  if (state.stream) {
    state.stream.close();
  }

  const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);
  stream.onmessage = async () => {
    await refreshCurrentSession();
  };
  state.stream = stream;
}

async function refreshCurrentSession() {
  if (!state.currentSessionId) {
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}`);
  const payload = await response.json();
  state.currentSession = payload.item;
  renderCurrentSession();
  await loadSessions();
}

function renderSessionList() {
  if (state.sessions.length === 0) {
    sessionListEl.innerHTML = `<div class="empty-box">还没有会话</div>`;
    return;
  }

  sessionListEl.innerHTML = state.sessions
    .map((session) => {
      const active = session.id === state.currentSessionId ? "active" : "";
      return `
        <button class="session-item ${active}" data-id="${escapeHtml(session.id)}">
          <span class="session-item-id">${escapeHtml(session.id)}</span>
          <strong>${escapeHtml(session.title)}</strong>
          <small>${escapeHtml(session.preview || "")}</small>
          <em>${escapeHtml(session.status)}</em>
        </button>
      `;
    })
    .join("");

  for (const button of sessionListEl.querySelectorAll(".session-item")) {
    button.addEventListener("click", () => loadSession(button.dataset.id));
  }
}

function renderCurrentSession() {
  const session = state.currentSession;
  if (!session) {
    return;
  }

  const meta = session.meta;
  sessionTitleEl.textContent = meta.title;
  sessionMetaEl.textContent = `会话 ID: ${meta.id} · 创建时间: ${formatTime(meta.createdAt)} · 轮次: ${meta.turnCount}`;
  sessionStatusEl.textContent = meta.status;
  sessionStatusEl.dataset.status = meta.status;
  submitBtnEl.disabled = meta.status === "running" || !meta.hasKubeconfig;
  submitNoteEl.textContent =
    meta.status === "running"
      ? "智能助手正在执行，当前会话暂时不能重复提交。"
      : meta.hasKubeconfig
        ? "当前会话已绑定 kubeconfig，可直接继续追问。"
        : "当前会话缺少 kubeconfig。";

  turnListEl.innerHTML =
    session.turns.length === 0
      ? `<div class="empty-box">还没有提交记录</div>`
      : session.turns
          .map(
            (turn) => `
            <article class="turn-card">
              <header>
                <strong>第 ${turn.id} 轮</strong>
                <span class="turn-status ${escapeHtml(turn.status)}">${escapeHtml(turn.status)}</span>
              </header>
              <div class="turn-block">
                <label>User</label>
                <pre>${escapeHtml(turn.prompt)}</pre>
              </div>
              ${renderImageUrls(turn.imageUrls || [])}
              <div class="turn-block">
                <label>Assistant</label>
                <pre>${escapeHtml(renderTurnSummary(turn))}</pre>
                ${renderTurnMeta(turn)}
              </div>
            </article>
          `
          )
          .join("");

  const terminalLines = buildTerminalLines(session.events);
  eventListEl.innerHTML =
    terminalLines.length === 0
      ? `<div class="empty-box">暂无事件</div>`
      : `<div class="terminal-panel"><pre>${escapeHtml(terminalLines.join("\n"))}</pre></div>`;

  const terminalPanel = eventListEl.querySelector(".terminal-panel");
  if (terminalPanel) {
    terminalPanel.scrollTop = terminalPanel.scrollHeight;
  }
}

function renderSelectedImages() {
  const files = [...imageInputEl.files];
  imagePreviewEl.innerHTML = files.length
    ? files.map((file) => `<span class="file-pill">${escapeHtml(file.name)}</span>`).join("")
    : "";
}

function validateKubeconfigText() {
  const value = kubeconfigInputEl.value.trim();
  if (!value) {
    state.kubeconfigValid = false;
    kubeconfigHintEl.textContent = "请输入 kubeconfig。";
    kubeconfigHintEl.dataset.valid = String(state.kubeconfigValid);
    return state.kubeconfigValid;
  }

  const lines = value.split(/\r?\n/);
  const hasColonLines = lines.filter((line) => line.includes(":")).length >= 4;
  const hasApiVersion = /(^|\n)\s*apiVersion:\s*v1\s*($|\n)/m.test(value);
  const hasKind = /(^|\n)\s*kind:\s*Config\s*($|\n)/m.test(value);
  const hasClusters = /(^|\n)\s*clusters:\s*/m.test(value);
  const hasContexts = /(^|\n)\s*contexts:\s*/m.test(value);
  const hasUsers = /(^|\n)\s*users:\s*/m.test(value);
  const hasCurrentContext = /(^|\n)\s*current-context:\s*.+/m.test(value);
  const hasTabs = /\t/.test(value);

  state.kubeconfigValid =
    hasColonLines &&
    hasApiVersion &&
    hasKind &&
    hasClusters &&
    hasContexts &&
    hasUsers &&
    hasCurrentContext &&
    !hasTabs;

  kubeconfigHintEl.textContent = state.kubeconfigValid
    ? "前端校验通过，提交时后端还会再做一次严格校验。"
    : "需要至少包含 apiVersion: v1、kind: Config、clusters、contexts、users、current-context，且不要使用 Tab 缩进。";
  kubeconfigHintEl.dataset.valid = String(state.kubeconfigValid);
  return state.kubeconfigValid;
}

async function submitPrompt() {
  if (!state.currentSessionId) {
    return;
  }

  const prompt = promptInputEl.value.trim();
  if (!prompt) {
    submitNoteEl.textContent = "问题描述不能为空。";
    return;
  }

  if (!state.currentSession.meta.hasKubeconfig) {
    submitNoteEl.textContent = "当前会话缺少 kubeconfig。";
    return;
  }

  submitBtnEl.disabled = true;
  submitNoteEl.textContent = "正在提交...";

  const formData = new FormData();
  formData.set("prompt", prompt);
  for (const file of imageInputEl.files) {
    formData.append("images", file);
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/messages`, {
    method: "POST",
    body: formData
  });

  const payload = await response.json();
  if (!response.ok) {
    submitBtnEl.disabled = false;
    submitNoteEl.textContent = payload.message || "提交失败";
    return;
  }

  promptInputEl.value = "";
  imageInputEl.value = "";
  imagePreviewEl.innerHTML = "";
  submitNoteEl.textContent = `已提交第 ${payload.turnId} 轮，等待智能助手返回。`;
  await refreshCurrentSession();
}

function renderView() {
  setupViewEl.hidden = state.view !== "setup";
  chatViewEl.hidden = state.view !== "chat";
}

function renderImageUrls(imageUrls) {
  if (!imageUrls.length) {
    return "";
  }

  return `
    <div class="turn-images">
      ${imageUrls
        .map((url) => `<a href="${encodeURI(url)}" target="_blank" rel="noreferrer"><img src="${encodeURI(url)}" alt="upload" /></a>`)
        .join("")}
    </div>
  `;
}

function renderTurnSummary(turn) {
  if (turn.response) {
    return turn.response;
  }

  if (turn.partialResponse && turn.status === "failed") {
    return `${turn.partialResponse}\n\n[流中断]\n${turn.error || ""}`.trim();
  }

  if (turn.partialResponse) {
    return turn.partialResponse;
  }

  if (turn.error) {
    return turn.error;
  }

  return "等待返回...";
}

function renderTurnMeta(turn) {
  const notes = [];

  if (turn.status === "failed" && turn.response) {
    notes.push("这轮已经拿到可读回答，但流式收尾失败。");
  }

  if (turn.usage) {
    notes.push(`tokens: in ${turn.usage.inputTokens}, out ${turn.usage.outputTokens}, reasoning ${turn.usage.reasoningOutputTokens}`);
  }

  if (notes.length === 0) {
    return "";
  }

  return `<p class="turn-note">${escapeHtml(notes.join(" "))}</p>`;
}

function buildTerminalLines(events) {
  const lines = [];

  for (const record of events) {
    const time = formatTime(record.timestamp);
    const event = record.event;

    if (!event || typeof event !== "object") {
      lines.push(`[${time}] ${String(event)}`);
      continue;
    }

    if (event.type === "thread.started") {
      lines.push(`[${time}] thread started: ${event.thread_id}`);
      continue;
    }

    if (event.type === "turn.started") {
      lines.push(`[${time}] turn ${record.turnId} started`);
      continue;
    }

    if (event.type === "turn.completed") {
      lines.push(
        `[${time}] turn ${record.turnId} completed | input=${event.usage.input_tokens} output=${event.usage.output_tokens} reasoning=${event.usage.reasoning_output_tokens}`
      );
      continue;
    }

    if (event.type === "turn.failed") {
      lines.push(`[${time}] turn ${record.turnId} failed | ${event.error.message}`);
      continue;
    }

    if (event.type === "error") {
      lines.push(`[${time}] error | ${event.message}`);
      continue;
    }

    if (event.type === "item.completed" || event.type === "item.updated" || event.type === "item.started") {
      const item = event.item;

      if (item.type === "reasoning") {
        lines.push(`[${time}] reasoning | ${item.text}`);
        continue;
      }

      if (item.type === "agent_message") {
        lines.push(`[${time}] assistant`);
        lines.push(indentMultiline(item.text));
        continue;
      }

      if (item.type === "command_execution") {
        lines.push(`[${time}] command | ${item.command}`);
        if (item.aggregated_output) {
          lines.push(indentMultiline(item.aggregated_output));
        }
        if (item.exit_code !== undefined) {
          lines.push(`  exit=${item.exit_code} status=${item.status}`);
        }
        continue;
      }

      if (item.type === "web_search") {
        lines.push(`[${time}] web search | ${item.query}`);
        continue;
      }

      if (item.type === "todo_list") {
        lines.push(
          `[${time}] todo | ${item.items
            .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
            .join(" | ")}`
        );
        continue;
      }

      if (item.type === "error") {
        lines.push(`[${time}] item error | ${item.message}`);
        continue;
      }

      if (item.type === "file_change") {
        lines.push(
          `[${time}] file change | ${item.status} ${item.changes
            .map((change) => `${change.kind}:${change.path}`)
            .join(", ")}`
        );
        continue;
      }

      if (item.type === "mcp_tool_call") {
        lines.push(`[${time}] mcp | ${item.server}/${item.tool} ${item.status}`);
        continue;
      }
    }

    lines.push(`[${time}] ${JSON.stringify(event)}`);
  }

  return lines.slice(-400);
}

function indentMultiline(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
