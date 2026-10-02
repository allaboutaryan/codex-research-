const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseRepositoryInput(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Enter a public GitHub repository or issue URL.');
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password) throw new Error('Use a github.com repository URL.');
    value = url.pathname.replace(/^\/+|\/+$/g, '');
  } else if (value.includes('://')) {
    throw new Error('Use an HTTPS github.com URL or owner/repository.');
  }
  const parts = value.split('/');
  if (parts.length !== 2 && !(parts.length === 4 && parts[2] === 'issues' && /^\d+$/.test(parts[3]))) {
    throw new Error('Use owner/repository or a GitHub issue URL.');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo === '.' || repo === '..') {
    throw new Error('That repository name is not valid.');
  }
  const issueNumber = parts.length === 4 ? Number(parts[3]) : null;
  if (issueNumber !== null && (!Number.isSafeInteger(issueNumber) || issueNumber < 1)) throw new Error('That issue number is not valid.');
  return { owner, repo, fullName: `${owner}/${repo}`, issueNumber };
}

export function cleanCard(form, checkedAt = new Date().toISOString()) {
  const prerequisite = String(form.prerequisite || '').trim().slice(0, 300);
  const setup = String(form.setup || '').trim().slice(0, 500);
  const test = String(form.test || '').trim().slice(0, 500);
  if (form.checked && (!setup || !test)) throw new Error('Add both a setup and test step before marking the card checked.');
  return { prerequisite, setup, test, checkedAt: form.checked ? checkedAt : null };
}

export function composeHelpRequest({ fullName, issueNumber, stage, note }) {
  const allowedStages = ['Understanding the task', 'Setting up', 'Running tests', 'Getting feedback'];
  if (!allowedStages.includes(stage)) throw new Error('Choose where you got stuck.');
  const cleanNote = String(note || '').trim().replace(/\s+/g, ' ').slice(0, 400);
  if (cleanNote.length < 10) throw new Error('Describe what happened in at least 10 characters.');
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error('Choose an issue first.');
  return `Question about ${fullName}#${issueNumber}\n\nI got stuck at: ${stage}\nWhat happened: ${cleanNote}\n\nCould someone point me to the right next step? (No credentials or raw logs included.)`;
}

export function safeGitHubUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function issuePreview(markdown) {
  return String(markdown || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line) && !/^\*\*(?:title|issue):\*\*/i.test(line))
    .join(' ')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .slice(0, 460);
}
