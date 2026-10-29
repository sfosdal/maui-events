// Mail Steve about calls still failing after their retries — only when
// something NEW fails (Steve, 2026-10-29: "I want a notification about
// failed calls in email, only when a retry hasn't resolved it").
//
// The build writes failures.json (scripts/failures.mjs). This keeps ONE
// open issue per repo, "Calls failing after retries", assigned to Steve —
// he watches none of the event repos, so the assignment is what makes
// GitHub mail him:
//   - failures and no open issue  → open it (GitHub mails the assignee);
//   - failures new since the list → comment naming the new ones (mails);
//   - the same failures again     → the issue body is refreshed, no mail;
//   - nothing failing             → the body says so, no mail, no close
//     (a close would mail too); the next failure is new again and mails.
// Never fails the run: every error is logged and the script exits 0.
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/failure-issue.mjs [failures.json]
import { readFileSync } from 'node:fs';

export const TITLE = 'Calls failing after retries';
const MARK = /<!-- keys: (\[.*?\]) -->/s;
const ASSIGNEE = 'sfosdal';

const line = (f) => `- \`${f.key}\`${f.count > 1 ? ` (×${f.count})` : ''}${f.error && !f.key.includes(f.error) ? ` — ${f.error}` : ''}${f.after ? ` — the last call before it: ${f.after}` : ''}`;
export function issueBody(failures, { at, runUrl } = {}) {
  const keys = failures.map((f) => f.key).sort();
  const head = failures.length
    ? `Still failing after their retries in the build of ${at}${runUrl ? ` ([the run](${runUrl}))` : ''}:\n\n${failures.map(line).join('\n')}`
    : `Nothing failing as of the build of ${at}${runUrl ? ` ([the run](${runUrl}))` : ''}.`;
  return `${head}\n\nThis issue is kept by the workflow (scripts/failure-issue.mjs): a comment — and so a mail — only when a new call fails; the list above is refreshed every build.\n\n<!-- keys: ${JSON.stringify(keys)} -->\n`;
}
export const keysIn = (body) => { const m = MARK.exec(body || ''); try { return m ? JSON.parse(m[1]) : []; } catch { return []; } };

// What to do, given this build's failures and the open issue (or null): pure, for the tests
export function plan(failures, issue, meta = {}) {
  const body = issueBody(failures, meta);
  if (!issue) return failures.length ? { open: { title: TITLE, body, assignees: [ASSIGNEE] } } : {};
  const known = new Set(keysIn(issue.body));
  const fresh = failures.filter((f) => !known.has(f.key));
  return {
    edit: body,
    ...(fresh.length ? { comment: `Newly failing after retries${meta.runUrl ? ` ([the run](${meta.runUrl}))` : ''}:\n\n${fresh.map(line).join('\n')}` } : {}),
  };
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL: server = 'https://github.com', GITHUB_RUN_ID: runId } = process.env;
  if (!token || !repo) { console.log('failure-issue: no GITHUB_TOKEN / GITHUB_REPOSITORY — nothing sent'); return; }
  let data;
  try { data = JSON.parse(readFileSync(process.argv[2] || 'failures.json', 'utf8')); }
  catch (e) { console.log(`failure-issue: no failures file (${e.message}) — nothing sent`); return; }
  const failures = data.failures || [];
  const api = async (path, init = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  };
  const open = (await api(`/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}&per_page=100`)).find((i) => i.title === TITLE && !i.pull_request) || null;
  const p = plan(failures, open, { at: data.at, runUrl: runId ? `${server}/${repo}/actions/runs/${runId}` : '' });
  if (p.open) { const i = await api('/issues', { method: 'POST', body: JSON.stringify(p.open) }); console.log(`failure-issue: opened #${i.number} (${failures.length} failing) — mailed`); return; }
  if (!open) { console.log('failure-issue: nothing failing, no issue open'); return; }
  await api(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ body: p.edit }) });
  if (p.comment) { await api(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: p.comment }) }); console.log(`failure-issue: #${open.number} — new failures commented — mailed`); }
  else console.log(`failure-issue: #${open.number} refreshed (${failures.length} failing, none new) — no mail`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => console.log(`failure-issue: ${e.message} — nothing more sent`));
