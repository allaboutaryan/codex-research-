import { cleanCard, composeHelpRequest, issuePreview, parseRepositoryInput, safeGitHubUrl } from './logic.mjs';

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const cardStoreKey = 'northstar-contributor-cards-v1';
const sessionStoreKey = 'northstar-contributor-sessions-v1';
const state = { parsed: null, repository: null, profile: null, issues: [], selected: null, loading: false, error: '', remaining: null, loadedAt: null, session: null };
let requestId = 0;

function readStore(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

function saveStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function cardKey() { return `${state.parsed.fullName.toLowerCase()}#${state.selected.number}`; }
function selectedCard() { return state.selected ? readStore(cardStoreKey)[cardKey()] || null : null; }
function selectedSession() { return state.selected ? readStore(sessionStoreKey)[cardKey()] || null : null; }
function issueUrl(issue) { return `https://github.com/${state.parsed.fullName}/issues/${issue.number}`; }
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function status(message, error = false) {
  const target = $('#status');
  target.textContent = message;
  target.classList.toggle('is-error', error);
}

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(12000),
  });
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  if (Number.isFinite(remaining)) state.remaining = remaining;
  if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting public requests from this connection. Try again after its rate limit resets.');
  if (response.status === 404) throw new Error('That public repository was not found. Check the owner and repository name.');
  if (!response.ok) throw new Error(`GitHub could not load this project (${response.status}).`);
  return response.json();
}

async function loadRepository(value) {
  let parsed;
  try { parsed = parseRepositoryInput(value); }
  catch (error) { status(error.message, true); return; }
  const thisRequest = ++requestId;
  state.loading = true;
  state.error = '';
  state.parsed = parsed;
  state.repository = null;
  state.profile = null;
  state.issues = [];
  state.selected = null;
  status('Loading public GitHub data…');
  render();
  try {
    const base = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
    const [repository, issues, profile] = await Promise.all([
      github(base),
      github(`${base}/issues?state=open&labels=good%20first%20issue&per_page=12`),
      github(`${base}/community/profile`).catch(() => null),
    ]);
    if (thisRequest !== requestId) return;
    state.repository = repository;
    state.profile = profile;
    state.issues = Array.isArray(issues) ? issues.filter((item) => !item.pull_request) : [];
    state.selected = state.issues.find((item) => item.number === parsed.issueNumber) || state.issues[0] || null;
    state.loadedAt = new Date();
    state.session = selectedSession();
    const count = state.issues.length;
    status(`${count} open “good first issue” ${count === 1 ? 'item' : 'items'} shown · Public data fetched ${state.loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${state.remaining !== null ? ` · ${state.remaining} GitHub requests remaining` : ''}`);
  } catch (error) {
    if (thisRequest !== requestId) return;
    state.error = error.name === 'TimeoutError' ? 'GitHub did not respond in time. Please try again.' : error.message;
    status(state.error, true);
  } finally {
    if (thisRequest === requestId) { state.loading = false; render(); }
  }
}

function sourceLink(value, label) {
  const url = safeGitHubUrl(value);
  return url ? `<a class="source-link" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)} <span aria-hidden="true">↗</span></a>` : '';
}

function renderIssue(issue) {
  const assigned = Array.isArray(issue.assignees) && issue.assignees.length > 0;
  return `<button class="issue-button ${state.selected?.number === issue.number ? 'active' : ''}" type="button" data-issue="${issue.number}" aria-pressed="${state.selected?.number === issue.number}">
    <span class="issue-index">#${issue.number} <span class="issue-dot">·</span> ${assigned ? 'Assigned' : 'Unassigned'}</span>
    <strong>${escapeHTML(issue.title)}</strong>
    <small>Updated ${escapeHTML(dateLabel(issue.updated_at))}</small>
  </button>`;
}

function renderCheck(label, description, condition, link = '') {
  return `<li class="check-row"><span class="check-icon ${condition ? 'present' : 'missing'}" aria-hidden="true">${condition ? '✓' : '–'}</span><div><strong>${label}</strong><p>${description}</p>${link}</div></li>`;
}

