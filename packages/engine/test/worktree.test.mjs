import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { catchUp, defaultBranch, makeWorktree, pullBase, removeWorktree, worktreeRoot } from '../dist/adapters/worktree.mjs';

const git = (args, cwd) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

/** A real repository with one commit, removed when the test ends. */
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-wt-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* going away anyway */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: dir });
  return fs.realpathSync(dir);
}

const branchAt = (dir) => git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);

test('the worktree exists on the branch we asked for, before anything else runs', (t) => {
  // The whole point: no discovery, no rename. The directory and the branch are both settled here,
  // so the brief, the herdr workspace, the pickup comment and the PR can all quote them.
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-7-fix-the-thing', branch: 'jml/gh-7-fix-the-thing' });
  assert.equal(made.created, true);
  assert.equal(made.path, path.join(r, '.weawr/worktrees/gh-7-fix-the-thing'));
  assert.ok(fs.existsSync(made.path));
  assert.equal(branchAt(made.path), 'jml/gh-7-fix-the-thing');
  assert.equal(branchAt(r), 'main', 'the maintainer\'s own checkout is untouched');
});

test('a second run for the same issue reuses the directory instead of piling up', (t) => {
  // `weawr reset <KEY>` then another pickup should land in the same place.
  const r = repo(t);
  const first = makeWorktree({ git, repo: r, slug: 'gh-7', branch: 'jml/gh-7' });
  fs.writeFileSync(path.join(first.path, 'scratch.txt'), 'work in progress');
  const again = makeWorktree({ git, repo: r, slug: 'gh-7', branch: 'jml/gh-7' });
  assert.equal(again.created, false);
  assert.equal(again.path, first.path);
  assert.equal(fs.readFileSync(path.join(again.path, 'scratch.txt'), 'utf8'), 'work in progress');
});

test('an existing branch is attached to, never clobbered', (t) => {
  // An earlier run's commits are not ours to throw away.
  const r = repo(t);
  execFileSync('git', ['branch', 'jml/gh-9'], { cwd: r });
  const made = makeWorktree({ git, repo: r, slug: 'gh-9', branch: 'jml/gh-9' });
  assert.equal(branchAt(made.path), 'jml/gh-9');
});

test('two issues get two worktrees on two branches', (t) => {
  const r = repo(t);
  const a = makeWorktree({ git, repo: r, slug: 'gh-1', branch: 'herd/gh-1' });
  const b = makeWorktree({ git, repo: r, slug: 'gh-2', branch: 'herd/gh-2' });
  assert.notEqual(a.path, b.path);
  assert.equal(branchAt(a.path), 'herd/gh-1');
  assert.equal(branchAt(b.path), 'herd/gh-2');
});

test('no branch asked for means git picks, and we still get a worktree', (t) => {
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'smoke-1', branch: null });
  assert.ok(fs.existsSync(made.path));
  assert.ok(branchAt(made.path));
});

test('a branch checked out somewhere else fails loudly rather than silently', (t) => {
  const r = repo(t);
  // main is checked out in the repo itself, so git refuses to check it out again
  assert.throws(() => makeWorktree({ git, repo: r, slug: 'gh-3', branch: 'main' }), /git worktree add failed/);
});

test('a directory in the way that is not a worktree is an error, not a surprise', (t) => {
  const r = repo(t);
  const inTheWay = path.join(r, '.weawr/worktrees/gh-4');
  fs.mkdirSync(inTheWay, { recursive: true });
  fs.writeFileSync(path.join(inTheWay, 'somebody-elses.txt'), 'x');
  assert.throws(() => makeWorktree({ git, repo: r, slug: 'gh-4', branch: 'herd/gh-4' }), /is not a worktree of this repository/);
});

test('worktreeDir cannot point outside the repository', () => {
  // config.json is committed, so this is a path a repository you cloned would otherwise choose.
  for (const bad of ['/tmp/anywhere', '../../elsewhere', '.weawr/../../up']) {
    assert.throws(() => worktreeRoot('/repo', bad), /must stay inside the repository/, bad);
  }
  assert.equal(worktreeRoot('/repo', '.weawr/worktrees'), '/repo/.weawr/worktrees');
  assert.equal(worktreeRoot('/repo', 'wt'), '/repo/wt');
});

