// `basedOn` across turns, through the real pickUp() and a real repository: a role that only reads
// follows the branch it is based on, and a role that writes is never moved off its own commits.
// The second is the case a plan → impl chain makes: the planner's branch is committed once and
// never moves, so "what the base is now" is behind everything the implementer has done since.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TeamEngine, SqliteStore, teamPaths, loadConfig, storePath } from '@weawr/engine';

const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));
const ISSUE = { id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open', type: 'started' } };
const QUIET = { onPickup: { comment: false }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: false, notify: false } };
const CONFIG = {
  tracker: 'linear', roles: ['plan', 'impl', 'review'], baseBranch: 'main', pullBase: false,
  defaults: { worktree: 'self', ...QUIET },
  rules: [
    { name: 'plan', role: 'plan', match: 'any:true' },
    { name: 'impl', role: 'impl', basedOn: 'plan', match: 'any:true' },
    { name: 'review', role: 'review', basedOn: 'impl', match: 'any:true' },
  ],
};

const git = (args, cwd) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const headOf = (at) => git(['rev-parse', 'HEAD'], at);
function commitIn(at, file, body) {
  fs.writeFileSync(path.join(at, file), body);
  git(['add', file], at);
  git(['commit', '-q', '-m', `add ${file}`], at);
  return headOf(at);
}

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-based-on-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main', dir], os.tmpdir());
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.weawr/state/\n.weawr/worktrees/\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'first'], dir);
  return dir;
}

/** A herdr whose agents sit in the directory their workspace was opened in, as the real ones do. */
function fakeHerdr() {
  const agents = new Map();
  let opened = null;
  return {
    async agentGet(name) { return agents.get(name) || null; },
    async createWorkspace({ cwd }) { opened = cwd; return { workspaceId: `w-${path.basename(cwd)}`, tabId: 't1', paneId: 'p1' }; },
    async startAgent({ name }) { agents.set(name, { agent: 'claude', name, agent_status: 'idle', cwd: opened, foreground_cwd: opened, pane_id: 'p1', tab_id: 't1', workspace_id: `w-${path.basename(opened)}` }); return {}; },
    async workspaceGet() { return null; },
    async prompt() {},
    waitAgent(name, { until = [] } = {}) { return until.includes('working') ? Promise.resolve('working') : until.includes('idle') ? Promise.resolve('timeout') : new Promise(() => {}); },
    async readAgent() { return ''; },
    async notify() {},
    async closeWorkspace() {},
  };
}

function engine(dir) {
  const paths = teamPaths(dir);
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  const lines = [];
  const e = new TeamEngine({ cfg, tracker: null, herdr: fakeHerdr(), paths, promptsRoot: PROMPTS, store: SqliteStore.open(storePath(paths.stateDir)), ids: { hostId: 'h', teamId: 'fac0001' }, log: (l) => lines.push(l), version: '9.9.9' });
  return { e, lines, rule: (n) => e.cfg.rules.find((r) => r.name === n), run: (role) => e.state.runs[`GH-7@${role}`] };
}
/** End a turn the way a finished agent leaves it, so the next pickUp is a later turn of the same run. */
const finish = (e, run) => { run.status = 'done'; e.saveState(); };

test('an implementer based on the planner\'s branch keeps its commits, and its work in progress, on every later turn', async (t) => {
  const dir = repo(t);
  const { e, lines, rule, run } = engine(dir);

  await e.pickUp(ISSUE, rule('plan'));
  const plan = commitIn(run('plan').worktreePath, 'plan.md', 'the plan\n');
  finish(e, run('plan'));

  await e.pickUp(ISSUE, rule('impl'));
  const impl = run('impl').worktreePath;
  assert.equal(headOf(impl), plan, 'the implementer starts from the plan');
  commitIn(impl, 'fix.txt', 'first attempt\n');
  const mine = commitIn(impl, 'fix.txt', 'second attempt\n');
  fs.writeFileSync(path.join(impl, 'fix.txt'), 'not committed yet\n');
  finish(e, run('impl'));

  for (const pass of [2, 3]) {
    await e.pickUp(ISSUE, rule('impl'), { pass, holdsClaim: true, nudges: [{ from: 'review', message: 'one more thing' }] });
    assert.equal(run('impl').adopted, true, 'the same session, the same worktree');
    assert.equal(headOf(impl), mine, `turn ${pass} starts where the last one ended`);
    assert.equal(fs.readFileSync(path.join(impl, 'fix.txt'), 'utf8'), 'not committed yet\n');
    finish(e, run('impl'));
  }
  assert.equal(lines.filter((l) => /GH-7@impl: caught up to/.test(l)).length, 0);
  assert.equal(lines.filter((l) => /GH-7@impl: not moved onto .*ahead of/.test(l)).length, 2, 'and the log says why it was left alone');
});

test('a reviewer follows the implementer\'s branch turn after turn, a rewritten one included', async (t) => {
  const dir = repo(t);
  const { e, rule, run } = engine(dir);

  await e.pickUp(ISSUE, rule('plan'));
  commitIn(run('plan').worktreePath, 'plan.md', 'the plan\n');
  finish(e, run('plan'));
  await e.pickUp(ISSUE, rule('impl'));
  const impl = run('impl').worktreePath;
  const v1 = commitIn(impl, 'fix.txt', 'v1\n');
  finish(e, run('impl'));

  await e.pickUp(ISSUE, rule('review'));
  const review = run('review').worktreePath;
  assert.equal(headOf(review), v1);
  finish(e, run('review'));

  // an ordinary push, then a second one: the record has to move with the worktree, or the turn
  // after the first catch-up looks like a reviewer that committed
  for (const [pass, body] of [[2, 'v2\n'], [3, 'v3\n']]) {
    const next = commitIn(impl, 'fix.txt', body);
    await e.pickUp(ISSUE, rule('review'), { pass, holdsClaim: true });
    assert.equal(headOf(review), next, `turn ${pass} reads what the implementer pushed`);
    finish(e, run('review'));
  }

  // the implementer rewrites its last commit (a rebase, a force-push) while the reviewer has
  // scratch edits lying about: not a fast-forward, and still the reviewer's to follow
  fs.writeFileSync(path.join(review, 'fix.txt'), 'a reviewer poking at it\n');
  fs.writeFileSync(path.join(impl, 'fix.txt'), 'v3, rewritten\n');
  git(['commit', '-q', '-a', '--amend', '-m', 'rewritten'], impl);
  await e.pickUp(ISSUE, rule('review'), { pass: 4, holdsClaim: true });
  assert.equal(headOf(review), headOf(impl));
  assert.equal(fs.readFileSync(path.join(review, 'fix.txt'), 'utf8'), 'v3, rewritten\n');
});
