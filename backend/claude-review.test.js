import assert from 'node:assert/strict';
import test from 'node:test';
import { claimClaudeReview, completeClaudeReview, decideReview, failClaudeReview, queueClaudeReview, reviewVerdict } from './claude-review.js';

function fixture() {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const memory = new Map([['owner', { tasks: [{ id: taskId, title: 'Check the claim', brief: 'Use primary sources', status: 'review_queued' }],
    messages: [{ id: 1, task_id: taskId, kind: 'finding', summary: 'A draft claim with a primary-source link.', evidence_refs: ['https://example.org/source'], demo: false }],
    events: [], usage: [], nextId: 1, nextMessageId: 2 }]]);
  return { taskId, memory, state: memory.get('owner') };
}

const result = (leaseToken, verdict, requestId) => ({ lease_token: leaseToken, summary: `VERDICT: ${verdict}\nChecked sources: https://example.org/source\nSupported claims: the bounded claim is supported.\nLimitations: wider novelty unproven.`,
  model: 'claude-test', request_id: requestId, evidence_refs: ['https://example.org/source'],
  usage: { input_tokens: 42, output_tokens: 14, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 } });

test('a separate review is leased, measured, and still needs owner approval', async () => {
  const { taskId, memory, state } = fixture();
  assert.equal(await decideReview(null, memory, 'owner', taskId, 'approve', ''), false);
  const review = await claimClaudeReview(null, memory, 'owner');
  assert.equal(review.draft, 'A draft claim with a primary-source link.');
  assert.equal('context' in review, false);
  assert.equal(await completeClaudeReview(null, memory, 'owner', taskId,
    result('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ACCEPT', '22222222-2222-4222-8222-222222222222')), false);
  assert.equal(await completeClaudeReview(null, memory, 'owner', taskId,
    result(review.lease_token, 'ACCEPT', '22222222-2222-4222-8222-222222222222')), true);
  assert.equal(state.tasks[0].status, 'review_accepted');
  assert.equal(state.messages.at(-1).agent_id, 'Quality reviewer');
  assert.equal(state.usage[0].agent_id, 'Quality reviewer');
  assert.equal(await decideReview(null, memory, 'owner', taskId, 'approve', 'Proceed only with further user validation.'), true);
  assert.equal(state.tasks[0].status, 'approved');
  assert.equal(state.messages.at(-1).agent_id, 'Owner');
  assert.equal(await decideReview(null, memory, 'owner', taskId, 'approve', ''), false);
});

test('review defects require revision and a failed review can be retried', async () => {
  const { taskId, memory, state } = fixture();
  const first = await claimClaudeReview(null, memory, 'owner');
  assert.equal(await failClaudeReview(null, memory, 'owner', taskId, first.lease_token, 'timeout'), true);
  assert.equal(state.tasks[0].status, 'review_failed');
  assert.equal(await queueClaudeReview(null, memory, 'owner', taskId), true);
  const second = await claimClaudeReview(null, memory, 'owner');
  assert.equal(await completeClaudeReview(null, memory, 'owner', taskId,
    result(second.lease_token, 'REVISE', '33333333-3333-4333-8333-333333333333')), true);
  assert.equal(state.tasks[0].status, 'review_revision');
  assert.equal(await decideReview(null, memory, 'owner', taskId, 'approve', ''), false);
});

test('only a first-line verdict is accepted', () => {
  assert.equal(reviewVerdict('VERDICT: BLOCK\nNo source found.'), 'block');
  assert.throws(() => reviewVerdict('I think this is fine.\nVERDICT: ACCEPT'), /Review must begin/);
});

test('accepted review requires a checked source link', async () => {
  const { taskId, memory } = fixture();
  const task = await claimClaudeReview(null, memory, 'owner');
  await assert.rejects(completeClaudeReview(null, memory, 'owner', taskId, {
    ...result(task.lease_token, 'ACCEPT', '44444444-4444-4444-8444-444444444444'), evidence_refs: [],
  }), /checked source/);
});