test('makeWorktree needs a slug', () => {
  assert.throws(() => makeWorktree({ git, repo: '/repo', slug: '' }), /needs a slug/);
});

test('a merged run\'s worktree is handed back, and the branch it was on survives', (t) => {
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-22', branch: 'herd/gh-22' });
  const out = removeWorktree({ git, repo: r, at: made.path });
  assert.deepEqual(out, { removed: true, reason: null });
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(git(['worktree', 'list'], r).includes(made.path), false);
  assert.ok(git(['show-ref', '--verify', 'refs/heads/herd/gh-22'], r), 'the merge is on the branch; only the checkout goes');
});

test('gitignored run state does not stop a worktree from being removed', (t) => {
  // Every run writes brief.md and result.json into .weawr/state/ inside its own worktree.
  const r = repo(t);
  fs.writeFileSync(path.join(r, '.gitignore'), '.weawr/state/\n.weawr/worktrees/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: r });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore state'], { cwd: r });
  const made = makeWorktree({ git, repo: r, slug: 'gh-22', branch: 'herd/gh-22' });
  fs.mkdirSync(path.join(made.path, '.weawr/state/runs/GH-22'), { recursive: true });
  fs.writeFileSync(path.join(made.path, '.weawr/state/runs/GH-22/result.json'), '{"status":"pr_open"}');
  assert.equal(removeWorktree({ git, repo: r, at: made.path }).removed, true);
});

test('a worktree with work still in it is kept, and says why', (t) => {
  // The PR is merged, but something in there is not committed. A directory is cheaper than
  // whatever that file was.
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-23', branch: 'herd/gh-23' });
  fs.writeFileSync(path.join(made.path, 'notes.txt'), 'not committed anywhere');
  const out = removeWorktree({ git, repo: r, at: made.path });
  assert.equal(out.removed, false);
  assert.match(out.reason, /uncommitted or untracked/);
  assert.ok(fs.existsSync(made.path));
});

test('the repository\'s own checkout is never removed', (t) => {
  // "worktree": "none" runs work in the checkout the watcher was started in.
  const r = repo(t);
  const out = removeWorktree({ git, repo: r, at: r });
  assert.equal(out.removed, false);
  assert.match(out.reason, /the repository itself/);
  assert.ok(fs.existsSync(path.join(r, '.git')));
  assert.deepEqual(removeWorktree({ git, repo: r, at: null }), { removed: false, reason: 'the run had no worktree of its own' });
});

test('a worktree somebody already deleted is pruned, not an error', (t) => {
  const r = repo(t);
  const made = makeWorktree({ git, repo: r, slug: 'gh-24', branch: 'herd/gh-24' });
  fs.rmSync(made.path, { recursive: true, force: true });
  assert.deepEqual(removeWorktree({ git, repo: r, at: made.path }), { removed: false, reason: 'already gone' });
  assert.equal(git(['worktree', 'list'], r).includes(made.path), false, 'the admin files went too');
});

// ---------------------------------------------------------------- a reviewer's worktree

/** Commit a file on `branch` in `dir`, branching from HEAD the first time. Returns the new sha. */
function commitOn(dir, branch, file, body) {
  const exists = git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], dir) !== null;
  git(['checkout', '-q', ...(exists ? [branch] : ['-b', branch])], dir);
  fs.writeFileSync(path.join(dir, file), body);
  git(['add', file], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `add ${file}`], dir);
  const sha = git(['rev-parse', 'HEAD'], dir);
  git(['checkout', '-q', 'main'], dir);
  return sha;
}

test('a reviewer\'s worktree starts from the branch it is reviewing, not from main', (t) => {
  // Without this the reviewer holds main's code, so "run the tests the implementer said passed" is
  // not something it can do — the change it is reviewing is not on disk.
  const dir = repo(t);
  commitOn(dir, '7-fix-the-thing', 'fix.txt', 'the implementation\n');

  const review = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-the-thing-review', base: '7-fix-the-thing' });
  assert.equal(review.created, true);
  assert.equal(review.base, '7-fix-the-thing');
  assert.equal(branchAt(review.path), '7-fix-the-thing-review');
  // its own branch, but the implementer's code
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'the implementation\n');
  // and the implementer's own worktree is untouched by any of it
  const impl = makeWorktree({ git, repo: dir, slug: 'gh-7-impl', branch: '7-fix-the-thing' });
  assert.equal(branchAt(impl.path), '7-fix-the-thing');
});

