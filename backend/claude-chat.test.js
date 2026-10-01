import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildChatContext, claimClaudeChat, completeClaudeChat, defaultMission, queueClaudeChat, queueTeamWorkflow, readProjectContext, saveProjectContext } from './claude-chat.js';

test('owner chat keeps durable goal, scoped history, and measured Claude answer', async () => {
  const workspace = 'one';
  const taskId = randomUUID();
  const memory = new Map([[workspace, { tasks: [{ id: taskId, title: 'Find a developer need', brief: 'Use credible papers', status: 'awaiting_review' }],
    messages: [], chatJobs: [], usage: [], nextMessageId: 1, mission: defaultMission, context_notes: '' }]]);
  const saved = await saveProjectContext(null, memory, workspace, { mission: 'Find a genuinely useful developer tool using evidence before deciding what to build.', notes: 'Prefer accessible products for solo developers.' });
  assert.equal((await readProjectContext(null, memory, workspace)).mission, saved.mission);
  const first = await queueClaudeChat(null, memory, workspace, taskId, 'What is our current goal?');
  const claimed = await claimClaudeChat(null, memory, workspace);
  assert.equal(claimed.id, first);
  assert.equal(claimed.context.project_goal, saved.mission);
  assert.equal(claimed.context.owner_memory_notes, saved.notes);
  assert.equal(claimed.context.task.brief, 'Use credible papers');
  assert.deepEqual(claimed.context.recent_task_history, []);
  assert.equal(await completeClaudeChat(null, memory, workspace, first, {
    lease_token: claimed.lease_token, summary: 'Our goal is an evidence-backed developer tool; no product idea has passed independent QA yet.',
    model: 'claude-test', request_id: randomUUID(), evidence_refs: [],
    usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }), true);
  const second = await queueClaudeChat(null, memory, workspace, taskId, 'What did you answer earlier?');
  const context = await buildChatContext(null, memory, workspace, taskId, second);
  assert.equal(context.recent_task_history.length, 2);
  assert.equal(context.recent_task_history[1].kind, 'answer');
  assert.equal(memory.get(workspace).usage.length, 1);
  assert.equal(memory.get(workspace).messages.at(-1).demo, false);
});

test('chat context is bounded and excludes other workspaces', async () => {
  const taskId = randomUUID();
  const otherTask = randomUUID();
  const memory = new Map([['one', { tasks: [{ id: taskId, title: 'Current', brief: '', status: 'queued' }],
    messages: [], chatJobs: [], mission: defaultMission }], ['two', { tasks: [], messages: [{ task_id: taskId, agent_id: 'Research worker', kind: 'finding', summary: 'Secret of other workspace', demo: false }], chatJobs: [] }]]);
  const state = memory.get('one');
  for (let i = 0; i < 30; i += 1) state.messages.push({ task_id: i % 2 ? taskId : otherTask, agent_id: 'Research worker', kind: 'finding', summary: `Earlier finding ${i}`, demo: false });
  const context = await buildChatContext(null, memory, 'one', taskId, randomUUID());
  assert.equal(context.recent_task_history.length, 12);
  assert.equal(context.recent_other_work.length, 5);
  assert.equal(JSON.stringify(context).includes('Secret of other workspace'), false);
});

test('owner can address Quality reviewer directly without creating a formal verdict', async () => {
  const taskId = randomUUID();
  const memory = new Map([['one', { tasks: [{ id: taskId, title: 'Check finding', brief: '', status: 'review_queued' }],
    messages: [], chatJobs: [], usage: [], nextMessageId: 1, mission: defaultMission }]]);
  const id = await queueClaudeChat(null, memory, 'one', taskId, 'What evidence should be checked?', 'Quality reviewer');
  const job = await claimClaudeChat(null, memory, 'one');
  assert.equal(job.agent_id, 'Quality reviewer');
  assert.equal(memory.get('one').messages[0].recipient_id, 'Quality reviewer');
  assert.equal(await completeClaudeChat(null, memory, 'one', id, {
    lease_token: job.lease_token, summary: 'The primary source and the paper methods should be checked before a formal verdict.',
    model: 'claude-test', request_id: randomUUID(), evidence_refs: [],
    usage: { input_tokens: 30, output_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 },
  }), true);
  assert.equal(memory.get('one').messages.at(-1).agent_id, 'Quality reviewer');
  assert.equal(memory.get('one').usage[0].agent_id, 'Quality reviewer');
  assert.equal(memory.get('one').tasks[0].status, 'review_queued');
  const cto = await queueClaudeChat(null, memory, 'one', taskId, 'What should happen next?', 'CTO');
  assert.equal(memory.get('one').chatJobs.find((item) => item.id === cto).agent_id, 'CTO');
  await assert.rejects(queueClaudeChat(null, memory, 'one', taskId, 'Forged message', 'Unknown role'), /Invalid chat recipient/);
});

test('full team handoffs are separate measured calls with visible recipients', async () => {
  const taskId = randomUUID();
  const state = { tasks: [{ id: taskId, title: 'Scope a developer need', brief: '2016–2026 primary sources', status: 'queued' }],
    messages: [], chatJobs: [], events: [], usage: [], nextId: 1, nextMessageId: 1, mission: defaultMission };
  const memory = new Map([['one', state]]);
  assert.equal(await queueTeamWorkflow(null, memory, 'one', taskId), true);
  assert.equal(await queueTeamWorkflow(null, memory, 'one', taskId), false);
  const pm = await claimClaudeChat(null, memory, 'one');
  assert.equal(pm.job_type, 'team_plan');
  assert.equal(pm.agent_id, 'Project manager');
  assert.equal(await completeClaudeChat(null, memory, 'one', pm.id, result(pm.lease_token, 'PM scoped the question and the acceptance criteria for the team lead.')), true);
  assert.equal(state.tasks[0].status, 'lead_queued');
  assert.equal(state.messages.at(-1).recipient_id, 'Team lead');
  const lead = await claimClaudeChat(null, memory, 'one');
  assert.equal(lead.job_type, 'team_assign');
  assert.equal(lead.context.recent_task_history.at(-1).agent, 'Project manager');
  assert.equal(await completeClaudeChat(null, memory, 'one', lead.id, result(lead.lease_token, 'Research worker should check three primary papers before QA.')), true);
  assert.equal(state.tasks[0].status, 'claude_queued');
  assert.equal(state.messages.at(-1).recipient_id, 'Research worker');
  assert.equal(state.usage.length, 2);
});

function result(lease_token, summary) {
  return { lease_token, summary, model: 'claude-test', request_id: randomUUID(), evidence_refs: [],
    usage: { input_tokens: 20, output_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 0, reasoning_output_tokens: 0 } };
}
