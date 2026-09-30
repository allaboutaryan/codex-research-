import './style.css';
import './chats.css';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '');
const REPO = 'https://github.com/allaboutaryan/codex-research-';
const keyName = 'northstar-lab-demo-workspace';
let workspaceKey = localStorage.getItem(keyName);
if (!workspaceKey || !/^[a-f0-9]{64}$/.test(workspaceKey)) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  workspaceKey = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(keyName, workspaceKey);
}

const roles = [
  { label: 'CTO', short: 'CTO', detail: 'Reports decisions to the owner', skill: 'cto-orchestrator' },
  { label: 'Project manager', short: 'PM', detail: 'Defines scope and closes the run', skill: 'project-manager' },
  { label: 'Team lead', short: 'TL', detail: 'Assigns and resolves handoffs', skill: 'research-team-lead' },
  { label: 'Research worker', short: 'RW', detail: 'Produces the work packet', skill: 'research-worker' },
  { label: 'Quality reviewer', short: 'QA', detail: 'Checks and requests revisions', skill: 'quality-reviewer' },
];

let data = { tasks: [], events: [], messages: [], modelCalls: 0, inputTokens: 0, outputTokens: 0, database: 'memory' };
let selectedTask = null;
let chatTask = 'all';
let chatAgent = 'all';
let resetChatScroll = true;
let busy = false;
let error = '';
let connection = 'connecting';
let lastRenderedSignature = '';

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const currentView = () => location.hash === '#chats' ? 'chats' : 'overview';
const skillURL = (role) => {
  const skill = roles.find((item) => item.label === role)?.skill;
  return skill ? `${REPO}/blob/main/agents/skills/${skill}/SKILL.md` : null;
};

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-workspace-key': workspaceKey, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function activeRole(step) {
  if (step === 0 || step === 6) return 'Project manager';
  if (step === 1) return 'Team lead';
  if (step === 2 || step === 4) return 'Research worker';
  if (step === 3 || step === 5) return 'Quality reviewer';
  return 'CTO';
}

