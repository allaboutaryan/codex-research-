import './style.css';
import './chats.css';
import './usage.css';
import './ux.css';
import './reports.css';

const API = import.meta.env.PROD ? '' : (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '');
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
let usageData = null;
let reportData = null;
let contextData = null;
let authStatus = null;
const authReady = fetch(`${API}/auth/status`).then((response) => response.json()).then((value) => { authStatus = value; })
  .catch(() => { authStatus = { enabled: false, authenticated: false }; });
let contextNote = '';
let usageError = '';
let pairingNote = '';
let pairingKey = null;
let selectedTask = null;
let chatTask = 'all';
let chatAgent = 'all';
let chatLane = 'task';
let dmAgent = 'Research worker';
let chatTargetAgent = 'Research worker';
let chatTargetTask = null;
let contextDraftDirty = false;
let resetChatScroll = true;
let busy = false;
let error = '';
let connection = 'connecting';
let lastRenderedSignature = '';

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const currentView = () => location.hash === '#chats' ? 'chats' : location.hash === '#usage' ? 'usage' : location.hash === '#approvals' ? 'approvals' : location.hash === '#reports' ? 'reports' : 'overview';
const formatNumber = (value) => Number(value || 0).toLocaleString();
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
  if (response.status === 401 && authStatus?.enabled) authStatus.authenticated = false;
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
  const label = (status) => ({ queued: 'Queued', running: 'Demo running', complete: 'Demo complete', planning_queued: 'PM planning', lead_queued: 'Lead assigning', team_failed: 'Team handoff failed', claude_queued: 'Claude queued', claude_running: 'Claude working', awaiting_review: 'Awaiting QA', claude_failed: 'Claude failed', research_blocked: 'Research blocked', review_queued: 'QA queued', review_running: 'QA checking', review_failed: 'QA failed', review_accepted: 'Your approval needed', review_revision: 'Needs revision', review_blocked: 'QA blocked', approved: 'Approved' })[status] || status;
  return data.tasks.length ? data.tasks.map((task) => {
    const hasCitedDraft = Boolean(data.reviewPackets?.[task.id]?.draft?.evidence_refs?.length);
    const retryResearch = ['queued', 'claude_failed', 'research_blocked', 'review_revision', 'review_blocked'].includes(task.status) || (task.status === 'awaiting_review' && !hasCitedDraft);
    const canReview = ['awaiting_review', 'review_failed'].includes(task.status) && hasCitedDraft;
    return `<div class="task-row ${task.id === selectedTask ? 'selected' : ''}" data-task="${escapeHTML(task.id)}">
    <button class="task-select" type="button" data-select="${escapeHTML(task.id)}"><span class="task-title">${escapeHTML(task.title)}</span><span class="task-meta">${escapeHTML(task.brief || 'No extra context')} · ${formatTime(task.created_at)}</span></button>
    <div class="task-end"><span class="pill ${escapeHTML(task.status)}">${escapeHTML(label(task.status))}</span>${task.status === 'queued' ? `<button class="run-btn demo-run" type="button" data-run="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''} title="Scripted walkthrough; no AI call">Preview demo</button>` : ''}${['queued', 'team_failed'].includes(task.status) ? `<button class="run-btn claude-run" type="button" data-run-team="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''} title="Runs PM, lead, research, QA, owner approval, PM and CTO as separate calls">${task.status === 'team_failed' ? 'Retry team' : 'Run full team'}</button>` : ''}${retryResearch ? `<button class="run-btn claude-run" type="button" data-run-claude="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''} title="Queues work for your local Claude worker">${task.status === 'queued' ? 'Research only' : 'Retry research'}</button>` : ''}${canReview ? `<button class="run-btn qa-run" type="button" data-run-review="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''}>${task.status === 'review_failed' ? 'Retry QA' : 'Run QA'}</button>` : ''}${task.status === 'review_accepted' ? '<a class="task-chat-link" href="#approvals">Review decision →</a>' : ''}</div>
  </div>`; }).join('') : '<div class="empty">Add a task to see its handoffs here.</div>';
}

