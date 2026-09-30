import './style.css';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '');
const keyName = 'northstar-lab-demo-workspace';
let workspaceKey = localStorage.getItem(keyName);
if (!workspaceKey || !/^[a-f0-9]{64}$/.test(workspaceKey)) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  workspaceKey = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(keyName, workspaceKey);
}

const roles = [
  { label: 'Project manager', short: 'PM', detail: 'Defines scope and closes the run' },
  { label: 'Team lead', short: 'TL', detail: 'Assigns and resolves handoffs' },
  { label: 'Research worker', short: 'RW', detail: 'Produces the work packet' },
  { label: 'Quality reviewer', short: 'QA', detail: 'Checks and requests revisions' },
];

let data = { tasks: [], events: [], modelCalls: 0, inputTokens: 0, outputTokens: 0 };
let selectedTask = null;
let busy = false;
let error = '';
let connection = 'connecting';
let lastRenderedSignature = '';

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

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

function activeRole(step) {
  if (step === 0 || step === 6) return 'Project manager';
  if (step === 1) return 'Team lead';
  if (step === 2 || step === 4) return 'Research worker';
  return 'Quality reviewer';
}

function render() {
  const existingTitle = document.querySelector('#title');
  const existingBrief = document.querySelector('#brief');
  const draft = existingTitle ? {
    title: existingTitle.value,
    brief: existingBrief.value,
    focused: document.activeElement?.id,
    start: document.activeElement?.selectionStart,
    end: document.activeElement?.selectionEnd,
  } : null;
  const running = data.tasks.filter((task) => task.status === 'running');
  const complete = data.tasks.filter((task) => task.status === 'complete');
  const queued = data.tasks.filter((task) => task.status === 'queued');
  const active = running[0];
  if (!selectedTask || !data.tasks.some((task) => task.id === selectedTask)) selectedTask = active?.id || data.tasks[0]?.id || null;
  const focus = data.tasks.find((task) => task.id === selectedTask);
  const focusEvents = data.events.filter((event) => !focus || event.task_id === focus.id);
  const currentRole = active ? activeRole(active.step) : '';

  document.querySelector('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">✳</div><div><strong>Northstar</strong><small>LAB / OPERATIONS</small></div></div>
        <nav aria-label="Workspace navigation">
          <a class="nav-item active" href="#overview"><span class="nav-glyph">◫</span> Overview</a>
          <a class="nav-item" href="#tasks"><span class="nav-glyph">▤</span> Task queue <span class="nav-count">${data.tasks.length}</span></a>
          <a class="nav-item" href="#activity"><span class="nav-glyph">◷</span> Activity</a>
        </nav>
        <div class="side-bottom">
          <div class="side-label">CURRENT MODE</div>
          <div class="mode-card"><span class="mode-orb"></span><div><strong>Workflow demo</strong><small>Zero AI requests</small></div></div>
          <p>Use sample tasks to inspect agent handoffs. Research begins after the model and sources are connected.</p>
        </div>
      </aside>

      <main id="overview" class="main">
        <header class="topbar">
          <div class="crumb">Workspace <span>/</span> Operations</div>
          <div class="top-actions"><span class="status ${connection === 'connected' ? 'online' : 'offline'}"><i></i>${connection === 'connected' ? 'Live backend' : 'Connecting'}</span><span class="avatar">CTO</span></div>
        </header>

        <div class="content">
          <section class="intro">
            <div><div class="eyebrow">RESEARCH COMPANY / CONTROL ROOM</div><h1>Agent operations</h1><p>Watch work move from assignment to independent review.</p></div>
            <span class="demo-tag">DEMO MODE · NO RESEARCH RUNS</span>
          </section>

          ${error ? `<div class="alert" role="alert">${escapeHTML(error)} <span>Backend: ${escapeHTML(API)}</span></div>` : ''}

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
            <div class="flow-foot"><span>↳</span> Review feedback returns work to the researcher before the manager closes the run.</div>
          </section>

          <div class="lower-grid">
            <section id="tasks" class="panel tasks-panel">
              <div class="panel-head"><div><div class="eyebrow">ASSIGNMENTS</div><h2>Task queue</h2></div><span class="panel-counter">${data.tasks.length} tasks</span></div>
              <form id="task-form" class="task-form">
                <label for="title">New demo task</label>
                <div class="form-row"><input id="title" name="title" maxlength="120" required minlength="3" placeholder="e.g. Explore developer workflow gaps" /><button type="submit" ${busy ? 'disabled' : ''}>Add task</button></div>
                <input id="brief" name="brief" maxlength="1000" placeholder="Optional context for a future research run" />
              </form>
              <div class="task-list">
                ${data.tasks.length ? data.tasks.map((task) => `<div class="task-row ${task.id === selectedTask ? 'selected' : ''}" data-task="${task.id}">
                  <button class="task-select" type="button" data-select="${task.id}"><span class="task-title">${escapeHTML(task.title)}</span><span class="task-meta">${escapeHTML(task.brief || 'Workflow demo')} · ${formatTime(task.created_at)}</span></button>
                  <div class="task-end"><span class="pill ${task.status}">${task.status === 'complete' ? 'Complete' : task.status === 'running' ? 'Running' : 'Queued'}</span>${task.status === 'queued' ? `<button class="run-btn" type="button" data-run="${task.id}" ${busy ? 'disabled' : ''}>Run demo</button>` : ''}</div>
                </div>`).join('') : '<div class="empty">Add a task to see its handoffs here.</div>'}
              </div>
            </section>

            <section id="activity" class="panel activity-panel">
              <div class="panel-head"><div><div class="eyebrow">EVENT LOG</div><h2>Live activity</h2></div><span class="live-label"><i></i>Updates every 1.5s</span></div>
              <div class="activity-list" aria-live="polite">
                ${focusEvents.length ? focusEvents.slice(0, 12).map((event) => `<div class="event"><div class="event-pin"></div><div class="event-body"><div><strong>${escapeHTML(event.role)}</strong><time>${formatTime(event.created_at)}</time></div><p>${escapeHTML(event.message)}</p></div></div>`).join('') : '<div class="empty">Events will appear as the workflow runs.</div>'}
              </div>
            </section>
          </div>
          <footer>Northstar Lab · Workflow preview · Persistent project data requires a connected database</footer>
        </div>
      </main>
    </div>`;

  document.querySelector('#task-form').addEventListener('submit', create);
  document.querySelectorAll('[data-select]').forEach((button) => button.addEventListener('click', () => { selectedTask = button.dataset.select; render(); }));
  document.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', () => run(button.dataset.run)));
  if (draft) {
    document.querySelector('#title').value = draft.title;
    document.querySelector('#brief').value = draft.brief;
    if (draft.focused === 'title' || draft.focused === 'brief') {
      const field = document.querySelector(`#${draft.focused}`);
      field.focus();
      field.setSelectionRange(draft.start, draft.end);
    }
  }
  lastRenderedSignature = JSON.stringify([data.tasks, data.events, data.modelCalls, data.inputTokens, data.outputTokens, connection, error, selectedTask, busy]);
}

async function refresh() {
  try {
    const next = await request('/api/state');
    data = next;
    error = '';
    connection = 'connected';
  } catch (cause) {
    error = `Could not reach the operations backend: ${cause.message}`;
    connection = 'disconnected';
  }
  const signature = JSON.stringify([data.tasks, data.events, data.modelCalls, data.inputTokens, data.outputTokens, connection, error, selectedTask, busy]);
  const typing = document.activeElement?.id === 'title' || document.activeElement?.id === 'brief';
  if (!busy && !typing && signature !== lastRenderedSignature) render();
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

render();
refresh();
setInterval(refresh, 1500);