function renderTaskRows() {
  return data.tasks.length ? data.tasks.map((task) => `<div class="task-row ${task.id === selectedTask ? 'selected' : ''}" data-task="${escapeHTML(task.id)}">
    <button class="task-select" type="button" data-select="${escapeHTML(task.id)}"><span class="task-title">${escapeHTML(task.title)}</span><span class="task-meta">${escapeHTML(task.brief || 'Workflow demo')} · ${formatTime(task.created_at)}</span></button>
    <div class="task-end"><span class="pill ${escapeHTML(task.status)}">${task.status === 'complete' ? 'Complete' : task.status === 'running' ? 'Running' : 'Queued'}</span>${task.status === 'queued' ? `<button class="run-btn" type="button" data-run="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''}>Run demo</button>` : ''}</div>
  </div>`).join('') : '<div class="empty">Add a task to see its handoffs here.</div>';
}

function renderOverview() {
  const running = data.tasks.filter((task) => task.status === 'running');
  const complete = data.tasks.filter((task) => task.status === 'complete');
  const queued = data.tasks.filter((task) => task.status === 'queued');
  const active = running[0];
  if (!selectedTask || !data.tasks.some((task) => task.id === selectedTask)) selectedTask = active?.id || data.tasks[0]?.id || null;
  const focusEvents = data.events.filter((event) => !selectedTask || event.task_id === selectedTask);
  const currentRole = active ? activeRole(active.step) : '';

  return `
    <section class="intro">
      <div><div class="eyebrow">RESEARCH COMPANY / CONTROL ROOM</div><h1>Agent operations</h1><p>Watch work move from assignment to independent review.</p></div>
      <span class="demo-tag">DEMO MODE · NO RESEARCH RUNS</span>
    </section>
    <section class="metrics" aria-label="Workspace metrics">
      <div class="metric"><span>Total tasks</span><strong>${data.tasks.length}</strong><small>${queued.length} waiting in queue</small></div>
      <div class="metric"><span>Active runs</span><strong>${running.length}</strong><small>${running.length ? 'Workflow in progress' : 'No work in progress'}</small></div>
      <div class="metric"><span>Completed</span><strong>${complete.length}</strong><small>Demo walkthroughs</small></div>
      <div class="metric accent"><span>AI tokens used</span><strong>${data.inputTokens + data.outputTokens}</strong><small>${data.modelCalls} model calls</small></div>
    </section>
    <section class="flow-section">
      <div class="section-heading"><div><div class="eyebrow">THE OPERATING LOOP</div><h2>Team workflow</h2></div><div class="section-note">${active ? `Active: ${escapeHTML(active.title)}` : 'Waiting for a task'}</div></div>
      <div class="flow" aria-label="Agent workflow">
        ${roles.map((role, index) => `<div class="flow-card ${currentRole === role.label ? 'is-active' : ''}">
          <div class="flow-top"><span class="step">0${index + 1}</span><span class="role-icon">${role.short}</span></div>
          <h3>${role.label}</h3><p>${role.detail}</p>
          <div class="role-status"><span></span>${currentRole === role.label ? 'Working now' : 'Ready'}</div>
        </div>`).join('')}
      </div>
      <div class="flow-foot"><span>↳</span> Review feedback returns work to the researcher before the manager closes the run. <a href="#chats">Watch agent chats →</a></div>
    </section>
    <div class="lower-grid">
      <section id="tasks" class="panel tasks-panel">
        <div class="panel-head"><div><div class="eyebrow">ASSIGNMENTS</div><h2>Task queue</h2></div><span class="panel-counter">${data.tasks.length} tasks</span></div>
        <form id="task-form" class="task-form">
          <label for="title">New demo task</label>
          <div class="form-row"><input id="title" name="title" maxlength="120" required minlength="3" placeholder="e.g. Explore developer workflow gaps" /><button type="submit" ${busy ? 'disabled' : ''}>Add task</button></div>
          <input id="brief" name="brief" maxlength="1000" placeholder="Optional context for a future research run" />
        </form>
        <div class="task-list">${renderTaskRows()}</div>
      </section>
      <section id="activity" class="panel activity-panel">
        <div class="panel-head"><div><div class="eyebrow">EVENT LOG</div><h2>Live activity</h2></div><span class="live-label"><i></i>Updates every 1.5s</span></div>
        <div class="activity-list" aria-live="polite">
          ${focusEvents.length ? focusEvents.slice(0, 12).map((event) => `<div class="event"><div class="event-pin"></div><div class="event-body"><div><strong>${escapeHTML(event.role)}</strong><time>${formatTime(event.created_at)}</time></div><p>${escapeHTML(event.message)}</p></div></div>`).join('') : '<div class="empty">Events will appear as the workflow runs.</div>'}
        </div>
      </section>
    </div>`;
}

function renderRefs(refs, label) {
  if (!Array.isArray(refs)) return '';
  const links = refs.filter((ref) => {
    try { return new URL(ref).protocol === 'https:'; } catch { return false; }
  });
  return links.map((ref, index) => `<a href="${escapeHTML(ref)}" target="_blank" rel="noopener noreferrer">${label} ${index + 1} ↗</a>`).join('');
}

function renderMessage(message) {
  const task = data.tasks.find((item) => item.id === message.task_id);
  const role = roles.find((item) => item.label === message.agent_id);
  const url = skillURL(message.agent_id);
  const speaker = url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHTML(message.agent_id)} ↗</a>` : `<strong>${escapeHTML(message.agent_id)}</strong>`;
  const refs = renderRefs(message.artifact_refs, 'Artifact') + renderRefs(message.evidence_refs, 'Evidence');
  return `<article class="chat-message">
    <div class="chat-avatar">${escapeHTML(role?.short || message.agent_id.slice(0, 2).toUpperCase())}</div>
    <div class="chat-message-body">
      <div class="chat-message-head"><div>${speaker}<span class="chat-to">→ ${escapeHTML(message.recipient_id)}</span></div><time>${formatDateTime(message.created_at)}</time></div>
      <div class="chat-message-meta"><span class="message-kind">${escapeHTML(message.kind)}</span><span>${escapeHTML(task?.title || 'Unknown task')}</span>${message.demo ? '<span class="demo-inline">Scripted demo</span>' : ''}</div>
      <p>${escapeHTML(message.summary)}</p>
      ${refs ? `<div class="chat-refs">${refs}</div>` : ''}
    </div>
  </article>`;
}

function renderChats() {
  if (chatTask !== 'all' && !data.tasks.some((task) => task.id === chatTask)) chatTask = 'all';
  const messages = data.messages.filter((message) => (chatTask === 'all' || message.task_id === chatTask) && (chatAgent === 'all' || message.agent_id === chatAgent)).slice().reverse();
  const selected = data.tasks.find((task) => task.id === chatTask);
  return `
    <section class="intro">
      <div><div class="eyebrow">SHARED WORKROOM / AUDITABLE HANDOFFS</div><h1>Agent chats</h1><p>See what each role passed to the next, across every task.</p></div>
      <span class="demo-tag">SCRIPTED DEMO · 0 MODEL CALLS</span>
    </section>
    <div class="chat-explainer">These messages are generated by the demo workflow, not by live AI agents. They show concise work decisions and handoffs—not private model reasoning. <a href="${REPO}/blob/main/agents/PROTOCOL.md" target="_blank" rel="noopener noreferrer">How agent messages will work ↗</a></div>
    <div class="chat-layout">
      <section class="panel chat-tasks" aria-label="Conversation tasks">
        <div class="panel-head"><div><div class="eyebrow">CONVERSATIONS</div><h2>Task threads</h2></div><span class="panel-counter">${data.messages.length} messages</span></div>
        <div class="chat-task-list">
          <button class="chat-task ${chatTask === 'all' ? 'selected' : ''}" data-chat-task="all" type="button"><span>All agent chats</span><small>${data.messages.length} messages</small></button>
          ${data.tasks.map((task) => `<button class="chat-task ${chatTask === task.id ? 'selected' : ''}" data-chat-task="${escapeHTML(task.id)}" type="button"><span>${escapeHTML(task.title)}</span><small>${data.messages.filter((message) => message.task_id === task.id).length} messages · ${escapeHTML(task.status)}</small></button>`).join('')}
        </div>
        <div class="chat-skills"><div class="eyebrow">AGENT SKILLS ON GITHUB</div>${roles.map((role) => `<a href="${skillURL(role.label)}" target="_blank" rel="noopener noreferrer">${escapeHTML(role.label)} <span>↗</span></a>`).join('')}</div>
      </section>
      <section class="panel chat-thread" aria-label="Agent conversation">
        <div class="panel-head"><div><div class="eyebrow">VISIBLE TEAM HANDOFFS</div><h2>${escapeHTML(selected?.title || 'All conversations')}</h2></div><span class="live-label"><i></i>Updates every 1.5s</span></div>
        <div class="chat-controls"><label for="chat-agent-filter">Filter by sender</label><select id="chat-agent-filter"><option value="all" ${chatAgent === 'all' ? 'selected' : ''}>All agents</option>${roles.map((role) => `<option value="${escapeHTML(role.label)}" ${chatAgent === role.label ? 'selected' : ''}>${escapeHTML(role.label)}</option>`).join('')}</select></div>
        <div class="chat-feed" role="log" aria-label="Agent messages" aria-live="polite">
          ${messages.length ? messages.map(renderMessage).join('') : `<div class="empty chat-empty">${data.tasks.length ? 'No messages for this filter yet. Start a queued demo task to watch handoffs.' : 'No conversations yet. Add a demo task in the task queue to begin.'}<br/><a href="#tasks">Go to task queue →</a></div>`}
        </div>
        <div class="chat-thread-foot"><span>${messages.length} shown</span><span>${data.database === 'postgres' ? 'Saved in PostgreSQL' : 'Temporary in-memory data'}</span></div>
      </section>
    </div>`;
}

function signature() {
  return JSON.stringify([data.tasks, data.events, data.messages, data.database, data.modelCalls, data.inputTokens, data.outputTokens, connection, error, selectedTask, chatTask, chatAgent, currentView(), busy]);
}

function render() {
  const oldTitle = document.querySelector('#title');
  const oldBrief = document.querySelector('#brief');
  const draft = oldTitle ? {
    title: oldTitle.value,
    brief: oldBrief.value,
    focused: document.activeElement?.id,
    start: document.activeElement?.selectionStart,
    end: document.activeElement?.selectionEnd,
  } : null;
  const oldFeed = document.querySelector('.chat-feed');
  const oldScroll = oldFeed?.scrollTop || 0;
  const wasAtBottom = !oldFeed || oldFeed.scrollHeight - oldFeed.scrollTop - oldFeed.clientHeight < 48;
  const view = currentView();
  document.querySelector('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">✳</div><div><strong>Northstar</strong><small>LAB / OPERATIONS</small></div></div>
        <nav aria-label="Workspace navigation">
          <a class="nav-item ${view === 'overview' && !['#tasks', '#activity'].includes(location.hash) ? 'active' : ''}" href="#overview"><span class="nav-glyph">◫</span> Overview</a>
          <a class="nav-item ${location.hash === '#tasks' ? 'active' : ''}" href="#tasks"><span class="nav-glyph">▤</span> Task queue <span class="nav-count">${data.tasks.length}</span></a>
          <a class="nav-item ${location.hash === '#activity' ? 'active' : ''}" href="#activity"><span class="nav-glyph">◷</span> Activity</a>
          <a class="nav-item ${view === 'chats' ? 'active' : ''}" href="#chats"><span class="nav-glyph">◉</span> Agent chats <span class="nav-count">${data.messages.length}</span></a>
        </nav>
        <div class="side-bottom">
          <div class="side-label">CURRENT MODE</div>
          <div class="mode-card"><span class="mode-orb"></span><div><strong>Workflow demo</strong><small>Zero AI requests</small></div></div>
          <p>Sample tasks show scripted handoffs. Real research agents are not connected.</p>
          <a class="repo-link" href="${REPO}" target="_blank" rel="noopener noreferrer">View GitHub repository ↗</a>
        </div>
      </aside>
      <main id="${view}" class="main">
        <header class="topbar">
          <div class="crumb">Workspace <span>/</span> ${view === 'chats' ? 'Agent chats' : 'Operations'}</div>
          <div class="top-actions"><span class="status ${connection === 'connected' ? 'online' : 'offline'}"><i></i>${connection === 'connected' ? 'Live backend' : 'Connecting'}</span><span class="avatar">CTO</span></div>
        </header>
        <div class="content">
          ${error ? `<div class="alert" role="alert">${escapeHTML(error)} <span>Backend: ${escapeHTML(API)}</span></div>` : ''}
          ${view === 'chats' ? renderChats() : renderOverview()}
          <footer>Northstar Lab · Workflow preview · ${data.database === 'postgres' ? 'PostgreSQL-backed demo history' : 'Temporary demo history'} · <a href="${REPO}" target="_blank" rel="noopener noreferrer">Source on GitHub ↗</a></footer>
        </div>
      </main>
    </div>`;

  document.querySelector('#task-form')?.addEventListener('submit', create);
  document.querySelectorAll('[data-select]').forEach((button) => button.addEventListener('click', () => { selectedTask = button.dataset.select; render(); }));
  document.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', () => run(button.dataset.run)));
  document.querySelectorAll('[data-chat-task]').forEach((button) => button.addEventListener('click', () => { chatTask = button.dataset.chatTask; resetChatScroll = true; render(); }));
  document.querySelector('#chat-agent-filter')?.addEventListener('change', (event) => { chatAgent = event.target.value; resetChatScroll = true; render(); });
  if (draft && document.querySelector('#title')) {
    document.querySelector('#title').value = draft.title;
    document.querySelector('#brief').value = draft.brief;
    if (draft.focused === 'title' || draft.focused === 'brief') {
      const field = document.querySelector(`#${draft.focused}`);
      field.focus();
      field.setSelectionRange(draft.start, draft.end);
    }
  }
  const feed = document.querySelector('.chat-feed');
  if (feed) {
    feed.scrollTop = resetChatScroll || wasAtBottom ? feed.scrollHeight : oldScroll;
    resetChatScroll = false;
  }
  lastRenderedSignature = signature();
}