function renderOverview() {
  const running = data.tasks.filter((task) => ['running', 'planning_queued', 'lead_queued', 'claude_running', 'review_running'].includes(task.status));
  const complete = data.tasks.filter((task) => task.status === 'complete');
  const queued = data.tasks.filter((task) => ['queued', 'planning_queued', 'lead_queued', 'claude_queued', 'review_queued'].includes(task.status));
  const awaitingQA = data.tasks.filter((task) => ['awaiting_review', 'review_queued', 'review_running', 'review_failed'].includes(task.status));
  const approvalCount = data.tasks.filter((task) => task.status === 'review_accepted').length;
  const active = running[0];
  if (!selectedTask || !data.tasks.some((task) => task.id === selectedTask)) selectedTask = active?.id || data.tasks[0]?.id || null;
  const focusEvents = data.events.filter((event) => !selectedTask || event.task_id === selectedTask);
  const currentRole = active ? ({ planning_queued: 'Project manager', lead_queued: 'Team lead', claude_running: 'Research worker', review_running: 'Quality reviewer' })[active.status] || activeRole(active.step) : '';
  const claudeStatus = usageData?.connections?.find((item) => item.provider === 'anthropic')?.status;
  const next = !claudeStatus || claudeStatus === 'not_connected'
    ? { title: 'Connect your Claude worker', detail: 'Pair Claude Code once, then run the worker on your computer.', href: '#usage', action: 'Open worker setup' }
    : claudeStatus === 'paired_offline'
      ? { title: 'Start the local worker', detail: 'Your workspace is paired. Claude answers and research run while the local worker is open.', href: '#usage', action: 'See start command' }
      : !data.tasks.length
        ? { title: 'Create a focused assignment', detail: 'Give Claude one clear research question and any scope or date constraints.', href: '#tasks', action: 'Add a task' }
        : approvalCount
          ? { title: 'Review a QA-accepted draft', detail: 'The reviewer completed a separate source check. Read its verdict before deciding.', href: '#approvals', action: 'Open approval inbox' }
          : data.tasks.some((task) => task.status === 'research_blocked' || (task.status === 'awaiting_review' && !data.reviewPackets?.[task.id]?.draft?.evidence_refs?.length))
            ? { title: 'Research needs attention', detail: 'A run stopped without sources. Check its blocker, clarify the question, then retry.', href: '#approvals', action: 'See blocked research' }
          : data.tasks.some((task) => task.status === 'awaiting_review' || task.status === 'review_failed')
            ? { title: 'Run the QA pass', detail: 'A research draft is ready for a separate Claude source-checking pass.', href: '#approvals', action: 'Open review queue' }
        : data.tasks.some((task) => ['queued', 'team_failed', 'claude_failed', 'research_blocked', 'review_revision', 'review_blocked'].includes(task.status))
          ? { title: 'Start the next research task', detail: 'Choose the full five-role workflow or the lower-token research-only shortcut.', href: '#tasks', action: 'Open task queue' }
          : { title: 'Ask about the work', detail: 'Read task handoffs and ask the Research worker a question.', href: '#chats', action: 'Open agent chats' };

  return `
    <section class="intro">
      <div><div class="eyebrow">RESEARCH COMPANY / CONTROL ROOM</div><h1>Research workspace</h1><p>Create focused tasks, follow evidence, and ask the live worker what comes next.</p></div>
      <span class="demo-tag">${data.mode === 'claude_pilot' ? 'CLAUDE PILOT · QA REQUIRED' : 'DEMO MODE · NO RESEARCH RUNS'}</span>
    </section>
    <section class="panel action-banner" aria-label="Recommended next step">
      <div><div class="eyebrow">YOUR NEXT STEP</div><h2>${escapeHTML(next.title)}</h2><p>${escapeHTML(next.detail)}</p></div>
      <a href="${next.href}">${escapeHTML(next.action)} <span aria-hidden="true">→</span></a>
    </section>
    <div class="lower-grid">
      <section id="tasks" class="panel tasks-panel">
        <div class="panel-head"><div><div class="eyebrow">START HERE</div><h2>Tasks</h2></div><span class="panel-counter">${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'}</span></div>
        <form id="task-form" class="task-form">
          <label for="title">What should we investigate?</label>
          <div class="form-row"><input id="title" name="title" maxlength="120" required minlength="3" placeholder="e.g. Find gaps in developer onboarding research" /><button type="submit" ${busy ? 'disabled' : ''}>Create task</button></div>
          <label class="brief-label" for="brief">Scope or constraints <span>(optional)</span></label>
          <input id="brief" name="brief" maxlength="1000" placeholder="Dates, source types, questions to answer…" />
        </form>
        <div class="task-list">${renderTaskRows()}</div>
      </section>
      <section id="activity" class="panel activity-panel">
        <div class="panel-head"><div><div class="eyebrow">PROGRESS</div><h2>Recent activity</h2></div><span class="live-label"><i></i>Live</span></div>
        <div class="activity-list" aria-live="polite">
          ${focusEvents.length ? focusEvents.slice(0, 12).map((event) => `<div class="event"><div class="event-pin"></div><div class="event-body"><div><strong>${escapeHTML(event.role)}</strong><time>${formatTime(event.created_at)}</time></div><p>${escapeHTML(event.message)}</p></div></div>`).join('') : '<div class="empty">Events will appear as the workflow runs.</div>'}
        </div>
      </section>
    </div>
    <section class="metrics overview-metrics" aria-label="Workspace metrics">
      <div class="metric"><span>Total tasks</span><strong>${data.tasks.length}</strong><small>${queued.length} waiting in queue</small></div>
      <div class="metric"><span>Active runs</span><strong>${running.length}</strong><small>${running.length ? 'Workflow in progress' : 'No work in progress'}</small></div>
      <div class="metric"><span>${approvalCount ? 'Needs your approval' : awaitingQA.length ? 'Awaiting QA' : 'Demo completed'}</span><strong>${approvalCount || awaitingQA.length || complete.length}</strong><small>${approvalCount ? 'Read the reviewer verdict first' : awaitingQA.length ? 'Drafts, not accepted findings' : 'Scripted walkthroughs'}</small></div>
      <div class="metric accent"><span>AI tokens used</span><strong>${formatNumber(usageData?.summary?.total?.totalTokens)}</strong><small>${formatNumber(usageData?.summary?.total?.calls)} actual model calls</small></div>
    </section>
    <details class="workflow-details" ${document.querySelector('.workflow-details')?.open ? 'open' : ''}>
      <summary>How the team workflow is designed <span>Roles and review gates</span></summary>
      <div class="flow" aria-label="Agent workflow">
        ${roles.map((role, index) => `<div class="flow-card ${currentRole === role.label ? 'is-active' : ''}">
          <div class="flow-top"><span class="step">0${index + 1}</span><span class="role-icon">${role.short}</span></div>
          <h3>${role.label}</h3><p>${role.detail}</p>
          <div class="role-status"><span></span>${currentRole === role.label ? active.status === 'running' ? 'Demo step' : 'Team stage' : claudeStatus === 'online' ? 'Local Claude ready' : 'Local Claude offline'}</div>
        </div>`).join('')}
      </div>
      <div class="flow-foot">Full-team tasks use separate local Claude calls for PM, lead, research, QA, and CTO. QA is not cross-provider; the owner approval gate remains. <a href="#approvals">Open approvals →</a></div>
    </details>`;
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
  const job = data.chatJobs?.find((item) => item.id === message.run_id);
  const provenance = message.demo ? 'Scripted demo' : message.agent_id === 'Owner'
    ? message.kind === 'decision' ? 'Your decision' : `Your message · ${job?.status || 'sent'}`
    : message.kind === 'answer' ? 'Direct Claude reply · not a formal review'
      : message.kind === 'review' ? 'Separate Claude QA verdict'
        : message.agent_id === 'System' ? 'Worker status' : 'Real Claude draft';
  return `<article class="chat-message">
    <div class="chat-avatar">${escapeHTML(role?.short || message.agent_id.slice(0, 2).toUpperCase())}</div>
    <div class="chat-message-body">
      <div class="chat-message-head"><div>${speaker}<span class="chat-to">→ ${escapeHTML(message.recipient_id)}</span></div><time>${formatDateTime(message.created_at)}</time></div>
      <div class="chat-message-meta"><span class="message-kind">${escapeHTML(message.kind)}</span><span>${escapeHTML(task?.title || 'Unknown task')}</span><span class="${message.demo ? 'demo-inline' : 'qa-inline'}">${escapeHTML(provenance)}</span></div>
      <p>${escapeHTML(message.summary)}</p>
      ${refs ? `<div class="chat-refs">${refs}</div>` : ''}
    </div>
  </article>`;
}

