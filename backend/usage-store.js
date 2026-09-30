import { providerConnections, summarizeUsage, workerRoutes } from './usage.js';

const numericFields = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_output_tokens'];

export async function recordUsage(pool, memory, workspace, entry) {
  const route = workerRoutes.find(({ agent }) => agent === entry.agent_id);
  if (!route || route.provider !== entry.provider) throw new Error('Usage does not match a worker route');
  if (typeof entry.request_id !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(entry.request_id)) throw new Error('A stable request ID is required');
  if (typeof entry.task_id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.task_id)) throw new Error('A task ID is required');
  for (const field of numericFields) {
    if (!Number.isSafeInteger(entry[field]) || entry[field] < 0) throw new Error(`Invalid ${field}`);
  }
  if (entry.cached_input_tokens > entry.input_tokens || entry.cache_write_tokens > entry.input_tokens || entry.reasoning_output_tokens > entry.output_tokens) throw new Error('Usage detail exceeds its total');
  if (!pool) {
    const state = memory.get(workspace);
    if (!state?.tasks.some((task) => task.id === entry.task_id)) throw new Error('Task does not belong to workspace');
    state.usage ||= [];
    if (state.usage.some((event) => event.provider === entry.provider && event.request_id === entry.request_id)) return false;
    state.usage.push({ ...entry, id: state.usage.length + 1, workspace_id: workspace, created_at: new Date().toISOString() });
    return true;
  }
  const result = await pool.query(`
    INSERT INTO usage_events (workspace_id, task_id, agent_id, provider, model, request_id,
      input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, reasoning_output_tokens)
    SELECT $1, id, $3, $4, $5, $6, $7, $8, $9, $10, $11
    FROM tasks WHERE id = $2 AND workspace_id = $1
    ON CONFLICT (workspace_id, provider, request_id) DO NOTHING
    RETURNING id
  `, [workspace, entry.task_id, entry.agent_id, entry.provider, entry.model || '', entry.request_id,
    entry.input_tokens, entry.output_tokens, entry.cached_input_tokens, entry.cache_write_tokens, entry.reasoning_output_tokens]);
  if (!result.rowCount) return false;
  return true;
}

export async function readUsage(pool, memory, workspace) {
  let aggregates;
  let events;
  if (!pool) {
    const all = memory.get(workspace)?.usage || [];
    aggregates = all;
    events = [...all].reverse().slice(0, 100);
  } else {
    const [grouped, recent] = await Promise.all([
      pool.query(`
        SELECT provider, agent_id, count(*)::integer AS calls,
          coalesce(sum(input_tokens), 0)::text AS input_tokens,
          coalesce(sum(output_tokens), 0)::text AS output_tokens,
          coalesce(sum(cached_input_tokens), 0)::text AS cached_input_tokens,
          coalesce(sum(cache_write_tokens), 0)::text AS cache_write_tokens,
          coalesce(sum(reasoning_output_tokens), 0)::text AS reasoning_output_tokens,
          count(*) FILTER (WHERE cost_usd IS NULL)::integer AS unpriced_calls,
          coalesce(sum(cost_usd), 0)::text AS known_cost_usd
        FROM usage_events WHERE workspace_id = $1 GROUP BY provider, agent_id
      `, [workspace]),
      pool.query(`
        SELECT id, task_id, agent_id, provider, model, input_tokens, output_tokens,
          cached_input_tokens, cache_write_tokens, reasoning_output_tokens, cost_usd, created_at
        FROM usage_events WHERE workspace_id = $1 ORDER BY id DESC LIMIT 100
      `, [workspace]),
    ]);
    aggregates = grouped.rows;
    events = recent.rows;
  }
  return {
    scope: 'this_workspace_worker_calls_only',
    mode: 'subscription_oauth_planned',
    connections: providerConnections,
    routes: workerRoutes,
    summary: summarizeUsage(aggregates),
    events,
    note: 'Subscription-wide balances and reset times are not available from this app. Demo handoffs are excluded.',
  };
}
