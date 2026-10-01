import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt, parseClaudeResult } from './claude-worker.js';

test('Claude Code result becomes a safe usage record and source links', () => {
  const parsed = parseClaudeResult(JSON.stringify({
    is_error: false, session_id: '22222222-2222-4222-8222-222222222222',
    result: 'Search approach: official sources. Finding: https://example.org/paper. Candidate gap remains a hypothesis.',
    modelUsage: { 'claude-sonnet-test': {} },
    usage: { input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 20,
      output_tokens: 40, output_tokens_details: { thinking_tokens: 10 } },
  }));
  assert.equal(parsed.usage.input_tokens, 150);
  assert.equal(parsed.usage.reasoning_output_tokens, 10);
  assert.deepEqual(parsed.evidence_refs, ['https://example.org/paper']);
  assert.equal(parsed.model, 'claude-sonnet-test');
});

test('task prompt is bounded and failed Claude output is rejected', () => {
  assert.match(buildPrompt({ title: 'Test question', brief: 'Use 2020–2026' }), /Test question/);
  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: '' })), /invalid_output/);
});