test('no base is the old behaviour: a branch cut from wherever the repository is', (t) => {
  const dir = repo(t);
  commitOn(dir, '7-fix-the-thing', 'fix.txt', 'x\n');
  const made = makeWorktree({ git, repo: dir, slug: 'plain', branch: 'plain-branch' });
  assert.equal(made.base, null);
  assert.equal(fs.existsSync(path.join(made.path, 'fix.txt')), false, 'started from main, which has no fix.txt');
});

test('a later turn is caught up to what the branch is now', (t) => {
  // The second turn of a reviewer exists *because* the implementer pushed something. Reusing the
  // worktree without moving it would review the first turn's code again and confirm its own
  // findings were never addressed.
  const dir = repo(t);
  commitOn(dir, '7-fix', 'fix.txt', 'first attempt\n');
  const review = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-review', base: '7-fix' });
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'first attempt\n');

  const after = commitOn(dir, '7-fix', 'fix.txt', 'addressed the review\n');
  // the second pickup reuses the directory, so the move is catchUp's job
  const again = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-review', base: '7-fix' });
  assert.equal(again.created, false);
  assert.equal(fs.readFileSync(path.join(again.path, 'fix.txt'), 'utf8'), 'first attempt\n', 'reuse alone does not move it');

  const moved = catchUp({ git, repo: dir, at: again.path, base: '7-fix' });
  assert.equal(moved.moved, true);
  assert.equal(moved.at, after);
  assert.equal(fs.readFileSync(path.join(again.path, 'fix.txt'), 'utf8'), 'addressed the review\n');

  // idempotent: a turn where nothing moved says so rather than pretending it did
  const nothing = catchUp({ git, repo: dir, at: again.path, base: '7-fix' });
  assert.deepEqual({ moved: nothing.moved, reason: nothing.reason }, { moved: false, reason: 'already up to date' });
});

test('catching up never throws, whatever it is pointed at', (t) => {
  // A reviewer on slightly old code is a worse review; a failed run is no review at all.
  const dir = repo(t);
  const wt = makeWorktree({ git, repo: dir, slug: 'w', branch: 'w-branch' });
  assert.match(catchUp({ git, repo: dir, at: wt.path, base: 'no-such-branch' }).reason, /no branch or origin branch/);
  assert.equal(catchUp({ git, repo: dir, at: null, base: 'x' }).moved, false);
  assert.equal(catchUp({ git, repo: dir, at: wt.path, base: null }).moved, false);
});

