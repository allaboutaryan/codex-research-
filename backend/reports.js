const timeZone = 'Asia/Kolkata';
const dashboard = 'https://northstar-lab-woad.vercel.app/';
const blocked = new Map([
  ['research_blocked', ['Research has no cited source', 'Research worker stopped before a source-backed draft was ready.']],
  ['claude_failed', ['Research worker failed', 'Restart the local worker or retry this research task.']],
  ['review_failed', ['Quality review failed', 'Restart the local worker or retry QA.']],
  ['review_blocked', ['Quality review blocked', 'Read the QA verdict and decide whether to revise the research.']],
  ['review_revision', ['Research revision needed', 'Read the QA feedback and queue a corrected research run.']],
  ['review_accepted', ['Owner decision needed', 'QA accepted a draft; your approval is still required.']],
]);

export function istDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function afterReportTime(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour >= 18;
}

function dayStart(date) { return new Date(`${date}T00:00:00+05:30`); }
function reportCutoff(date) { return new Date(`${date}T18:00:00+05:30`); }

export function deriveAlerts(tasks, workerSeenAt, reviewPackets = {}, now = new Date()) {
  const workerOnline = workerSeenAt && now.getTime() - new Date(workerSeenAt).getTime() < 60_000;
  const alerts = [];
  for (const task of tasks) {
    let [title, detail] = blocked.get(task.status) || [];
    if (task.status === 'awaiting_review' && !reviewPackets[task.id]?.draft?.evidence_refs?.length) {
      title = 'Research draft has no cited source'; detail = 'This older draft cannot pass QA. Retry research with web access.';
    }
    if (!title && ['claude_queued', 'review_queued'].includes(task.status) && !workerOnline &&
      now.getTime() - new Date(task.updated_at).getTime() >= 10 * 60_000) {
      title = 'Local Claude worker is offline'; detail = 'Queued work has waited at least 10 minutes. Start the worker on your computer.';
    }
    if (!title && ['claude_running', 'review_running'].includes(task.status) &&
      now.getTime() - new Date(task.status === 'claude_running' ? task.claude_lease_expires_at : task.review_lease_expires_at).getTime() >= 0) {
      title = 'Worker run may be stuck'; detail = 'Its lease expired. Check the local worker and retry if needed.';
    }
    if (!title) continue;
    alerts.push({ id: `${task.id}:${task.status}:${task.updated_at}`, task_id: task.id, task_title: task.title,
      status: task.status, severity: task.status === 'review_accepted' ? 'action' : 'stuck', title, detail, since: task.updated_at });
  }
  return alerts;
}

async function snapshot(pool, memory, workspace, date) {
  const start = dayStart(date);
  const end = reportCutoff(date);
  if (!pool) {
    const state = memory.get(workspace);
    return { tasks: state.tasks, messages: state.messages.filter((item) => !item.demo && new Date(item.created_at) >= start && new Date(item.created_at) < end),
      usage: (state.usage || []).filter((item) => new Date(item.created_at) >= start && new Date(item.created_at) < end) };
  }
  const [tasks, messages, usage] = await Promise.all([
    pool.query('SELECT id, title, status FROM tasks WHERE workspace_id = $1', [workspace]),
    pool.query('SELECT agent_id, kind, task_id FROM agent_messages WHERE workspace_id = $1 AND demo = false AND created_at >= $2 AND created_at < $3', [workspace, start, end]),
    pool.query('SELECT agent_id, input_tokens, output_tokens FROM usage_events WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3', [workspace, start, end]),
  ]);
  return { tasks: tasks.rows, messages: messages.rows, usage: usage.rows };
}

export function summarizeDay(date, { tasks, messages, usage }) {
  const status = {};
  for (const task of tasks) status[task.status] = (status[task.status] || 0) + 1;
  const agents = {};
  for (const entry of usage) {
    const agent = agents[entry.agent_id] ||= { calls: 0, inputTokens: 0, outputTokens: 0, messages: 0 };
    agent.calls += 1; agent.inputTokens += Number(entry.input_tokens); agent.outputTokens += Number(entry.output_tokens);
  }
  for (const entry of messages) (agents[entry.agent_id] ||= { calls: 0, inputTokens: 0, outputTokens: 0, messages: 0 }).messages += 1;
  const needAttention = tasks.filter((task) => ['research_blocked', 'claude_failed', 'review_failed', 'review_blocked', 'review_revision', 'review_accepted'].includes(task.status));
  return { date, timeZone, generated_at: new Date().toISOString(), taskCount: tasks.length, status, agents,
    activityCount: messages.length, modelCalls: usage.length,
    inputTokens: usage.reduce((sum, item) => sum + Number(item.input_tokens), 0),
    outputTokens: usage.reduce((sum, item) => sum + Number(item.output_tokens), 0),
    attention: needAttention.map(({ id, title, status: itemStatus }) => ({ id, title, status: itemStatus })) };
}

