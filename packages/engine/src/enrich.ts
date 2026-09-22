// What the tracker and GitHub say about a team's tasks — is the issue closed, is the PR merged,
// is there a PR for this branch — refreshed on a budget and remembered. Facts from those systems
// stay theirs; this only asks and records when it asked. Ported from the console into the owner,
// which already holds the tracker and the GitHub token.
import * as _pr from './adapters/pr.mjs';
const { prForBranch, prState } = _pr as Record<string, any>;

// What is in flight is asked about every 90 s; what finished this week every 10 min; the rest
// every 30 min. A tracker that can answer for many issues at once (`issueStates`) is asked once
// per tick for every issue that is due, whatever their number: one GraphQL point. One that only
// knows `issueByKey` is asked a dozen a tick. The 90 s window used to cover everything finished
// this week too, and a team a week old was paying a point per finished issue every 90 s — two
// thirds of a shared hourly budget, before an agent or a person had asked GitHub anything.
const LIVE_TTL = 90_000;
const RECENT_TTL = 10 * 60_000;
const OLD_TTL = 30 * 60_000;
const WEEK = 7 * 86400e3;
/** How many single asks (one issue, one PR, one branch) a tick may make. */
const ASKS_PER_TICK = 12;

export interface EnrichmentSources {
  tracker: any | null;
  ghRepo: string | null;
  ghToken: string | null;
  host: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  clock?: () => number;
}

const closedOf = (issue: any) => !!issue && (/^(completed|canceled)$/.test(issue.state?.type || '') || /^closed$/i.test(issue.state?.name || ''));

export class Enricher {
  issues = new Map<string, { at: number; state: string | null; name?: string | null; error?: string }>();
  prs = new Map<string, { at: number; state: string | null; error?: string }>();
  branches = new Map<string, { at: number; url: string | null; state: string | null; error?: string }>();
  busy = false;
  lastAskedAt: number | null = null;
  lastError: string | null = null;
  constructor(readonly sources: EnrichmentSources) {}

  /** The maps as the projection reads them. */
  view() {
    return {
      issues: Object.fromEntries([...this.issues].map(([k, v]) => [k, v.state])),
      prs: Object.fromEntries([...this.prs].map(([k, v]) => [k, v.state])),
      branches: Object.fromEntries([...this.branches].filter(([, v]) => v.url).map(([k, v]) => [k, v.url])),
    };
  }

  /** Refresh what is due for these tasks, in the background; the next snapshot reads the cache. */
  refresh(issues: any[], now = this.sources.clock?.() ?? Date.now()): void {
    if (this.busy) return;
    const { tracker, ghRepo, ghToken, host, fetchImpl, log = () => {} } = this.sources;
    const dueIssues: string[] = [];
    const due: any[] = [];
    for (const iss of issues) {
      const ttl = iss.bucket === 'inflight' ? LIVE_TTL
        : iss.finishedAt && now - Date.parse(iss.finishedAt) < WEEK ? RECENT_TTL
        : OLD_TTL;
      if (tracker && now - (this.issues.get(iss.key)?.at || 0) > ttl) dueIssues.push(iss.key);
      if (iss.prUrl && this.prs.get(iss.prUrl)?.state !== 'merged' && now - (this.prs.get(iss.prUrl)?.at || 0) > ttl) due.push({ kind: 'pr', url: iss.prUrl });
      if (!iss.prUrl && ghRepo) for (const r of iss.runs) {
        if (!r.branch) continue;
        const b = this.branches.get(r.branch);
        if (b?.state === 'merged' || now - (b?.at || 0) <= ttl) continue;
        due.push({ kind: 'branch', branch: r.branch });
      }
    }
    const batched = typeof tracker?.issueStates === 'function';
    if (!batched) for (const key of dueIssues) due.push({ kind: 'issue', key });
    if (!due.length && !(batched && dueIssues.length)) return;
    this.busy = true;
    (async () => {
      if (batched && dueIssues.length) await this.askMany(tracker, dueIssues, log);
      for (const d of due.slice(0, ASKS_PER_TICK)) {
        const at = this.sources.clock?.() ?? Date.now();
        try {
          if (d.kind === 'issue') {
            const issue = await tracker.issueByKey(d.key);
            this.issues.set(d.key, { at, state: issue ? (closedOf(issue) ? 'closed' : 'open') : null, name: issue?.state?.name || null });
          } else if (d.kind === 'branch') {
            const pr = await prForBranch({ repo: ghRepo, branch: d.branch, token: ghToken, host, fetchImpl });
            this.branches.set(d.branch, { at, url: pr?.url || null, state: pr?.state || null });
            if (pr) this.prs.set(pr.url, { at, state: pr.state });
          } else {
            const pr = await prState(d.url, { token: ghToken, host, fetchImpl });
            this.prs.set(d.url, { at, state: pr.state });
          }
          this.lastAskedAt = at; this.lastError = null;
        } catch (e: any) {
          this.lastError = e.message;
          if (d.kind === 'issue') this.issues.set(d.key, { at, state: null, error: e.message });
          else if (d.kind === 'branch') this.branches.set(d.branch, { at, url: null, state: null, error: e.message });
          else this.prs.set(d.url, { at, state: null, error: e.message });
          log(`enrich: ${d.kind === 'issue' ? d.key : d.kind === 'branch' ? d.branch : d.url}: ${String(e.message).slice(0, 120)}`);
        }
      }
      this.busy = false;
    })();
  }

  /** Every due issue in one ask. A failure is one line and marks them all asked: the next tick is not a retry. */
  private async askMany(tracker: any, keys: string[], log: (m: string) => void): Promise<void> {
    const at = this.sources.clock?.() ?? Date.now();
    try {
      const states: Map<string, { state: string } | null> = await tracker.issueStates(keys);
      for (const key of keys) {
        const found = states.get(key);
        this.issues.set(key, { at, state: found ? found.state : null, name: found?.state ?? null });
      }
      this.lastAskedAt = at; this.lastError = null;
    } catch (e: any) {
      this.lastError = e.message;
      // What was known stays known; the failure is recorded against it and the next tick is not a retry.
      for (const key of keys) this.issues.set(key, { at, state: this.issues.get(key)?.state ?? null, error: e.message });
      log(`enrich: ${keys.length} issue(s): ${String(e.message).slice(0, 120)}`);
    }
  }
}