test('a worktree put back on an existing branch is not silently left behind', () => {
  // The case the "was it just created?" test missed: onMerged.removeWorktree (or a person) removes
  // the directory but the branch survives, so the next turn re-creates the worktree *on that
  // branch* — `base` is ignored, and the run looks brand new. Without catching up, the reviewer
  // reads the code from the turn before and confirms its own findings were never addressed.
  const dir = repo({ after: () => {} });
  try {
    commitOn(dir, '7-fix', 'f.txt', 'v1\n');
    const first = makeWorktree({ git, repo: dir, slug: 'rev', branch: '7-fix-review', base: '7-fix' });
    assert.equal(first.base, '7-fix');
    const v2 = commitOn(dir, '7-fix', 'f.txt', 'v2\n');
    git(['worktree', 'remove', '--force', first.path], dir);

    const again = makeWorktree({ git, repo: dir, slug: 'rev', branch: '7-fix-review', base: '7-fix' });
    assert.equal(again.created, true, 'the directory really is new');
    assert.equal(again.base, null, 'but it did not start from the base — the branch already existed');
    assert.equal(fs.readFileSync(path.join(again.path, 'f.txt'), 'utf8'), 'v1\n', 'so it is behind');
    // `!made.base` is the condition that catches this; `!made.created` did not.
    assert.equal(catchUp({ git, repo: dir, at: again.path, base: '7-fix' }).at, v2);
    assert.equal(fs.readFileSync(path.join(again.path, 'f.txt'), 'utf8'), 'v2\n');
  } finally {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* going away */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- a role that writes, based on another role

/** Commit a file from inside a worktree, on whatever branch it is standing on. Returns the new sha. */
function commitIn(at, file, body) {
  fs.writeFileSync(path.join(at, file), body);
  git(['add', file], at);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `add ${file}`], at);
  return git(['rev-parse', 'HEAD'], at);
}
const headOf = (at) => git(['rev-parse', 'HEAD'], at);

test('a worktree with commits of its own is never rewound onto the branch it started from', (t) => {
  // An implementer based on a planner's branch: the plan is committed once and never moves, so
  // "what the base is now" is behind everything the implementer has done since. Catching up to it
  // is a rewind, and it took the turn's uncommitted work with it.
  const dir = repo(t);
  const plan = commitOn(dir, '7-plan', 'plan.md', 'the plan\n');
  const impl = makeWorktree({ git, repo: dir, slug: 'gh-7-impl', branch: '7-impl', base: '7-plan' });
  assert.equal(headOf(impl.path), plan);
  commitIn(impl.path, 'fix.txt', 'first attempt\n');
  const mine = commitIn(impl.path, 'fix.txt', 'second attempt\n');
  fs.writeFileSync(path.join(impl.path, 'fix.txt'), 'not committed yet\n');

  const r = catchUp({ git, repo: dir, at: impl.path, base: '7-plan', placedAt: plan });
  assert.equal(r.moved, false);
  assert.match(r.reason, /ahead of 7-plan/);
  assert.equal(headOf(impl.path), mine, 'the branch is where the implementer left it');
  assert.equal(fs.readFileSync(path.join(impl.path, 'fix.txt'), 'utf8'), 'not committed yet\n', 'and so is the work in progress');
});

test('a role that committed keeps its commits when its base moves on without it', (t) => {
  // The planner revises the plan after the implementer has started. Neither branch contains the
  // other, and the implementer's commits are nobody's to throw away: it is told, not moved.
  const dir = repo(t);
  const plan = commitOn(dir, '7-plan', 'plan.md', 'the plan\n');
  const impl = makeWorktree({ git, repo: dir, slug: 'gh-7-impl', branch: '7-impl', base: '7-plan' });
  const mine = commitIn(impl.path, 'fix.txt', 'work\n');
  commitOn(dir, '7-plan', 'plan.md', 'the plan, revised\n');

  const r = catchUp({ git, repo: dir, at: impl.path, base: '7-plan', placedAt: plan });
  assert.equal(r.moved, false);
  assert.match(r.reason, /each moved on/);
  assert.equal(headOf(impl.path), mine);
  assert.equal(fs.readFileSync(path.join(impl.path, 'plan.md'), 'utf8'), 'the plan\n');
});

test('a reviewer that never committed follows a rewritten branch, scratch files and all', (t) => {
  // The implementer rebased and force-pushed: the reviewer's HEAD is no ancestor of the new tip,
  // but it is exactly where weawr put it, so nothing on it is the reviewer's. This is the case an
  // ancestry check alone gets wrong — it would leave the reviewer on code that no longer exists.
  const dir = repo(t);
  const v1 = commitOn(dir, '7-fix', 'fix.txt', 'first attempt\n');
  const review = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-review', base: '7-fix' });
  fs.writeFileSync(path.join(review.path, 'fix.txt'), 'a reviewer poking at it\n');

  git(['checkout', '-q', '7-fix'], dir);
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'rewritten\n');
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-a', '--amend', '-m', 'rewritten'], dir);
  const v2 = headOf(dir);
  git(['checkout', '-q', 'main'], dir);
  assert.equal(git(['merge-base', '--is-ancestor', v1, v2], dir), null, 'a real rewrite, not a fast-forward');

  const r = catchUp({ git, repo: dir, at: review.path, base: '7-fix', placedAt: v1 });
  assert.equal(r.moved, true);
  assert.equal(r.at, v2);
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'rewritten\n');
});

