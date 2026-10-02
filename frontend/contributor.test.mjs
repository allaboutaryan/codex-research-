import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanCard, composeHelpRequest, issuePreview, parseRepositoryInput, safeGitHubUrl } from './public/contributor/logic.mjs';

test('accepts a public repository or issue URL without treating a path as an API host', () => {
  assert.deepEqual(parseRepositoryInput('microsoft/vscode'), { owner: 'microsoft', repo: 'vscode', fullName: 'microsoft/vscode', issueNumber: null });
  assert.deepEqual(parseRepositoryInput('https://github.com/microsoft/vscode/issues/123?tab=comments'), { owner: 'microsoft', repo: 'vscode', fullName: 'microsoft/vscode', issueNumber: 123 });
  assert.throws(() => parseRepositoryInput('https://evil.example/microsoft/vscode'), /github.com/);
  assert.throws(() => parseRepositoryInput('https://github.com/microsoft/vscode/settings'), /owner\/repository/);
});

test('only GitHub HTTPS links are exposed as source links', () => {
  assert.equal(safeGitHubUrl('https://github.com/microsoft/vscode/issues/1'), 'https://github.com/microsoft/vscode/issues/1');
  assert.equal(safeGitHubUrl('https://github.com.evil.example/a/b'), null);
  assert.equal(safeGitHubUrl('javascript:alert(1)'), null);
});

test('a checked setup card needs both steps; drafts remain unverified', () => {
  assert.deepEqual(cleanCard({ prerequisite: ' Node ', setup: ' npm ci ', test: ' npm test ', checked: true }, '2026-10-02T00:00:00Z'), {
    prerequisite: 'Node', setup: 'npm ci', test: 'npm test', checkedAt: '2026-10-02T00:00:00Z',
  });
  assert.equal(cleanCard({ setup: 'npm ci', checked: false }).checkedAt, null);
  assert.throws(() => cleanCard({ setup: 'npm ci', checked: true }), /both a setup and test/);
});

test('help requests are a bounded, copy-only summary', () => {
  const result = composeHelpRequest({ fullName: 'microsoft/vscode', issueNumber: 123, stage: 'Running tests', note: 'The local test failed after installation.' });
  assert.match(result, /microsoft\/vscode#123/);
  assert.match(result, /Running tests/);
  assert.throws(() => composeHelpRequest({ fullName: 'a/b', issueNumber: 1, stage: 'Running tests', note: 'short' }), /at least 10/);
});

test('issue preview removes duplicate Markdown headings and escapes later in the UI', () => {
  assert.equal(issuePreview('# GitHub Issue\n\n**Title:** Example\n\n## Problem\nThe `test` fails.'), 'The test fails.');
});
