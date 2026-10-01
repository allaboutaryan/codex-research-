import assert from 'node:assert/strict';
import test from 'node:test';
import { afterReportTime, deriveAlerts, istDate, saveDailyReport, sendTelegram, summarizeDay, telegramText } from './reports.js';

test('report time follows India time, not UTC', () => {
  assert.equal(istDate(new Date('2026-10-02T12:30:00Z')), '2026-10-02');
  assert.equal(afterReportTime(new Date('2026-10-02T12:29:00Z')), false);
  assert.equal(afterReportTime(new Date('2026-10-02T12:30:00Z')), true);
});

test('alerts identify blocked work and offline queued worker', () => {
  const now = new Date('2026-10-02T12:30:00Z');
  const tasks = [
    { id: 'a', title: 'Find source', status: 'research_blocked', updated_at: '2026-10-02T12:00:00Z' },
    { id: 'b', title: 'Check source', status: 'review_queued', updated_at: '2026-10-02T12:00:00Z' },
    { id: 'c', title: 'Accepted draft', status: 'review_accepted', updated_at: '2026-10-02T12:00:00Z' },
  ];
  const alerts = deriveAlerts(tasks, null, {}, now);
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].title, 'Research has no cited source');
  assert.equal(alerts[1].title, 'Local Claude worker is offline');
  assert.equal(alerts[2].severity, 'action');
});

test('daily report counts only real recorded activity and tokens', async () => {
  const date = '2026-10-02';
  const memory = new Map([['owner', {
    tasks: [{ id: 'a', title: 'Find source', status: 'research_blocked' }],
    messages: [
      { demo: true, agent_id: 'CTO', created_at: '2026-10-02T08:00:00Z' },
      { demo: false, agent_id: 'Research worker', created_at: '2026-10-02T08:00:00Z' },
    ], usage: [{ agent_id: 'Research worker', input_tokens: 10, output_tokens: 5, created_at: '2026-10-02T08:00:00Z' }],
  }]]);
  const report = await saveDailyReport(null, memory, 'owner', date);
  assert.equal(report.activityCount, 1);
  assert.equal(report.modelCalls, 1);
  assert.equal(report.agents.CTO, undefined);
  assert.equal(report.attention.length, 1);
  assert.equal((await saveDailyReport(null, memory, 'owner', date)), report);
  assert.match(telegramText({ kind: 'report', report }), /15 tokens/);
  assert.equal(summarizeDay(date, { tasks: [], messages: [], usage: [] }).modelCalls, 0);
});

test('Telegram delivery uses configured private bot and chat only', async () => {
  const item = { kind: 'alert', alert: { title: 'Worker stopped', task_title: 'Research', detail: 'Restart the worker.' } };
  assert.equal(await sendTelegram(item, {}, async () => { throw new Error('should not send'); }), false);
  let request;
  assert.equal(await sendTelegram(item, { NORTHSTAR_TELEGRAM_BOT_TOKEN: 'test-token', NORTHSTAR_TELEGRAM_CHAT_ID: '123' }, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ ok: true }) };
  }), true);
  assert.match(request.url, /sendMessage$/);
  assert.equal(JSON.parse(request.options.body).chat_id, '123');
  assert.match(JSON.parse(request.options.body).text, /Worker stopped/);
});