function renderChats() {
  if (chatTask !== 'all' && !data.tasks.some((task) => task.id === chatTask)) chatTask = 'all';
  const messages = data.messages.filter((message) => (chatTask === 'all' || message.task_id === chatTask) && (
    chatLane === 'direct'
      ? !message.demo && ((message.agent_id === 'Owner' && message.recipient_id === dmAgent && message.kind === 'question') || (message.agent_id === dmAgent && message.recipient_id === 'Owner' && message.kind === 'answer'))
      : chatAgent === 'all' || message.agent_id === chatAgent
  )).slice().reverse();
  const selected = data.tasks.find((task) => task.id === chatTask);
  if (!chatTargetTask || !data.tasks.some((task) => task.id === chatTargetTask)) chatTargetTask = selectedTask || data.tasks[0]?.id || null;
  const pendingQuestions = data.chatJobs?.filter((item) => ['queued', 'running'].includes(item.status)).length || 0;
  return `
    <section class="intro">
      <div><div class="eyebrow">SHARED WORKROOM / DIRECT MESSAGES</div><h1>Agent chats</h1><p>Message a worker directly, or follow the shared conversation on each task.</p></div>
      <span class="demo-tag">${data.mode === 'claude_pilot' ? 'MIXED FEED · REAL MESSAGES LABELED' : 'SCRIPTED DEMO · 0 MODEL CALLS'}</span>
    </section>
    <div class="chat-explainer">All five roles can answer you individually through separate local Claude calls. Direct replies are not formal QA decisions. Task threads show real handoffs and labeled demos. Claude uses bounded context, not the entire chat history. ${authStatus?.enabled ? 'Owner access is restricted to your GitHub sign-in.' : 'This pilot has no account login yet: do not enter credentials or private research.'} <a href="${REPO}/blob/main/agents/PROTOCOL.md" target="_blank" rel="noopener noreferrer">Agent message protocol ↗</a></div>
    <details class="panel context-panel" ${document.querySelector('.context-panel')?.open ? 'open' : ''}>
      <summary>Project goal and memory <span>View or edit the context Claude receives ↗</span></summary>
      <form id="context-form" class="context-form">
        <label for="project-goal">Project goal</label><textarea id="project-goal" maxlength="1500" required>${escapeHTML(contextData?.mission || '')}</textarea>
        <label for="project-notes">Owner memory notes · key decisions, constraints, and facts to retain</label><textarea id="project-notes" maxlength="2000" placeholder="e.g. Prioritize developer tools; validate demand before building.">${escapeHTML(contextData?.notes || '')}</textarea>
        <button type="submit" ${busy || !contextData ? 'disabled' : ''}>Save project memory</button>
        ${contextNote ? `<span class="context-note" role="status">${escapeHTML(contextNote)}</span>` : ''}
      </form>
    </details>
    <section class="panel ask-panel">
      <div class="panel-head"><div><div class="eyebrow">OWNER ↔ LOCAL CLAUDE AGENTS</div><h2>Message a worker</h2></div><span class="panel-counter">${pendingQuestions} pending · local worker ${usageData?.connections?.find((item) => item.provider === 'anthropic')?.status === 'online' ? 'online' : 'offline'}</span></div>
      <form id="ask-form" class="ask-form">
        <div class="ask-field"><label for="chat-recipient">Agent</label><select id="chat-recipient">${roles.map((role) => `<option value="${escapeHTML(role.label)}" ${chatTargetAgent === role.label ? 'selected' : ''}>${escapeHTML(role.label)} · ${escapeHTML(role.detail)}</option>`).join('')}</select></div>
        <div class="ask-field"><label for="chat-task-picker">Task</label><select id="chat-task-picker" required>${data.tasks.map((task) => `<option value="${escapeHTML(task.id)}" ${chatTargetTask === task.id ? 'selected' : ''}>${escapeHTML(task.title)}</option>`).join('')}</select></div>
        <div class="ask-field"><label for="owner-question">Your question</label><textarea id="owner-question" rows="2" maxlength="2000" required minlength="3" placeholder="What did we learn, what remains uncertain, or what should we do next?"></textarea></div>
        <button type="submit" ${busy || !data.tasks.length ? 'disabled' : ''}>Send question →</button>
      </form>
      <small>${data.tasks.length ? 'Messages wait if your local worker is offline.' : '<a href="#tasks">Create a task first →</a>'} All five roles use your local Claude subscription; reviewer DMs do not change the formal QA verdict.</small>
    </section>
    <div class="chat-layout">
      <section class="panel chat-tasks" aria-label="Conversation tasks">
        <div class="panel-head"><div><div class="eyebrow">CONVERSATIONS</div><h2>${chatLane === 'direct' ? 'Direct messages' : 'Task threads'}</h2></div><span class="panel-counter">${data.messages.length} messages</span></div>
        <div class="chat-lanes"><button type="button" data-chat-lane="task" class="${chatLane === 'task' ? 'selected' : ''}">Task threads</button><button type="button" data-chat-lane="direct" class="${chatLane === 'direct' ? 'selected' : ''}">Direct messages</button></div>
        ${chatLane === 'direct' ? `<div class="chat-dm-list">${roles.map((role) => `<button class="chat-task ${dmAgent === role.label ? 'selected' : ''}" type="button" data-dm-agent="${escapeHTML(role.label)}"><span>${escapeHTML(role.label)}</span><small>${escapeHTML(role.detail)}</small></button>`).join('')}</div>` : ''}
        <div class="chat-task-list">
          <button class="chat-task ${chatTask === 'all' ? 'selected' : ''}" data-chat-task="all" type="button"><span>${chatLane === 'direct' ? 'All tasks' : 'All agent chats'}</span><small>${data.messages.length} messages</small></button>
          ${data.tasks.map((task) => `<button class="chat-task ${chatTask === task.id ? 'selected' : ''}" data-chat-task="${escapeHTML(task.id)}" type="button"><span>${escapeHTML(task.title)}</span><small>${data.messages.filter((message) => message.task_id === task.id).length} messages · ${escapeHTML(task.status)}</small></button>`).join('')}
        </div>
        <div class="chat-skills"><div class="eyebrow">AGENT SKILLS ON GITHUB</div>${roles.map((role) => `<a href="${skillURL(role.label)}" target="_blank" rel="noopener noreferrer">${escapeHTML(role.label)} <span>↗</span></a>`).join('')}</div>
      </section>
      <section class="panel chat-thread" aria-label="Agent conversation">
        <div class="panel-head"><div><div class="eyebrow">${chatLane === 'direct' ? 'DIRECT WORKER CONVERSATION' : 'VISIBLE TASK CONVERSATION'}</div><h2>${escapeHTML(chatLane === 'direct' ? `${dmAgent} · ${selected?.title || 'all tasks'}` : selected?.title || 'All conversations')}</h2></div><span class="live-label"><i></i>Live updates</span></div>
        ${chatLane === 'task' ? `<div class="chat-controls"><label for="chat-agent-filter">Filter by sender</label><select id="chat-agent-filter"><option value="all" ${chatAgent === 'all' ? 'selected' : ''}>All agents</option>${roles.map((role) => `<option value="${escapeHTML(role.label)}" ${chatAgent === role.label ? 'selected' : ''}>${escapeHTML(role.label)}</option>`).join('')}</select></div>` : '<p class="dm-note">Only your direct questions and this worker’s replies appear here. Task handoffs remain in task threads.</p>'}
        <div class="chat-feed" role="log" aria-label="Agent messages" aria-live="polite">
          ${messages.length ? messages.map(renderMessage).join('') : `<div class="empty chat-empty">${data.tasks.length ? 'No messages for this conversation yet. Message the worker above or run a task.' : 'No conversations yet. Add a task to begin.'}<br/><a href="#tasks">Go to task queue →</a></div>`}
        </div>
        <div class="chat-thread-foot"><span>${messages.length} shown</span><span>${data.database === 'postgres' ? 'Saved in PostgreSQL' : 'Temporary in-memory data'}</span></div>
      </section>
    </div>`;
}

