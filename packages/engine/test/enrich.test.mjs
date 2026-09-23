import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Enricher } from '../dist/enrich.js';

// The enricher refreshes what the tracker says about every task in the snapshot. A team that has
// finished a hundred issues this week must not cost a hundred GraphQL points every 90 seconds:
// that was two thirds of a shared hourly budget before anyone did anything (gymly#246).

const T0 = Date.parse('2026-09-22T00:00:00Z');
const DAY = 86400e3;

/** A tracker that answers in one call when asked for many, and remembers every ask. */
function batchingTracker() {
  const asks = [];
  return {
    asks,
    async issueStates(keys) {
      asks.push({ kind: 'batch', keys: [...keys] });
      return new Map(keys.map((k) => [k, { state: k === 'GH-100' ? 'closed' : 'open' }]));
    },
    async issueByKey(key) {
      asks.push({ kind: 'one', key });
      return { state: { name: 'open', type: 'unstarted' } };
    },
  };
}

/** A tracker that only knows one issue at a time (Linear, an older adapter). */
function oneAtATimeTracker() {
  const asks = [];
  return {
    asks,
    async issueByKey(key) {
      asks.push(key);
      return { state: { name: 'open', type: 'unstarted' } };
    },
  };
}

const issue = (key, bucket, finishedAt) => ({ key, bucket, finishedAt, prUrl: null, runs: [] });

function team({ inflight = 3, finishedThisWeek = 85, older = 10 } = {}) {
  const issues = [];
  for (let i = 0; i < inflight; i++) issues.push(issue(`GH-${i + 1}`, 'inflight', null));
  for (let i = 0; i < finishedThisWeek; i++) issues.push(issue(`GH-${100 + i}`, 'done', new Date(T0 - DAY).toISOString()));
  for (let i = 0; i < older; i++) issues.push(issue(`GH-${900 + i}`, 'done', new Date(T0 - 30 * DAY).toISOString()));
  return issues;
}

const settle = () => new Promise((r) => setImmediate(r));

function enricher(tracker, clock) {
  return new Enricher({ tracker, ghRepo: null, ghToken: null, host: 'github.com', clock });
}

test('a team of 85 finished issues is one call, and finished issues are not asked again for ten minutes', async () => {
  let now = T0;
  const tracker = batchingTracker();
  const e = enricher(tracker, () => now);
  const issues = team();

  e.refresh(issues, now); await settle();
  assert.equal(tracker.asks.length, 1, 'everything due goes in one ask');
  assert.equal(tracker.asks[0].kind, 'batch');
  assert.equal(tracker.asks[0].keys.length, 98, 'inflight, finished this week and older: all due on the first look');
  assert.equal(e.view().issues['GH-100'], 'closed');
  assert.equal(e.view().issues['GH-1'], 'open');

  now = T0 + 91_000;
  e.refresh(issues, now); await settle();
  assert.equal(tracker.asks.length, 2, 'ninety seconds on, something is due again');
  assert.deepEqual(tracker.asks[1].keys, ['GH-1', 'GH-2', 'GH-3'], 'only what is in flight is due every 90 s');

  now = T0 + 5 * 60_000;
  e.refresh(issues, now); await settle();
  assert.deepEqual(tracker.asks[2].keys, ['GH-1', 'GH-2', 'GH-3'], 'five minutes on, still only what is in flight');

  now = T0 + 11 * 60_000;
  e.refresh(issues, now); await settle();
  const keys = tracker.asks[3].keys;
  assert.equal(keys.length, 88, 'after ten minutes the ones finished this week are due, the old ones are not');
  assert.ok(!keys.includes('GH-900'));

  now = T0 + 31 * 60_000;
  e.refresh(issues, now); await settle();
  assert.ok(tracker.asks[4].keys.includes('GH-900'), 'after thirty minutes everything is due');
});

