import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('browser and local Claude worker have separate permissions', async (context) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT: '0', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  context.after(() => child.kill('SIGTERM'));
  const port = await new Promise((resolvePort, rejectPort) => {
    let output = '';
    const timeout = setTimeout(() => rejectPort(new Error('API did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on (\d+)/);
      if (match) { clearTimeout(timeout); resolvePort(Number(match[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timeout); rejectPort(new Error(`API exited: ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const workspaceKey = 'a'.repeat(64);
  const browser = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', 'x-workspace-key': workspaceKey } });
  const task = await (await browser('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Find an official source', brief: 'Pilot only' }) })).json();
  assert.ok(task.id);
  assert.equal((await browser(`/api/tasks/${task.id}/start-claude`, { method: 'POST' })).status, 200);
  assert.equal((await browser('/api/worker/claude/claim', { method: 'POST' })).status, 401);
  const paired = await (await browser('/api/worker/claude/pair', { method: 'POST' })).json();
  assert.match(paired.worker_key, /^[a-f0-9]{64}$/);
  const worker = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', 'x-worker-key': paired.worker_key } });
  assert.equal((await worker('/api/state')).status, 401);
  assert.equal((await worker('/api/worker/claude/heartbeat', { method: 'POST' })).status, 200);
  const claimed = await (await worker('/api/worker/claude/claim', { method: 'POST' })).json();
  assert.equal(claimed.task.id, task.id);
  const complete = await worker(`/api/worker/claude/${task.id}/complete`, { method: 'POST', body: JSON.stringify({
    lease_token: claimed.task.lease_token, summary: 'Official source checked; finding is tentative and awaits independent QA.',
    model: 'claude-test', request_id: '22222222-2222-4222-8222-222222222222', evidence_refs: ['https://example.org/source'],
    usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }) });
  assert.equal(complete.status, 200);
  const state = await (await browser('/api/state')).json();
  assert.equal(state.tasks[0].status, 'review_queued');
  assert.equal(state.messages[0].demo, false);
  assert.equal('claude_lease_token' in state.tasks[0], false);
  const reports = await (await browser('/api/reports')).json();
  assert.deepEqual(reports.alerts, []);
  assert.deepEqual(reports.reports, []);
  assert.match(reports.workspace_id, /^[a-f0-9]{64}$/);
  assert.equal(reports.delivery, 'not_configured');
  assert.equal((await worker('/api/reports')).status, 401);
  const usage = await (await browser('/api/usage')).json();
  assert.equal(usage.summary.total.totalTokens, 30);
  assert.equal(usage.connections.find((item) => item.provider === 'anthropic').status, 'online');
  assert.equal((await browser('/api/context', { method: 'POST', body: JSON.stringify({
    mission: 'Research a useful, durable software product before choosing what to build.', notes: 'Keep findings traceable.',
  }) })).status, 200);
  assert.equal((await worker('/api/context')).status, 401);
  const asked = await (await browser('/api/chat', { method: 'POST', body: JSON.stringify({ task_id: task.id, message: 'What do we know so far?' }) })).json();
  assert.ok(asked.id);
  assert.equal((await worker('/api/chat', { method: 'POST', body: JSON.stringify({ task_id: task.id, message: 'Forged owner question' }) })).status, 401);
  const chatClaim = await (await worker('/api/worker/claude/claim-chat', { method: 'POST' })).json();
  assert.equal(chatClaim.job.id, asked.id);
  assert.match(chatClaim.job.context.project_goal, /durable software product/);
  assert.equal(chatClaim.job.context.recent_task_history[0].kind, 'finding');
  const chatComplete = await worker(`/api/worker/claude/chat/${asked.id}/complete`, { method: 'POST', body: JSON.stringify({
    lease_token: chatClaim.job.lease_token, summary: 'We have a tentative draft, but no independent QA has accepted its finding yet.',
    model: 'claude-test', request_id: '33333333-3333-4333-8333-333333333333', evidence_refs: [],
    usage: { input_tokens: 30, output_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }) });
  assert.equal(chatComplete.status, 200);
  const withChat = await (await browser('/api/state')).json();
  assert.equal(withChat.chatJobs[0].status, 'complete');
  assert.equal(withChat.messages[0].kind, 'answer');
  assert.equal((await (await browser('/api/usage')).json()).summary.total.totalTokens, 80);
  assert.equal((await browser('/api/worker/claude/claim-review', { method: 'POST' })).status, 401);
  assert.equal((await worker(`/api/tasks/${task.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })).status, 401);
  const reviewClaim = await (await worker('/api/worker/claude/claim-review', { method: 'POST' })).json();
  assert.equal(reviewClaim.task.id, task.id);
  assert.match(reviewClaim.task.draft, /Official source checked/);
  assert.equal('context' in reviewClaim.task, false);
  const reviewed = await worker(`/api/worker/claude/review/${task.id}/complete`, { method: 'POST', body: JSON.stringify({
    lease_token: reviewClaim.task.lease_token,
    summary: 'VERDICT: ACCEPT\nChecked sources: https://example.org/source\nSupported claims: bounded finding only.\nLimitations: no broad novelty claim.',
    model: 'claude-test', request_id: '44444444-4444-4444-8444-444444444444', evidence_refs: ['https://example.org/source'],
    usage: { input_tokens: 40, output_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }) });
  assert.equal(reviewed.status, 200);
  assert.equal((await (await browser('/api/state')).json()).tasks[0].status, 'review_accepted');
  assert.equal((await browser(`/api/tasks/${task.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approve', note: 'Approved after reading the review.' }) })).status, 200);
  const approved = await (await browser('/api/state')).json();
  assert.equal(approved.tasks[0].status, 'approved');
  assert.match(approved.reviewPackets[task.id].draft.summary, /Official source checked/);
  assert.match(approved.reviewPackets[task.id].review.summary, /VERDICT: ACCEPT/);
  assert.equal(approved.messages[0].agent_id, 'Owner');
  assert.equal((await (await browser('/api/usage')).json()).summary.total.totalTokens, 140);
});