function renderApprovals() {
  const reviewable = data.tasks.filter((task) => ['research_blocked', 'awaiting_review', 'review_failed', 'review_queued', 'review_running', 'review_accepted', 'review_revision', 'review_blocked', 'approved'].includes(task.status));
  const needsOwner = reviewable.filter((task) => task.status === 'review_accepted').length;
  return `
    <section class="intro">
      <div><div class="eyebrow">QUALITY GATE / OWNER DECISIONS</div><h1>Approval inbox</h1><p>Check the draft and the separate reviewer verdict before approving any research.</p></div>
      <span class="demo-tag">${needsOwner} NEED YOUR DECISION</span>
    </section>
    <div class="chat-explainer">QA runs in a fresh Claude invocation with the task, latest draft, and its source links; it does not see the research chat history. This is a separate pass on the <em>same Claude account</em>, not a different provider. It can miss errors, so your approval remains required. ${authStatus?.enabled ? 'GitHub owner sign-in is active.' : 'This workspace does not yet have user login—do not enter private material.'}</div>
    <section class="approval-list" aria-label="Research approval queue">
      ${reviewable.length ? reviewable.map((task) => {
        const recent = data.messages.filter((message) => message.task_id === task.id && !message.demo);
        const draft = data.reviewPackets?.[task.id]?.draft || recent.find((message) => message.kind === 'finding');
        const latestReview = data.reviewPackets?.[task.id]?.review || recent.find((message) => message.kind === 'review');
        const review = latestReview && draft && Number(latestReview.id) > Number(draft.id) ? latestReview : null;
        const blocker = data.reviewPackets?.[task.id]?.blocker || recent.find((message) => message.kind === 'blocker' && message.agent_id === 'Research worker');
        const cited = Boolean(draft?.evidence_refs?.length);
        const verdict = task.status === 'review_accepted' ? 'QA accepted · your decision needed'
          : task.status === 'approved' ? 'Owner approved'
            : task.status === 'review_revision' ? 'Revision requested'
              : task.status === 'review_blocked' ? 'QA blocked'
                : task.status === 'review_running' ? 'QA checking sources'
                  : task.status === 'review_queued' ? 'QA queued'
                    : task.status === 'review_failed' ? 'QA failed · retry available'
                      : task.status === 'research_blocked' || !cited ? 'Research blocked · no sources' : 'Draft awaiting QA';
        return `<article class="panel approval-card">
          <div class="panel-head"><div><div class="eyebrow">TASK ${escapeHTML(task.id.slice(0, 8))}</div><h2>${escapeHTML(task.title)}</h2></div><span class="pill ${escapeHTML(task.status)}">${escapeHTML(verdict)}</span></div>
          <p class="approval-brief">${escapeHTML(task.brief || 'No additional task brief.')}</p>
          <div class="approval-columns">
            <div class="approval-document"><h3>${task.status === 'research_blocked' ? 'Why research stopped' : 'Research draft'}</h3>${task.status === 'research_blocked' && blocker ? `<p>${escapeHTML(blocker.summary)}</p>` : draft ? `<p>${escapeHTML(draft.summary)}</p><div class="chat-refs">${renderRefs(draft.evidence_refs, 'Draft source')}</div>` : '<p>No cited research draft is available.</p>'}</div>
            <div class="approval-document"><h3>QA verdict</h3>${review ? `<p>${escapeHTML(review.summary)}</p><div class="chat-refs">${renderRefs(review.evidence_refs, 'Checked source')}</div>` : '<p>No reviewer verdict yet.</p>'}</div>
          </div>
          <div class="approval-actions">
            ${['awaiting_review', 'review_failed'].includes(task.status) && cited ? `<button class="run-btn qa-run" type="button" data-run-review="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''}>${task.status === 'review_failed' ? 'Retry QA' : 'Run separate QA'}</button>` : ''}
            ${(task.status === 'research_blocked' || (task.status === 'awaiting_review' && !cited)) ? `<button class="run-btn claude-run" type="button" data-run-claude="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''}>Retry research</button><span class="approval-hint">Clarify the task if needed; QA cannot run without a source.</span>` : ''}
            ${['review_revision', 'review_blocked'].includes(task.status) ? `<button class="run-btn claude-run" type="button" data-run-claude="${escapeHTML(task.id)}" ${busy ? 'disabled' : ''}>Queue revised research</button>` : ''}
            ${task.status === 'review_accepted' && draft && review ? `<form class="owner-decision" data-decision-task="${escapeHTML(task.id)}"><label for="decision-note-${escapeHTML(task.id)}">Your note or revision request</label><textarea id="decision-note-${escapeHTML(task.id)}" maxlength="1000" placeholder="Why are you approving, or what must be corrected?"></textarea><div><button class="run-btn approve-btn" type="submit" name="decision" value="approve" ${busy ? 'disabled' : ''}>Approve research</button><button class="run-btn revision-btn" type="submit" name="decision" value="revise" ${busy ? 'disabled' : ''}>Request revision</button></div></form>` : ''}
            <button class="task-chat-link approval-chat-link" type="button" data-open-thread="${escapeHTML(task.id)}">Open task conversation →</button>
          </div>
        </article>`;
      }).join('') : '<div class="panel empty">No research drafts yet. Create and queue a task, then return here for QA.</div>'}
    </section>`;
}

