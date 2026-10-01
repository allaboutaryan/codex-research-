import assert from 'node:assert/strict';
import test from 'node:test';
import { claimClaudeTask, completeClaudeTask, failClaudeTask, heartbeatClaudeWorker, pairClaudeWorker, queueClaudeTask, workspaceForWorkerKey } from './claude-jobs.js';
import { readUsage } from './usage-store.js';

const taskId = '11111111-1111-4111-8111-111111111111';

function workspace() {
  return new Map([['owner', { tasks: [{ id: taskId, title: 'Find developer pain points', brief: 'Use primary sources', status: 'queued', claude_attempts: 0 }],
    events: [], messages: [], usage: [], nextId: 1, nextMessageId: 1 }]]);
}

test('Claude task moves from queued to independent QA with measured usage', async () => {
  const memory = workspace();
  const workerKey = await pairClaudeWorker(null, memory, 'owner');
  assert.equal(await workspaceForWorkerKey(null, memory, workerKey), 'owner');
  assert.equal((await readUsage(null, memory, 'owner')).connections.find((item) => item.provider === 'anthropic').status, 'paired_offline');
  assert.equal(await queueClaudeTask(null, memory, 'owner', taskId), true);
  assert.equal(await queueClaudeTask(null, memory, 'owner', taskId), false);
  await heartbeatClaudeWorker(null, memory, 'owner');
  assert.equal((await readUsage(null, memory, 'owner')).connections.find((item) => item.provider === 'anthropic').status, 'online');
  const claimed = await claimClaudeTask(null, memory, 'owner');
  assert.equal(claimed.id, taskId);
  assert.equal(await claimClaudeTask(null, memory, 'owner'), null);
  const result = { lease_token: claimed.lease_token, summary: 'Search approach: checked an official paper. Findings: one tentative gap. QA must verify.',
    model: 'claude-sonnet-test', request_id: '22222222-2222-4222-8222-222222222222', evidence_refs: ['https://example.org/paper'],
    usage: { input_tokens: 100, output_tokens: 40, cached_input_tokens: 20, cache_write_tokens: 10, reasoning_output_tokens: 5 } };
  assert.equal(await completeClaudeTask(null, memory, 'owner', taskId, result), true);
  assert.equal(memory.get('owner').tasks[0].status, 'review_queued');
  assert.equal(memory.get('owner').messages[0].demo, false);
  assert.equal((await readUsage(null, memory, 'owner')).summary.total.totalTokens, 140);
  assert.equal(await completeClaudeTask(null, memory, 'owner', taskId, result), false);
});

test('pairing rotation revokes the old worker key', async () => {
  const memory = workspace();
  const oldKey = await pairClaudeWorker(null, memory, 'owner');
  const newKey = await pairClaudeWorker(null, memory, 'owner');
  assert.equal(await workspaceForWorkerKey(null, memory, oldKey), null);
  assert.equal(await workspaceForWorkerKey(null, memory, newKey), 'owner');
});

test('source-free research stops before QA and can be retried', async () => {
  const memory = workspace();
  await queueClaudeTask(null, memory, 'owner', taskId);
  const claimed = await claimClaudeTask(null, memory, 'owner');
  assert.equal(await completeClaudeTask(null, memory, 'owner', taskId, {
    lease_token: claimed.lease_token, summary: 'Web research was unavailable, so I cannot cite a source or make a supported finding.',
    model: 'claude-sonnet-test', request_id: 'source-free-result-1', evidence_refs: [],
    usage: { input_tokens: 10, output_tokens: 10, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }), true);
  assert.equal(memory.get('owner').tasks[0].status, 'research_blocked');
  assert.equal(memory.get('owner').messages[0].kind, 'blocker');
  assert.equal(await queueClaudeTask(null, memory, 'owner', taskId), true);
});

test('wrong lease cannot submit or fail a task', async () => {
  const memory = workspace();
  await queueClaudeTask(null, memory, 'owner', taskId);
  await claimClaudeTask(null, memory, 'owner');
  assert.equal(await failClaudeTask(null, memory, 'owner', taskId, 'wrong', 'model_error'), false);
  assert.equal(memory.get('owner').tasks[0].status, 'claude_running');
});
