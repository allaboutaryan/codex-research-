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
    model: 'claude-test', request_id: '22222222-2222-4222-8222-222222222222', evidence_refs: [],
    usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }) });
  assert.equal(complete.status, 200);
  const state = await (await browser('/api/state')).json();
  assert.equal(state.tasks[0].status, 'awaiting_review');
  assert.equal(state.messages[0].demo, false);
  assert.equal('claude_lease_token' in state.tasks[0], false);
  const usage = await (await browser('/api/usage')).json();
  assert.equal(usage.summary.total.totalTokens, 30);
  assert.equal(usage.connections.find((item) => item.provider === 'anthropic').status, 'online');
});