test('a worktree its agent already moved along the base is fast-forwarded the rest of the way', (t) => {
  // A reviewer that ran `git merge --ff-only` itself to look at a newer head is not where weawr
  // put it, and has no commits of its own either. Nothing is lost by moving it forwards.
  const dir = repo(t);
  const v1 = commitOn(dir, '7-fix', 'fix.txt', 'v1\n');
  const review = makeWorktree({ git, repo: dir, slug: 'gh-7-review', branch: '7-fix-review', base: '7-fix' });
  const v2 = commitOn(dir, '7-fix', 'fix.txt', 'v2\n');
  git(['merge', '-q', '--ff-only', v2], review.path);
  const v3 = commitOn(dir, '7-fix', 'fix.txt', 'v3\n');
  fs.writeFileSync(path.join(review.path, 'notes.txt'), 'untracked scratch\n');

  const r = catchUp({ git, repo: dir, at: review.path, base: '7-fix', placedAt: v1 });
  assert.equal(r.moved, true);
  assert.equal(r.at, v3);
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'v3\n');
  assert.equal(fs.existsSync(path.join(review.path, 'notes.txt')), true);
});

test('with no record of where a worktree was put, it is only ever moved forwards', (t) => {
  // A run from before weawr kept the record, or one picked up again after `weawr reset`. Without
  // it "has this role committed?" has no answer, so the only move made is the one that cannot lose
  // anything: a fast-forward, which git itself refuses when work in progress is in the way.
  const dir = repo(t);
  commitOn(dir, '7-plan', 'plan.md', 'the plan\n');
  const impl = makeWorktree({ git, repo: dir, slug: 'gh-7-impl', branch: '7-impl', base: '7-plan' });
  const mine = commitIn(impl.path, 'fix.txt', 'work\n');
  assert.equal(catchUp({ git, repo: dir, at: impl.path, base: '7-plan' }).moved, false);
  assert.equal(headOf(impl.path), mine);

  commitOn(dir, '8-fix', 'fix.txt', 'v1\n');
  const review = makeWorktree({ git, repo: dir, slug: 'gh-8-review', branch: '8-fix-review', base: '8-fix' });
  fs.writeFileSync(path.join(review.path, 'fix.txt'), 'in progress\n');
  commitOn(dir, '8-fix', 'fix.txt', 'v2\n');
  const blocked = catchUp({ git, repo: dir, at: review.path, base: '8-fix' });
  assert.equal(blocked.moved, false);
  assert.match(blocked.reason, /would not fast-forward/);
  assert.equal(fs.readFileSync(path.join(review.path, 'fix.txt'), 'utf8'), 'in progress\n');
});

// ---------------------------------------------------------------- keeping up with the base branch

/** A clone with a real `origin` behind it. Both go away when the test ends. */
function clone(t) {
  const origin = repo(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-clone-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* going away anyway */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['clone', '-q', origin, dir]);
  return { at: fs.realpathSync(dir), origin };
}

/** Commit a file on the branch `dir` is standing on — a pull request landing on origin. Returns the sha. */
function commit(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), body);
  git(['add', file], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `add ${file}`], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

test('a run is cut from the tip of main, not from a checkout that never pulled', (t) => {
  // The bug this exists for: merges land on origin, nothing pulls this checkout, and `git worktree
  // add` starts from its HEAD — so every run after the first merge builds on code that is already
  // behind, and its pull request arrives full of conflicts nobody wrote.
  const { at, origin } = clone(t);
  const merged = commit(origin, 'merged.txt', 'a pull request that landed\n');

  const made = makeWorktree({ git, repo: at, slug: 'gh-35', branch: 'herd/gh-35', base: 'main' });
  assert.equal(made.base, 'origin/main');
  assert.equal(git(['rev-parse', 'HEAD'], made.path), merged);
  assert.equal(fs.readFileSync(path.join(made.path, 'merged.txt'), 'utf8'), 'a pull request that landed\n');
  // the run's branch answers to nobody: cutting it from origin/main by name would have made main
  // its upstream, so `git push -u origin HEAD` in the worktree is still the agent's own decision
  assert.equal(git(['rev-parse', '--abbrev-ref', 'herd/gh-35@{upstream}'], made.path), null);
  // and the checkout itself is not moved by this — pullBase is what does that, deliberately
  assert.notEqual(git(['rev-parse', 'main'], at), merged);
});