function renderUsage() {
  const total = usageData?.summary?.total || {};
  const byProvider = usageData?.summary?.byProvider || {};
  const byAgent = usageData?.summary?.byAgent || {};
  const connections = usageData?.connections || [];
  const claudeConnection = connections.find((item) => item.provider === 'anthropic');
  const routes = usageData?.routes || [];
  const events = usageData?.events || [];
  return `
    <section class="intro">
      <div><div class="eyebrow">WORKER SETUP / MEASURED ACTIVITY</div><h1>Connect &amp; usage</h1><p>Start your local Claude worker and track the calls made in this workspace.</p></div>
      <span class="demo-tag">${connections.some((item) => item.provider === 'anthropic' && item.status === 'online') ? 'LOCAL CLAUDE WORKER ONLINE' : 'NO WORKER ONLINE'}</span>
    </section>
    ${usageError ? `<div class="alert" role="alert">${escapeHTML(usageError)}</div>` : ''}
    <section class="panel pairing-panel" id="claude-setup">
      <div class="panel-head"><div><div class="eyebrow">GET STARTED</div><h2>Connect Claude Code locally</h2></div><span class="panel-counter">No account token sent to Render</span></div>
      <ol class="setup-steps">
        <li><span class="step-number" aria-hidden="true">1</span><span>Sign in to Claude Code on your computer.</span></li>
        <li><span class="step-number" aria-hidden="true">2</span><span>Pair this workspace and copy the one-time key below.</span></li>
        <li><span class="step-number" aria-hidden="true">3</span><span>In the repository’s <code>backend</code> folder, run the command shown below and keep Terminal open.</span></li>
      </ol>
      <div class="setup-actions"><button id="pair-worker" type="button">${['online', 'paired_offline'].includes(claudeConnection?.status) ? 'Rotate worker key' : 'Pair local Claude'}</button>${pairingKey ? '<button id="copy-worker-key" type="button">Copy one-time worker key</button>' : ''}<span class="pairing-note" role="status">${escapeHTML(pairingNote)}</span></div>
      <pre>NORTHSTAR_WORKER_KEY="$(pbpaste)" npm run worker:claude</pre>
      <small>Then create a task or ask a question. Claude runs only while the local worker is open. Pairing again revokes the previous key. <a href="${REPO}/blob/main/README.md#run-the-claude-research-worker" target="_blank" rel="noopener noreferrer">Full setup guide ↗</a></small>
    </section>
    <details class="usage-explainer" ${document.querySelector('.usage-explainer')?.open ? 'open' : ''}>
      <summary>What do these usage numbers include?</summary>
      <p>Only completed Northstar worker calls are recorded, not your entire Claude or ChatGPT account. Scripted demo chats never count. Interrupted calls may not report usage; provider totals can be higher. Check balances and reset times with each provider. Claude Code sign-in stays on your computer.</p>
    </details>
    <section class="metrics" aria-label="Actual worker usage">
      <div class="metric accent"><span>Actual model calls</span><strong>${formatNumber(total.calls)}</strong><small>Demo handoffs excluded</small></div>
      <div class="metric"><span>Input tokens</span><strong>${formatNumber(total.inputTokens)}</strong><small>Includes cached input</small></div>
      <div class="metric"><span>Output tokens</span><strong>${formatNumber(total.outputTokens)}</strong><small>Includes reasoning output</small></div>
      <div class="metric"><span>Cached input</span><strong>${formatNumber(total.cachedInputTokens)}</strong><small>Subset of input, not added twice</small></div>
    </section>
    <section class="provider-section">
      <div class="section-heading"><div><div class="eyebrow">SUBSCRIPTION CONNECTIONS</div><h2>Providers</h2></div><div class="section-note">No auto-switching between accounts</div></div>
      <div class="provider-grid">${connections.map((item) => `<article class="panel provider-card">
        <div class="provider-top"><span class="provider-icon">${item.worker === 'Codex' ? 'C' : 'A'}</span><span class="connection-pill ${item.status === 'online' ? 'is-online' : ''}">${item.status === 'online' ? 'Local worker online' : item.status === 'paired_offline' ? 'Paired · offline' : 'Not connected'}</span></div>
        <h3>${escapeHTML(item.worker)}</h3><p>${escapeHTML(item.requirement)}</p>
        <div class="provider-stats"><span>${formatNumber(byProvider[item.provider]?.calls)} calls</span><span>${formatNumber(byProvider[item.provider]?.totalTokens)} tokens</span></div>
        <a href="${item.provider === 'openai' ? 'https://chatgpt.com/#settings/Usage' : 'https://claude.ai/settings/usage'}" target="_blank" rel="noopener noreferrer">Check provider usage ↗</a>
      </article>`).join('') || '<div class="empty">Loading provider status…</div>'}</div>
    </section>
    <section class="panel routing-panel">
      <div class="panel-head"><div><div class="eyebrow">ROLE ASSIGNMENTS</div><h2>Worker routing</h2></div><span class="panel-counter">${claudeConnection?.status === 'online' ? 'Claude research worker available' : 'Start local Claude to activate research'}</span></div>
      <div class="routing-table" role="table" aria-label="Planned worker routes">
        <div class="routing-row routing-head" role="row"><span>Agent</span><span>Worker / purpose</span><span>Calls</span><span>Input</span><span>Output</span><span>Cached</span></div>
        ${routes.map((route) => `<div class="routing-row" role="row"><span><a href="${skillURL(route.agent)}" target="_blank" rel="noopener noreferrer">${escapeHTML(route.agent)} ↗</a></span><span>${escapeHTML(route.worker)}<small>${escapeHTML(route.reason)}</small></span><span>${formatNumber(byAgent[route.agent]?.calls)}</span><span>${formatNumber(byAgent[route.agent]?.inputTokens)}</span><span>${formatNumber(byAgent[route.agent]?.outputTokens)}</span><span>${formatNumber(byAgent[route.agent]?.cachedInputTokens)}</span></div>`).join('')}
      </div>
    </section>
    <section class="panel usage-history">
      <div class="panel-head"><div><div class="eyebrow">AUDIT LOG</div><h2>Recent worker calls</h2></div><span class="panel-counter">${events.length} recorded</span></div>
      ${events.length ? `<div class="usage-events">${events.map((event) => `<div class="usage-event"><div><strong>${escapeHTML(event.agent_id)}</strong><span>${escapeHTML(data.tasks.find((task) => task.id === event.task_id)?.title || 'Task')} · ${escapeHTML(event.model || event.provider)}</span></div><div>${formatNumber(Number(event.input_tokens) + Number(event.output_tokens))} tokens <small>${formatNumber(event.input_tokens)} in · ${formatNumber(event.output_tokens)} out · ${formatNumber(event.cached_input_tokens)} cached</small><small>${formatDateTime(event.created_at)}</small></div></div>`).join('')}</div>` : '<div class="empty">No real worker calls have been recorded. Demo tasks do not consume tokens.</div>'}
    </section>`;
}