function renderReadiness() {
  const issue = state.selected;
  if (!issue) return `<section class="card empty-state"><span class="eyebrow">02 / NO STARTER ISSUE FOUND</span><h2>Try another public repository</h2><p>This repository has no open items labeled <code>good first issue</code> in the first page of GitHub’s issue list. We do not invent a recommendation.</p>${sourceLink(`https://github.com/${state.parsed.fullName}/issues`, 'View all project issues')}</section>`;
  const card = selectedCard();
  const session = selectedSession();
  const assigned = Array.isArray(issue.assignees) && issue.assignees.length > 0;
  const readme = thisDocument('readme');
  const contributing = thisDocument('contributing');
  const help = state.repository?.has_discussions ? `https://github.com/${state.parsed.fullName}/discussions` : issueUrl(issue);
  const body = issuePreview(issue.body);
  return `<div class="right-column">
    <section class="card issue-detail"><div class="section-head"><div><span class="eyebrow">02 / UNDERSTAND THE TASK</span><h2>${escapeHTML(issue.title)}</h2></div><span class="state-pill ${assigned ? 'caution' : ''}">${assigned ? 'Already assigned' : 'Open · unassigned'}</span></div><p class="issue-desc">${escapeHTML(body || 'No issue description is available here. Open the issue and ask for context before starting.')}${body.length === 460 ? '…' : ''}</p><div class="link-row">${sourceLink(issueUrl(issue), 'Read full issue')}${sourceLink(`https://github.com/${state.parsed.fullName}/contribute`, 'GitHub contribute page')}</div><p class="caution-text">${assigned ? 'Someone is assigned. Ask the maintainer before beginning work.' : 'Unassigned does not guarantee the maintainer is ready to review. Check the issue conversation first.'}</p></section>
    <section class="card"><div class="section-head"><div><span class="eyebrow">03 / CHECK YOUR PATH</span><h2>Contribution readiness</h2></div><span class="state-pill">No automatic scoring</span></div><p class="section-intro">These are signals and links, not a promise that a first PR will be accepted.</p><ol class="checklist">
      ${renderCheck('A live starting point', `Issue #${issue.number} is open and labeled “good first issue” on GitHub.`, true, sourceLink(issueUrl(issue), 'Check latest issue state'))}
      ${renderCheck('Project instructions', contributing ? 'A contribution guide is listed in GitHub’s community profile.' : 'No contribution guide appeared in GitHub’s community profile. Look for instructions in the repository.', Boolean(contributing), `${sourceLink(contributing, 'Contribution guide')}${sourceLink(readme, 'README')}`)}
      ${renderCheck('A checked setup and test path', card?.checkedAt ? `Marked checked on this device ${dateLabel(card.checkedAt)}. This is self-attested, not a maintainer endorsement.` : 'Not checked yet. A facilitator or maintainer can record steps below after personally testing them.', Boolean(card?.checkedAt), '')}
      ${renderCheck('A human help route', state.repository?.has_discussions ? 'This repository has GitHub Discussions enabled.' : 'Use the issue conversation for questions unless the project guide says otherwise.', true, sourceLink(help, state.repository?.has_discussions ? 'Open Discussions' : 'Open issue conversation'))}
    </ol></section>
    <section class="card setup-card"><div class="section-head"><div><span class="eyebrow">04 / DOCUMENT THE SETUP</span><h2>Local setup card</h2></div><span class="state-pill ${card?.checkedAt ? 'checked' : ''}">${card?.checkedAt ? 'Checked on this device' : 'Unverified draft'}</span></div><p class="section-intro">Copy commands only from the project’s own instructions; inspect them before running. This page never executes code, and these notes stay in this browser.</p>
      ${card?.prerequisite ? `<div class="saved-step"><small>PREREQUISITE</small><p>${escapeHTML(card.prerequisite)}</p></div>` : ''}
      ${card?.setup ? `<div class="saved-step"><small>SETUP STEP</small><pre>${escapeHTML(card.setup)}</pre></div>` : ''}
      ${card?.test ? `<div class="saved-step"><small>TEST STEP</small><pre>${escapeHTML(card.test)}</pre></div>` : ''}
      <details class="editor"><summary>${card ? 'Edit local card' : 'Add setup and test steps'} <span aria-hidden="true">+</span></summary><form id="card-form" class="form-stack"><label for="prerequisite">Prerequisite or note</label><textarea id="prerequisite" name="prerequisite" maxlength="300" placeholder="e.g. Node version named in the project guide">${escapeHTML(card?.prerequisite || '')}</textarea><label for="setup">Setup command or step</label><textarea id="setup" name="setup" maxlength="500" placeholder="Exact step you personally checked">${escapeHTML(card?.setup || '')}</textarea><label for="test">Test command or step</label><textarea id="test" name="test" maxlength="500" placeholder="Exact test you personally checked">${escapeHTML(card?.test || '')}</textarea><label class="checkbox-label"><input type="checkbox" name="checked" /> I personally checked these steps for this project</label><button type="submit">Save on this device</button></form></details></section>
    <section class="card help-card"><span class="eyebrow">05 / WHEN YOU GET STUCK</span><h2>Ask a focused question</h2><p class="section-intro">Write a short, safe summary. We only copy it; you decide whether and where to post it. Never include tokens, passwords, private URLs, or raw logs.</p><form id="help-form" class="form-stack"><label for="stage">Which step blocked you?</label><select id="stage" name="stage"><option>Understanding the task</option><option>Setting up</option><option>Running tests</option><option>Getting feedback</option></select><label for="note">What happened?</label><textarea id="note" name="note" minlength="10" maxlength="400" placeholder="Describe the command or step and the result, without secrets or raw logs."></textarea><div class="action-row"><button type="submit">Copy help request</button>${sourceLink(help, state.repository?.has_discussions ? 'Choose a Discussion' : 'Open issue conversation')}</div></form></section>
    <section class="card session-card"><span class="eyebrow">06 / LEARN FROM A REAL TEST</span><h2>Measure the first step</h2><p class="section-intro">For a usability session, record whether the contributor can reach a passing test and identify whom to ask. This is self-reported and stays on this device.</p>${renderSession(session)}</section>
  </div>`;
}

function thisDocument(kind) { return safeGitHubUrl(state.profile?.files?.[kind]?.html_url); }

function renderSession(session) {
  if (!session) return '<button type="button" data-action="start-session" class="secondary-button">Start a local test session</button>';
  const minutes = session.finishedAt ? Math.max(0, Math.round((new Date(session.finishedAt) - new Date(session.startedAt)) / 60000)) : null;
  if (session.finishedAt) return `<div class="session-result"><strong>Session recorded · ${minutes} min</strong><p>Passing test: ${session.passingTest ? 'yes' : 'no'} · Knows who to ask: ${session.knowsContact ? 'yes' : 'no'}</p><button type="button" data-action="copy-session" class="secondary-button">Copy anonymous summary</button><button type="button" data-action="start-session" class="text-button">Start another</button></div>`;
  return `<div class="session-active"><p>Started ${escapeHTML(new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}. Finish when the participant stops or reaches both goals.</p><label class="checkbox-label"><input id="passing-test" type="checkbox" ${session.passingTest ? 'checked' : ''} /> I reached a passing test</label><label class="checkbox-label"><input id="knows-contact" type="checkbox" ${session.knowsContact ? 'checked' : ''} /> I know whom to ask next</label><button type="button" data-action="finish-session">Finish and save locally</button></div>`;
}

function render() {
  const target = $('#workspace');
  if (state.loading) { target.innerHTML = '<div class="loading-card">Checking the repository, starter issues, and contribution guide…</div>'; return; }
  if (state.error) { target.innerHTML = `<div class="loading-card error-card"><h2>Could not load this project</h2><p>${escapeHTML(state.error)}</p></div>`; return; }
  if (!state.repository) { target.innerHTML = '<div class="loading-card">Enter a public repository to begin.</div>'; return; }
  target.innerHTML = `<aside class="left-column"><div class="repo-card"><span class="eyebrow">REPOSITORY SNAPSHOT</span><h2>${escapeHTML(state.repository.full_name || state.parsed.fullName)}</h2><p>${escapeHTML(state.repository.description || 'No public description supplied.')}</p><div class="link-row">${sourceLink(`https://github.com/${state.parsed.fullName}`, 'Open on GitHub')}</div></div><div class="issue-list"><div class="issue-list-head"><span class="eyebrow">OPEN STARTER ISSUES</span><small>${state.issues.length} shown</small></div>${state.issues.length ? state.issues.map(renderIssue).join('') : '<p class="list-empty">No open “good first issue” items surfaced. Try another repository.</p>'}</div><p class="source-note">Source: public GitHub API. This list is not a recommendation or guarantee of availability.</p></aside>${renderReadiness()}`;
}

$('#repo-form').addEventListener('submit', (event) => { event.preventDefault(); loadRepository($('#repo-input').value); });
document.addEventListener('click', async (event) => {
  const issueButton = event.target.closest('[data-issue]');
  if (issueButton) {
    state.selected = state.issues.find((item) => item.number === Number(issueButton.dataset.issue)) || null;
    state.session = selectedSession();
    render();
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || !state.selected) return;
  try {
    if (action === 'start-session') {
      const sessions = readStore(sessionStoreKey);
      sessions[cardKey()] = { startedAt: new Date().toISOString(), passingTest: false, knowsContact: false, finishedAt: null };
      saveStore(sessionStoreKey, sessions);
      render();
      status('Local test session started. No data was sent to Northstar.');
    } else if (action === 'finish-session') {
      const sessions = readStore(sessionStoreKey);
      const session = sessions[cardKey()];
      if (!session || session.finishedAt) return;
      sessions[cardKey()] = { ...session, passingTest: $('#passing-test').checked, knowsContact: $('#knows-contact').checked, finishedAt: new Date().toISOString() };
      saveStore(sessionStoreKey, sessions);
      render();
      status('Session summary saved in this browser only.');
    } else if (action === 'copy-session') {
      const session = selectedSession();
      if (!session?.finishedAt) return;
      const minutes = Math.max(0, Math.round((new Date(session.finishedAt) - new Date(session.startedAt)) / 60000));
      await navigator.clipboard.writeText(`Contributor Readiness pilot test\nRepository: ${state.parsed.fullName}\nIssue: #${state.selected.number}\nDuration: ${minutes} minutes\nReached passing test: ${session.passingTest ? 'yes' : 'no'}\nKnows whom to ask: ${session.knowsContact ? 'yes' : 'no'}\nSelf-reported; no personal data included.`);
      status('Anonymous session summary copied.');
    }
  } catch { status('This browser could not save or copy the local result. Check storage or clipboard permission.', true); }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'card-form') {
    event.preventDefault();
    try {
      const form = new FormData(event.target);
      const card = cleanCard({ prerequisite: form.get('prerequisite'), setup: form.get('setup'), test: form.get('test'), checked: form.has('checked') });
      const cards = readStore(cardStoreKey);
      cards[cardKey()] = card;
      saveStore(cardStoreKey, cards);
      render();
      status(card.checkedAt ? 'Setup card marked checked on this device.' : 'Unverified setup draft saved on this device.');
    } catch (error) { status(error.message || 'Could not save this card.', true); }
  } else if (event.target.id === 'help-form') {
    event.preventDefault();
    try {
      const form = new FormData(event.target);
      const message = composeHelpRequest({ fullName: state.parsed.fullName, issueNumber: state.selected.number, stage: form.get('stage'), note: form.get('note') });
      await navigator.clipboard.writeText(message);
      status('Question copied. Review it before posting to the project.');
    } catch (error) { status(error.message || 'Could not copy the help request.', true); }
  }
});

const initialRepo = new URLSearchParams(location.search).get('repo') || $('#repo-input').value;
$('#repo-input').value = initialRepo;
loadRepository(initialRepo);