export async function saveDailyReport(pool, memory, workspace, date) {
  if (!pool) {
    const state = memory.get(workspace);
    state.dailyReports ||= {};
    return state.dailyReports[date] ||= summarizeDay(date, await snapshot(pool, memory, workspace, date));
  }
  const existing = await pool.query('SELECT body FROM daily_reports WHERE workspace_id = $1 AND report_date = $2', [workspace, date]);
  if (existing.rows[0]) return existing.rows[0].body;
  const body = summarizeDay(date, await snapshot(pool, memory, workspace, date));
  const result = await pool.query(`INSERT INTO daily_reports (workspace_id, report_date, body) VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (workspace_id, report_date) DO UPDATE SET body = daily_reports.body RETURNING body`, [workspace, date, JSON.stringify(body)]);
  return result.rows[0].body;
}

export async function readDailyReports(pool, memory, workspace) {
  if (!pool) return Object.values(memory.get(workspace)?.dailyReports || {}).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
  const result = await pool.query('SELECT body FROM daily_reports WHERE workspace_id = $1 ORDER BY report_date DESC LIMIT 14', [workspace]);
  return result.rows.map((row) => row.body);
}

export function telegramText(item) {
  if (item.kind === 'alert') return `Northstar Lab alert: ${item.alert.title}\nTask: ${item.alert.task_title}\n${item.alert.detail}\n${dashboard}#reports`;
  const report = item.report;
  const agentLines = Object.entries(report.agents).map(([name, agent]) => `${name}: ${agent.calls} calls, ${agent.messages} messages, ${agent.inputTokens + agent.outputTokens} tokens`);
  return [`Northstar Lab daily report · ${report.date} · 6:00 PM IST`,
    `Tasks: ${report.taskCount}. Model calls today: ${report.modelCalls}. Tokens: ${report.inputTokens} in / ${report.outputTokens} out.`,
    `Status: ${Object.entries(report.status).map(([key, count]) => `${key} ${count}`).join(', ') || 'none'}.`,
    `Needs attention: ${report.attention.length}${report.attention.length ? ` (${report.attention.map((task) => task.title).join('; ').slice(0, 700)})` : ''}.`,
    ...(agentLines.length ? agentLines : ['No agent activity recorded today.']), `${dashboard}#reports`].join('\n').slice(0, 4000);
}

export async function sendTelegram(item, config = process.env, transport = fetch) {
  const token = config.NORTHSTAR_TELEGRAM_BOT_TOKEN;
  const chatId = config.NORTHSTAR_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  let response;
  try {
    response = await transport(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: telegramText(item), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error('Telegram network request failed'); }
  if (!response.ok) throw new Error(`Telegram delivery failed with HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error('Telegram delivery was rejected');
  return true;
}

async function sendOnce(pool, memory, workspace, key, item) {
  if (!pool) {
    const state = memory.get(workspace);
    state.telegramSent ||= new Set();
    if (state.telegramSent.has(key)) return;
    if (await sendTelegram(item)) state.telegramSent.add(key);
    return;
  }
  const claimed = await pool.query(`INSERT INTO telegram_deliveries (workspace_id, delivery_key, last_attempt_at)
    VALUES ($1, $2, now()) ON CONFLICT (workspace_id, delivery_key) DO UPDATE
    SET last_attempt_at = now() WHERE telegram_deliveries.sent_at IS NULL
    AND telegram_deliveries.last_attempt_at < now() - interval '5 minutes' RETURNING delivery_key`, [workspace, key]);
  if (!claimed.rowCount) return;
  try {
    if (await sendTelegram(item)) await pool.query('UPDATE telegram_deliveries SET sent_at = now() WHERE workspace_id = $1 AND delivery_key = $2', [workspace, key]);
  } catch (error) {
    console.error('Telegram delivery failed:', error.message);
  }
}

export async function reportTick(pool, memory, readState, now = new Date()) {
  const workspaces = pool ? (await pool.query('SELECT id FROM workspaces')).rows.map((row) => row.id) : [...memory.keys()];
  const configuredWorkspace = process.env.NORTHSTAR_TELEGRAM_WORKSPACE_ID;
  const canSend = /^[a-f0-9]{64}$/.test(configuredWorkspace || '') &&
    Boolean(process.env.NORTHSTAR_TELEGRAM_BOT_TOKEN && process.env.NORTHSTAR_TELEGRAM_CHAT_ID);
  for (const workspace of workspaces) {
    const state = await readState(workspace);
    const seen = pool ? (await pool.query('SELECT last_seen_at FROM claude_worker_presence WHERE workspace_id = $1', [workspace])).rows[0]?.last_seen_at
      : memory.get(workspace)?.claude_worker_seen_at;
    const alerts = deriveAlerts(state.tasks, seen, state.reviewPackets, now);
    if (canSend && workspace === configuredWorkspace) {
      for (const alert of alerts) await sendOnce(pool, memory, workspace, `alert:${alert.id}`, { kind: 'alert', alert });
    }
    if (!afterReportTime(now)) continue;
    const report = await saveDailyReport(pool, memory, workspace, istDate(now));
    if (canSend && workspace === configuredWorkspace) await sendOnce(pool, memory, workspace, `report:${report.date}`, { kind: 'report', report });
  }
}