function renderReports() {
  const alerts = reportData?.alerts || [];
  const reports = reportData?.reports || [];
  const latest = reports[0];
  return `<section class="intro">
    <div><div class="eyebrow">OPERATIONS / REAL ACTIVITY ONLY</div><h1>Alerts &amp; reports</h1><p>See what needs you, and review the daily activity summary at 6:00 PM India time.</p></div>
    <span class="demo-tag">${alerts.length} OPEN ALERT${alerts.length === 1 ? '' : 'S'}</span>
  </section>
  <section class="panel report-delivery">
    <div><div class="eyebrow">DELIVERY</div><h2>Telegram ${reportData?.delivery === 'configured' ? 'configured' : 'not connected yet'}</h2>
    <p>Dashboard alerts work now. Telegram delivery needs your private bot token, chat ID, and workspace ID in Render. The bot will send stuck alerts and the 6:00 PM report when configured. Timing on the free server is best-effort.</p></div>
    <button id="copy-workspace-id" type="button" ${reportData?.workspace_id ? '' : 'disabled'}>Copy workspace ID</button>
  </section>
  <div class="report-grid">
    <section class="panel"><div class="panel-head"><div><div class="eyebrow">ACTION REQUIRED</div><h2>Current alerts</h2></div><span class="panel-counter">${alerts.length}</span></div>
      ${alerts.length ? `<div class="report-alert-list">${alerts.map((alert) => `<article class="report-alert"><span class="report-alert-mark ${alert.severity}">${alert.severity === 'action' ? 'DECISION' : 'STUCK'}</span><div><h3>${escapeHTML(alert.title)}</h3><p>${escapeHTML(alert.task_title)} · ${escapeHTML(alert.detail)}</p><small>Since ${formatDateTime(alert.since)}</small></div><a href="#approvals">Open task →</a></article>`).join('')}</div>` : '<p class="report-empty">Nothing is currently stuck or awaiting your decision.</p>'}
    </section>
    <section class="panel"><div class="panel-head"><div><div class="eyebrow">DAILY SNAPSHOT</div><h2>${latest ? escapeHTML(latest.date) : 'Next report at 6:00 PM'}</h2></div><span class="panel-counter">Asia/Kolkata</span></div>
      ${latest ? `<div class="report-stats"><div><span>Tasks</span><strong>${formatNumber(latest.taskCount)}</strong></div><div><span>Model calls</span><strong>${formatNumber(latest.modelCalls)}</strong></div><div><span>Tokens</span><strong>${formatNumber(Number(latest.inputTokens) + Number(latest.outputTokens))}</strong></div><div><span>Needs attention</span><strong>${formatNumber(latest.attention?.length)}</strong></div></div>
      <h3>Work by agent</h3>${Object.entries(latest.agents || {}).length ? `<div class="report-agents">${Object.entries(latest.agents).map(([name, agent]) => `<div><strong>${escapeHTML(name)}</strong><span>${formatNumber(agent.calls)} calls · ${formatNumber(agent.messages)} messages · ${formatNumber(Number(agent.inputTokens) + Number(agent.outputTokens))} tokens</span></div>`).join('')}</div>` : '<p class="report-empty">No real agent activity was recorded for this report.</p>'}
      <p class="report-note">These are recorded actions, not a model-written CTO summary. Demo steps and account-wide subscription usage are excluded.</p>` : '<p class="report-empty">The first report appears after 6:00 PM IST. Until then, live alerts above show immediate issues.</p>'}
    </section>
  </div>
  ${reports.length > 1 ? `<details class="report-history"><summary>Earlier daily reports (${reports.length - 1})</summary>${reports.slice(1).map((report) => `<div>${escapeHTML(report.date)} · ${formatNumber(report.modelCalls)} calls · ${formatNumber(Number(report.inputTokens) + Number(report.outputTokens))} tokens · ${formatNumber(report.attention?.length)} need attention</div>`).join('')}</details>` : ''}`;
}

function signature() {
  return JSON.stringify([authStatus, data.tasks, data.events, data.messages, data.reviewPackets, data.chatJobs, data.database, data.mode, usageData, reportData, contextData, contextNote, usageError, pairingNote, connection, error, selectedTask, chatTask, chatAgent, chatLane, dmAgent, chatTargetAgent, chatTargetTask, currentView(), busy]);
}