test('a batch that fails marks every issue in it asked, so it is not retried on the next tick', async () => {
  let now = T0;
  const asks = [];
  const tracker = { async issueStates(keys) { asks.push([...keys]); throw new Error('GitHub GraphQL: API rate limit already exceeded'); } };
  const log = [];
  const e = new Enricher({ tracker, ghRepo: null, ghToken: null, host: 'github.com', clock: () => now, log: (m) => log.push(m) });
  const issues = team({ inflight: 2, finishedThisWeek: 3, older: 0 });

  e.refresh(issues, now); await settle();
  assert.equal(asks.length, 1);
  assert.equal(e.view().issues['GH-1'], null);
  assert.match(e.lastError, /rate limit/);
  assert.equal(log.length, 1, 'one line for the batch, not one per issue');

  now = T0 + 2_000;
  e.refresh(issues, now); await settle();
  assert.equal(asks.length, 1, 'nothing is due two seconds later');

  now = T0 + 91_000;
  e.refresh(issues, now); await settle();
  assert.deepEqual(asks[1], ['GH-1', 'GH-2'], 'the in-flight ones are asked again on their own schedule');
});

test('a tracker that only reads one issue at a time is still read, a dozen a tick', async () => {
  let now = T0;
  const tracker = oneAtATimeTracker();
  const e = enricher(tracker, () => now);
  const issues = team({ inflight: 2, finishedThisWeek: 20, older: 0 });

  e.refresh(issues, now); await settle();
  assert.equal(tracker.asks.length, 12);
  e.refresh(issues, now); await settle();
  assert.equal(tracker.asks.length, 22, 'the next tick takes the rest');
  e.refresh(issues, now + 91_000); await settle();
  assert.deepEqual(tracker.asks.slice(22), ['GH-1', 'GH-2'], 'and after that only what is in flight');
});

test('a refresh in progress is not doubled by the next snapshot', async () => {
  let release;
  const tracker = { asks: 0, async issueStates() { this.asks++; await new Promise((r) => { release = r; }); return new Map(); } };
  const e = enricher(tracker, () => T0);
  const issues = team({ inflight: 1, finishedThisWeek: 0, older: 0 });
  e.refresh(issues, T0);
  e.refresh(issues, T0);
  await settle();
  assert.equal(tracker.asks, 1);
  release(new Map());
});

test('a merge the watcher saw lands at once: the PR is merged now, and the issue is asked again on the next tick, not in ten minutes', async () => {
  // The merge watcher reads the PR itself, once a minute. Before this, the moment it saw a merge
  // the task left the in-flight bucket, its TTL grew to ten minutes, and the dashboard kept
  // showing "issue open · PR open" from the enricher's last look until that TTL ran out.
  let now = T0;
  const tracker = batchingTracker();
  const e = enricher(tracker, () => now);
  const prUrl = 'https://github.com/o/r/pull/9';
  const inflight = [{ key: 'GH-1', bucket: 'inflight', finishedAt: null, prUrl, runs: [] }];
  e.prs.set(prUrl, { at: now, state: 'open' });
  e.refresh(inflight, now); await settle();
  assert.equal(tracker.asks.length, 1);
  assert.equal(e.view().issues['GH-1'], 'open');

  // Thirty seconds on, the watcher sees the merge; the task is finished now, so its TTL is ten minutes.
  now = T0 + 30_000;
  e.saw({ issueKey: 'GH-1', prUrl, prState: 'merged' }, now);
  assert.equal(e.view().prs[prUrl], 'merged', 'what GitHub told the watcher is the answer, without another ask');
  assert.equal(e.view().issues['GH-1'], 'open', 'the issue keeps what was last known until it is asked again — no flicker to unknown');

  const finished = [{ key: 'GH-1', bucket: 'merged', finishedAt: new Date(now).toISOString(), prUrl, runs: [] }];
  now = T0 + 31_000;
  e.refresh(finished, now); await settle();
  assert.equal(tracker.asks.length, 2, 'the next tick asks about the issue, not the next ten-minute mark');
  assert.deepEqual(tracker.asks[1].keys, ['GH-1']);

  now = T0 + 60_000;
  e.refresh(finished, now); await settle();
  assert.equal(tracker.asks.length, 2, 'and then it is on the finished schedule again');
});