test('the default branch is what the repository says it is', (t) => {
  const { at } = clone(t);
  assert.equal(defaultBranch({ git, repo: at }), 'main', 'origin/HEAD answers first');

  const solo = repo(t);
  assert.equal(defaultBranch({ git, repo: solo }), 'main', 'no remote: a local main will do');
  git(['checkout', '-q', '-b', 'trunk'], solo);
  git(['branch', '-D', 'main'], solo);
  assert.equal(defaultBranch({ git, repo: solo }), 'trunk', 'and finally: wherever it is standing');
});

test('the checkout the watcher lives in is fast-forwarded onto main', (t) => {
  // "worktree": "none" runs work in this directory, "herdr" cuts from its HEAD, and the config
  // reloaded before every poll is read out of it. It has to move too.
  const { at, origin } = clone(t);
  const merged = commit(origin, 'merged.txt', 'a pull request that landed\n');

  const pulled = pullBase({ git, repo: at, base: 'main' });
  assert.equal(pulled.pulled, true);
  assert.deepEqual({ at: pulled.at, ref: pulled.ref }, { at: merged, ref: 'origin/main' });
  assert.equal(git(['rev-parse', 'HEAD'], at), merged);
  assert.equal(fs.existsSync(path.join(at, 'merged.txt')), true);

  const again = pullBase({ git, repo: at, base: 'main' });
  assert.deepEqual({ pulled: again.pulled, reason: again.reason }, { pulled: false, reason: 'already up to date' });
});

test('keeping the checkout current can never lose what is in it', (t) => {
  // It is the maintainer's directory, not ours. Every one of these says why and changes nothing.
  const { at, origin } = clone(t);
  const stale = git(['rev-parse', 'HEAD'], at);
  commit(origin, 'merged.txt', 'a pull request that landed\n');

  fs.writeFileSync(path.join(at, 'wip.txt'), 'half a thought\n');
  git(['add', 'wip.txt'], at);
  assert.match(pullBase({ git, repo: at, base: 'main' }).reason, /uncommitted changes/);
  git(['rm', '-q', '-f', 'wip.txt'], at);

  git(['checkout', '-q', '-b', 'mine'], at);
  assert.match(pullBase({ git, repo: at, base: 'main' }).reason, /is on mine, not main/);
  git(['checkout', '-q', 'main'], at);

  commit(at, 'local.txt', 'work that was never pushed\n');
  const own = git(['rev-parse', 'HEAD'], at);
  assert.match(pullBase({ git, repo: at, base: 'main' }).reason, /have each moved on/);
  assert.equal(git(['rev-parse', 'HEAD'], at), own, 'still exactly where it was');
  assert.equal(fs.readFileSync(path.join(at, 'local.txt'), 'utf8'), 'work that was never pushed\n');

  assert.deepEqual(pullBase({ git, repo: at, base: null }), { pulled: false, reason: 'no base branch to pull' });
  // a base this checkout is not standing on is somebody else's branch, whether or not it exists
  assert.match(pullBase({ git, repo: at, base: 'no-such-branch' }).reason, /is on main, not no-such-branch/);
});

test('a later turn is caught up to what origin has, not to a stale local branch', (t) => {
  // The reviewer's second turn where the implementer pushed from a machine of its own: the local
  // branch is what this clone last heard, and it is not the code under review.
  const { at, origin } = clone(t);
  const wt = makeWorktree({ git, repo: at, slug: 'gh-35-review', branch: 'herd/gh-35-review', base: 'main' });
  const merged = commit(origin, 'merged.txt', 'pushed from somewhere else\n');

  const moved = catchUp({ git, repo: at, at: wt.path, base: 'main' });
  assert.deepEqual({ moved: moved.moved, at: moved.at, ref: moved.ref }, { moved: true, at: merged, ref: 'origin/main' });
  assert.equal(fs.readFileSync(path.join(wt.path, 'merged.txt'), 'utf8'), 'pushed from somewhere else\n');
});