async function refresh() {
  try {
    const state = await request('/api/state');
    data = { ...state, messages: Array.isArray(state.messages) ? state.messages : [] };
    error = '';
    connection = 'connected';
  } catch (cause) {
    error = `Could not reach the operations backend: ${cause.message}`;
    connection = 'disconnected';
  }
  const typing = document.activeElement?.id === 'title' || document.activeElement?.id === 'brief';
  if (!busy && !typing && signature() !== lastRenderedSignature) render();
}

async function create(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const title = form.elements.namedItem('title').value.trim();
  const brief = form.elements.namedItem('brief').value.trim();
  if (!title) return;
  busy = true;
  try {
    const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title, brief }) });
    selectedTask = created.id;
    error = '';
    form.reset();
    await refresh();
  } catch (cause) {
    error = cause.message;
  } finally {
    busy = false;
    render();
  }
}

async function run(id) {
  busy = true;
  try {
    await request(`/api/tasks/${id}/start`, { method: 'POST' });
    selectedTask = id;
    error = '';
    await refresh();
  } catch (cause) {
    error = cause.message;
  } finally {
    busy = false;
    render();
  }
}

window.addEventListener('hashchange', () => {
  render();
  const anchor = location.hash.slice(1);
  requestAnimationFrame(() => {
    if (anchor === 'tasks' || anchor === 'activity') document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' });
    else window.scrollTo({ top: 0 });
  });
});

render();
refresh();
setInterval(refresh, 1500);