function render() {
  if (authStatus?.enabled && !authStatus.authenticated) {
    document.querySelector('#app').innerHTML = `<main class="login-screen"><section class="login-card"><div class="brand-mark">✳</div><div class="eyebrow">NORTHSTAR LAB / OWNER ACCESS</div><h1>Sign in to your research workspace</h1><p>Only the GitHub account <strong>allaboutaryan</strong> can open tasks, agent chats, approvals, and reports.</p>${location.hash === '#not-owner' ? '<div class="alert">This GitHub account is not the approved owner.</div>' : location.hash === '#login-error' ? '<div class="alert">Sign-in did not complete. Please try again.</div>' : ''}<a class="login-button" href="/auth/github/start">Continue with GitHub →</a><small>Northstar uses your GitHub identity only; it does not request repository access.</small></section></main>`;
    lastRenderedSignature = signature();
    return;
  }
  const editableIds = ['title', 'brief', 'owner-question', 'project-goal', 'project-notes', ...data.tasks.map((task) => `decision-note-${task.id}`)];
  const draft = Object.fromEntries(editableIds.map((id) => [id, document.getElementById(id)?.value]));
  const focused = editableIds.includes(document.activeElement?.id) ? document.activeElement.id : null;
  const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
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
          <a class="nav-item ${view === 'approvals' ? 'active' : ''}" href="#approvals"><span class="nav-glyph">✓</span> Approvals <span class="nav-count">${data.tasks.filter((task) => task.status === 'review_accepted').length}</span></a>
          <a class="nav-item ${view === 'reports' ? 'active' : ''}" href="#reports"><span class="nav-glyph">◬</span> Alerts &amp; reports <span class="nav-count">${reportData?.alerts?.length || 0}</span></a>
          <a class="nav-item ${view === 'usage' ? 'active' : ''}" href="#usage"><span class="nav-glyph">◈</span> Connect &amp; usage</a>
        </nav>
        <div class="side-bottom">
          <div class="side-label">CURRENT MODE</div>
          <div class="mode-card"><span class="mode-orb"></span><div><strong>${data.mode === 'claude_pilot' ? 'Claude pilot' : 'Workflow demo'}</strong><small>${formatNumber(usageData?.summary?.total?.calls)} actual AI requests</small></div></div>
          <p>${data.mode === 'claude_pilot' ? 'Research drafts go through separate Claude QA and then need your approval.' : 'Sample tasks show scripted handoffs. Start the local Claude worker for real drafts.'}</p>
          <a class="repo-link" href="${REPO}" target="_blank" rel="noopener noreferrer">View GitHub repository ↗</a>
        </div>
      </aside>
      <main id="${view}" class="main">
        <header class="topbar">
          <div class="crumb">Workspace <span>/</span> ${view === 'chats' ? 'Agent chats' : view === 'approvals' ? 'Approvals' : view === 'reports' ? 'Alerts &amp; reports' : view === 'usage' ? 'Connect &amp; usage' : 'Operations'}</div>
          <div class="top-actions"><span class="status ${connection === 'connected' ? 'online' : 'offline'}"><i></i>${connection === 'connected' ? 'Connected' : 'Connecting'}</span><span class="avatar" title="Owner view">YOU</span>${authStatus?.enabled ? '<button type="button" id="owner-logout" class="logout-button">Sign out</button>' : ''}</div>
        </header>
        <div class="content">
          ${error ? `<div class="alert" role="alert">${escapeHTML(error)} <span>Backend: ${escapeHTML(API)}</span></div>` : ''}
          ${view === 'chats' ? renderChats() : view === 'approvals' ? renderApprovals() : view === 'reports' ? renderReports() : view === 'usage' ? renderUsage() : renderOverview()}
          <footer>Northstar Lab · Research workflow pilot · ${data.database === 'postgres' ? 'PostgreSQL history' : 'Temporary history'} · <a href="${REPO}" target="_blank" rel="noopener noreferrer">Source on GitHub ↗</a></footer>
        </div>
      </main>
    </div>`;

  document.querySelector('#task-form')?.addEventListener('submit', create);
  document.querySelector('#owner-logout')?.addEventListener('click', async () => { await fetch('/auth/logout', { method: 'POST' }); location.reload(); });
  document.querySelector('#ask-form')?.addEventListener('submit', askClaude);
  document.querySelector('#context-form')?.addEventListener('submit', saveContext);
  document.querySelectorAll('#project-goal, #project-notes').forEach((field) => field.addEventListener('input', () => { contextDraftDirty = true; contextNote = ''; }));
  document.querySelector('#chat-task-picker')?.addEventListener('change', (event) => { chatTargetTask = event.target.value; chatTask = chatTargetTask; resetChatScroll = true; render(); });
  document.querySelector('#chat-recipient')?.addEventListener('change', (event) => { chatTargetAgent = event.target.value; });
  document.querySelectorAll('[data-select]').forEach((button) => button.addEventListener('click', () => { selectedTask = button.dataset.select; render(); }));
  document.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', () => run(button.dataset.run)));
  document.querySelectorAll('[data-run-claude]').forEach((button) => button.addEventListener('click', () => runClaude(button.dataset.runClaude)));
  document.querySelectorAll('[data-run-team]').forEach((button) => button.addEventListener('click', () => runTeam(button.dataset.runTeam)));
  document.querySelectorAll('[data-run-review]').forEach((button) => button.addEventListener('click', () => runReview(button.dataset.runReview)));
  document.querySelectorAll('[data-decision-task]').forEach((form) => form.addEventListener('submit', ownerDecision));
  document.querySelectorAll('[data-open-thread]').forEach((button) => button.addEventListener('click', () => { chatTask = button.dataset.openThread; chatTargetTask = chatTask; chatLane = 'task'; location.hash = '#chats'; }));
  document.querySelector('#pair-worker')?.addEventListener('click', async () => {
    if (['online', 'paired_offline'].includes(usageData?.connections?.find((item) => item.provider === 'anthropic')?.status) && !window.confirm('This will revoke the existing local Claude worker key. Continue?')) return;
    try {
      const result = await request('/api/worker/claude/pair', { method: 'POST' });
      pairingKey = result.worker_key;
      pairingNote = 'Key created. Copy it now; it is not saved in this browser.';
      await refreshUsage();
    } catch (cause) { pairingNote = `Pairing failed: ${cause.message}`; }
    render();
  });
  document.querySelector('#copy-worker-key')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pairingKey); pairingNote = 'Copied. Paste only into your local Terminal command.'; }
    catch { pairingNote = 'Clipboard access failed. Retry in a secure browser context.'; }
    render();
  });
  document.querySelector('#copy-workspace-id')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reportData.workspace_id); window.alert('Workspace ID copied. Put it only in the Render environment setting.'); }
    catch { window.alert('Clipboard access failed. Please try again.'); }
  });
  document.querySelectorAll('[data-chat-task]').forEach((button) => button.addEventListener('click', () => { chatTask = button.dataset.chatTask; if (chatTask !== 'all') chatTargetTask = chatTask; resetChatScroll = true; render(); }));
  document.querySelectorAll('[data-chat-lane]').forEach((button) => button.addEventListener('click', () => { chatLane = button.dataset.chatLane; resetChatScroll = true; render(); }));
  document.querySelectorAll('[data-dm-agent]').forEach((button) => button.addEventListener('click', () => { dmAgent = button.dataset.dmAgent; chatTargetAgent = dmAgent; resetChatScroll = true; render(); }));
  document.querySelector('#chat-agent-filter')?.addEventListener('change', (event) => { chatAgent = event.target.value; resetChatScroll = true; render(); });
  for (const id of editableIds) {
    if (draft[id] !== undefined && document.getElementById(id) && (!id.startsWith('project-') || contextDraftDirty)) document.getElementById(id).value = draft[id];
  }
  if (focused && document.getElementById(focused)) {
    const field = document.getElementById(focused);
    field.focus();
    field.setSelectionRange(...selection);
  }
  const feed = document.querySelector('.chat-feed');
  if (feed) {
    feed.scrollTop = resetChatScroll || wasAtBottom ? feed.scrollHeight : oldScroll;
    resetChatScroll = false;
  }
  lastRenderedSignature = signature();
}

async function refresh() {
  await authReady;
  if (authStatus?.enabled && !authStatus.authenticated) { render(); return; }
  try {
    const state = await request('/api/state');
    data = { ...state, messages: Array.isArray(state.messages) ? state.messages : [] };
    error = '';
    connection = 'connected';
  } catch (cause) {
    error = `Could not reach the operations backend: ${cause.message}`;
    connection = 'disconnected';
  }
  const typing = ['title', 'brief', 'owner-question', 'project-goal', 'project-notes'].includes(document.activeElement?.id) || document.activeElement?.id?.startsWith('decision-note-');
  if (!busy && !typing && signature() !== lastRenderedSignature) render();
}

async function refreshUsage() {
  await authReady;
  if (authStatus?.enabled && !authStatus.authenticated) return;
  try {
    usageData = await request('/api/usage');
    usageError = '';
  } catch (cause) {
    usageError = `Could not load worker usage: ${cause.message}`;
  }
  const typing = ['title', 'brief', 'owner-question', 'project-goal', 'project-notes'].includes(document.activeElement?.id) || document.activeElement?.id?.startsWith('decision-note-');
  if (!busy && !typing && signature() !== lastRenderedSignature) render();
}

async function refreshReports() {
  await authReady;
  if (authStatus?.enabled && !authStatus.authenticated) return;
  try { reportData = await request('/api/reports'); }
  catch { reportData = null; }
  if (!busy && signature() !== lastRenderedSignature) render();
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

async function refreshContext() {
  await authReady;
  if (authStatus?.enabled && !authStatus.authenticated) return;
  try { contextData = await request('/api/context'); }
  catch (cause) { error = `Could not load project memory: ${cause.message}`; }
  if (!['owner-question', 'project-goal', 'project-notes'].includes(document.activeElement?.id) && signature() !== lastRenderedSignature) render();
}

async function saveContext(event) {
  event.preventDefault();
  busy = true;
  try {
    contextData = await request('/api/context', { method: 'POST', body: JSON.stringify({
      mission: document.querySelector('#project-goal').value.trim(), notes: document.querySelector('#project-notes').value.trim(),
    }) });
    contextDraftDirty = false;
    contextNote = 'Saved for future Claude runs.';
    error = '';
  } catch (cause) { error = cause.message; contextNote = ''; }
  finally { busy = false; render(); }
}

async function askClaude(event) {
  event.preventDefault();
  const taskId = document.querySelector('#chat-task-picker').value;
  const field = document.querySelector('#owner-question');
  const message = field.value.trim();
  if (!taskId || !message) return;
  busy = true;
  try {
    await request('/api/chat', { method: 'POST', body: JSON.stringify({ task_id: taskId, message, agent_id: chatTargetAgent }) });
    field.value = '';
    chatTask = taskId;
    chatTargetTask = taskId;
    dmAgent = chatTargetAgent;
    chatLane = 'direct';
    resetChatScroll = true;
    error = '';
    await refresh();
  } catch (cause) { error = cause.message; }
  finally { busy = false; render(); }
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

async function runClaude(id) {
  busy = true;
  try {
    await request(`/api/tasks/${id}/start-claude`, { method: 'POST' });
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

async function runTeam(id) {
  busy = true;
  try {
    await request(`/api/tasks/${id}/start-team`, { method: 'POST' });
    selectedTask = id;
    error = '';
    await refresh();
  } catch (cause) { error = cause.message; }
  finally { busy = false; render(); }
}

async function runReview(id) {
  busy = true;
  try {
    await request(`/api/tasks/${id}/start-review`, { method: 'POST' });
    error = '';
    await refresh();
  } catch (cause) { error = cause.message; }
  finally { busy = false; render(); }
}

async function ownerDecision(event) {
  event.preventDefault();
  const decision = event.submitter?.value;
  const id = event.currentTarget.dataset.decisionTask;
  const note = event.currentTarget.querySelector('textarea').value.trim();
  if (decision === 'revise' && note.length < 3) { error = 'Please describe what the researcher should change.'; render(); return; }
  busy = true;
  try {
    await request(`/api/tasks/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision, note }) });
    error = '';
    await refresh();
  } catch (cause) { error = cause.message; }
  finally { busy = false; render(); }
}

window.addEventListener('hashchange', () => {
  render();
  refreshUsage();
  refreshReports();
  const anchor = location.hash.slice(1);
  requestAnimationFrame(() => {
    if (anchor === 'tasks' || anchor === 'activity') document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth' });
    else window.scrollTo({ top: 0 });
  });
});

render();
refresh();
refreshUsage();
refreshReports();
refreshContext();
setInterval(() => { if (!document.hidden) refresh(); }, 1500);
setInterval(() => { if (!document.hidden) refreshUsage(); }, 30000);
setInterval(() => { if (!document.hidden) refreshReports(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refresh(); refreshUsage(); refreshReports(); }
});
