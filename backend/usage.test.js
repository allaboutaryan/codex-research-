import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAnthropicUsage, normalizeOpenAIUsage, summarizeUsage } from './usage.js';
import { readUsage, recordUsage } from './usage-store.js';

test('OpenAI cached and reasoning tokens are subsets, not extra tokens', () => {
  const usage = normalizeOpenAIUsage({
    input_tokens: 100,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens_details: { reasoning_tokens: 10 },
  });
  assert.deepEqual(usage, { input_tokens: 100, output_tokens: 30, cached_input_tokens: 40, cache_write_tokens: 0, reasoning_output_tokens: 10 });
  assert.equal(summarizeUsage([{ ...usage, provider: 'openai', agent_id: 'CTO' }]).total.totalTokens, 130);
  assert.throws(() => normalizeOpenAIUsage({ input_tokens: -1, output_tokens: 1 }));
});

test('Claude cache reads and writes count toward total input once', () => {
  const usage = normalizeAnthropicUsage({ input_tokens: 50, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 20 });
  assert.deepEqual(usage, { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, cache_write_tokens: 10, reasoning_output_tokens: 0 });
  assert.equal(summarizeUsage([{ ...usage, provider: 'anthropic', agent_id: 'Research worker' }]).total.totalTokens, 120);
});

test('usage ledger is per workspace, task-linked, and idempotent', async () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const memory = new Map([
    ['owner', { tasks: [{ id: taskId }], usage: [] }],
    ['other', { tasks: [], usage: [] }],
  ]);
  const entry = { task_id: taskId, agent_id: 'Research worker', provider: 'anthropic', model: 'claude-test', request_id: 'session_12345',
    input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, cache_write_tokens: 10, reasoning_output_tokens: 0 };
  assert.equal(await recordUsage(null, memory, 'owner', entry), true);
  assert.equal(await recordUsage(null, memory, 'owner', entry), false);
  assert.equal((await readUsage(null, memory, 'owner')).summary.total.calls, 1);
  assert.equal((await readUsage(null, memory, 'other')).summary.total.calls, 0);
  await assert.rejects(recordUsage(null, memory, 'other', entry), /Task does not belong/);
  await assert.rejects(recordUsage(null, memory, 'owner', { ...entry, agent_id: 'CTO' }), /worker route/);
});
