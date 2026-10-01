export const workerRoutes = Object.freeze([
  { agent: 'CTO', worker: 'Claude', provider: 'anthropic', reason: 'Final synthesis and owner reporting through a separate local call' },
  { agent: 'Project manager', worker: 'Claude', provider: 'anthropic', reason: 'Scope, acceptance criteria, and coordination through a separate local call' },
  { agent: 'Team lead', worker: 'Claude', provider: 'anthropic', reason: 'Task decomposition and handoffs through a separate local call' },
  { agent: 'Research worker', worker: 'Claude', provider: 'anthropic', reason: 'Focused evidence gathering and research packets' },
  { agent: 'Quality reviewer', worker: 'Claude', provider: 'anthropic', reason: 'Separate source-checking pass on the same local subscription' },
]);

export const providerConnections = Object.freeze([
  { provider: 'openai', worker: 'Codex', status: 'not_connected', requirement: 'Approved hosted ChatGPT-plan OAuth access, or a personal local companion' },
  { provider: 'anthropic', worker: 'Claude', status: 'not_connected', requirement: 'Owner-operated Claude Code or Agent SDK sign-in, subject to Anthropic terms' },
]);

function tokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function normalizeOpenAIUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) throw new Error('OpenAI response has no valid usage');
  const input = tokens(usage.input_tokens);
  const output = tokens(usage.output_tokens);
  const cached = tokens(usage.input_tokens_details?.cached_tokens);
  if (cached > input) throw new Error('OpenAI cached tokens exceed input tokens');
  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_write_tokens: 0,
    reasoning_output_tokens: tokens(usage.output_tokens_details?.reasoning_tokens),
  };
}

export function normalizeAnthropicUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) throw new Error('Anthropic response has no valid usage');
  const uncached = tokens(usage.input_tokens);
  const read = tokens(usage.cache_read_input_tokens);
  const write = tokens(usage.cache_creation_input_tokens);
  const output = tokens(usage.output_tokens);
  const thinking = tokens(usage.output_tokens_details?.thinking_tokens);
  if (thinking > output) throw new Error('Claude thinking tokens exceed output tokens');
  return {
    input_tokens: uncached + read + write,
    output_tokens: output,
    cached_input_tokens: read,
    cache_write_tokens: write,
    reasoning_output_tokens: thinking,
  };
}

export function emptyTotals() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, knownCostUSD: 0, unpricedCalls: 0 };
}

export function summarizeUsage(events) {
  const total = emptyTotals();
  const byProvider = Object.fromEntries(providerConnections.map(({ provider }) => [provider, emptyTotals()]));
  const byAgent = Object.fromEntries(workerRoutes.map(({ agent }) => [agent, emptyTotals()]));
  for (const event of events) {
    const count = event.calls == null ? 1 : tokens(Number(event.calls));
    const groups = [total, byProvider[event.provider], byAgent[event.agent_id]].filter(Boolean);
    for (const group of groups) {
      group.calls += count;
      group.inputTokens += tokens(Number(event.input_tokens));
      group.outputTokens += tokens(Number(event.output_tokens));
      group.cachedInputTokens += tokens(Number(event.cached_input_tokens));
      group.cacheWriteTokens += tokens(Number(event.cache_write_tokens));
      group.reasoningOutputTokens += tokens(Number(event.reasoning_output_tokens));
      group.totalTokens = group.inputTokens + group.outputTokens;
      if (event.unpriced_calls != null) {
        group.unpricedCalls += tokens(Number(event.unpriced_calls));
        group.knownCostUSD += Number(event.known_cost_usd || 0);
      } else if (event.cost_usd == null) group.unpricedCalls += count;
      else group.knownCostUSD += Number(event.cost_usd);
    }
  }
  return { total, byProvider, byAgent };
}
