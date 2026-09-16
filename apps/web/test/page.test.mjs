// The console page against a fixture host: no repository, no herdr, no tracker — only the
// protocol. The page's own code is checked for what it may and may not talk to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, hostSnapshotSchema } from '@weawr/protocol';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

test('the page talks to weawr only through the client library and /api/v1; the old routes are gone from it', () => {
  const js = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.match(js, /new WeawrClient\(/);
  assert.match(js, /client\.subscribe\(/);
  for (const old of ['/api/state', '/api/events', '/api/tail', '/api/done', '/api/undone', '/api/tidy', '/api/exit', 'EventSource(']) assert.ok(!js.includes(old), `app.js still uses ${old}`);
  assert.ok(!/require\(|from '|import /.test(js), 'no module imports: it is a classic script');
  const html = fs.readFileSync(path.join(SRC, 'app.html'), 'utf8');
  assert.ok(html.indexOf('/client.js') < html.indexOf('/morph.js') && html.indexOf('/morph.js') < html.indexOf('/app.js'), 'the client and the morph load before the page');
  assert.ok(!/require\(|from '|import /.test(fs.readFileSync(path.join(SRC, 'morph.js'), 'utf8')), 'morph.js is a classic script too');
});

test('the built page is a static site: html, css, js, the client, and the brand assets', () => {
  for (const f of ['app.html', 'app.css', 'app.js', 'morph.js', 'unlock.html', 'client.js', 'assets/icons/favicon.svg', 'assets/logo/weawr-mark-reverse.svg']) assert.ok(fs.existsSync(path.join(DIST, f)), f);
  assert.match(fs.readFileSync(path.join(DIST, 'client.js'), 'utf8'), /window\.WeawrClient = /);
});

test('a fixture host that speaks the protocol is all the page needs: the client in Node reads it end to end', async (t) => {
  const { WeawrClient } = await import('@weawr/client');
  const snapshot = { protocolVersion: 1, hostname: 'fixture', version: '0.0.0', herdr: { connected: true, version: '9' }, generatedAt: new Date().toISOString(), teams: [{
    protocolVersion: 1, teamId: 'fx', id: 'app', name: 'app', repo: '/nowhere', tracker: 'github', generatedAt: new Date().toISOString(), revision: 12,
    owner: { status: 'online', pid: 1, version: '0.0.0', hostname: 'fixture', heartbeatAt: null, observedAt: new Date().toISOString() }, freshness: { herdrAt: null, trackerAt: null, trackerError: null },
    recipeRevision: 2, roles: ['impl'], rules: [{ name: 'impl', role: 'impl', match: 'label:ai', agent: 'claude', model: null, effort: null, basedOn: null, passes: 1, maxConcurrent: 2 }], maxConcurrent: 3, pollSeconds: 30,
    watcher: { version: '0.0.0', lastPoll: null, stale: false, workspaceId: null, pid: 1 }, counts: { running: 0, working: 0, alerts: 0, inflight: 0, merged: 0, done: 1 }, humanWaitMs: 0,
    production: { today: { finished: 1, merged: 0, workingMs: 60000, humanMs: 0 }, week: { finished: 1, merged: 0, workingMs: 60000, humanMs: 0 }, month: { finished: 1, merged: 0, workingMs: 60000, humanMs: 0 } },
    alerts: [], issues: [], live: { tracker: true, github: true, why: null }, capabilities: ['task.done'],
  }] };
  assert.ok(validate(hostSnapshotSchema, snapshot).ok);
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/snapshot') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocolVersion: 1, ok: true, result: snapshot, generatedAt: 'x' })); return; }
    if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(path.join(DIST, 'app.js'))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const client = new WeawrClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const s = await client.hostSnapshot();
  assert.equal(s.teams[0].name, 'app'); assert.equal(client.last.snapshot.teams[0].revision, 12);
});

test('six themes ship: Factorio (the default, overriding nothing) and five flat palettes, each scoped to its own body attribute', () => {
  const factorio = fs.readFileSync(path.join(SRC, 'themes', 'factorio.css'), 'utf8');
  assert.ok(!/\{[^}]*:[^}]*\}/.test(factorio.replace(/\/\*[\s\S]*?\*\//g, '')), 'factorio.css declares nothing: the default look is app.css');
  const names = ['clean', 'linear', 'github', 'tokyo-night', 'solarized-light'];
  for (const name of names) {
    const css = fs.readFileSync(path.join(SRC, 'themes', `${name}.css`), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{/g).map((r) => r.trim());
    assert.ok(rules.length >= 1, name);
    for (const r of rules) if (!/^@media/.test(r)) assert.ok(r.split(',').every((sel) => new RegExp(`^\\s*body\\[data-theme="${name}"\\]`).test(sel)), `${name}: not scoped: ${r}`);
    assert.match(css, /--ground:/, `${name} sets its palette`);
    assert.ok(fs.existsSync(path.join(DIST, 'themes', `${name}.css`)), `${name} shipped`);
  }
  // the flat structure every non-Factorio theme shares lives in app.css, once
  const app = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8');
  assert.match(app, /body\[data-theme\]:not\(\[data-theme="factorio"\]\) \.asm/);
  const js = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  assert.match(js, /var THEMES = \{ factorio: 'Factorio', clean: 'weawr clean', linear: 'Linear', github: 'GitHub', 'tokyo-night': 'Tokyo Night', 'solarized-light': 'Solarized Light' \}/);
  assert.match(js, /localStorage\.setItem\('weawr-theme'/);
  assert.match(js, /data-theme-pick=/);
  const html = fs.readFileSync(path.join(SRC, 'app.html'), 'utf8');
  assert.match(html, /id="theme-css"/); assert.match(html, /data-theme="\{\{theme\}\}"/);
});

test('the page never declares a function and a variable under one name (the belt once ate the connection state)', () => {
  // `var link = …` for the connection and `function link()` for the belt between two plants shared
  // a scope; with two teams on the floor the belt was called on the state object and rendering
  // died, which the console showed as "connecting…" for ever. A hoisted function and a var of the
  // same name is legal JavaScript, so it is checked here.
  const src = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const fns = new Set([...src.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  const vars = new Set([...src.matchAll(/^\s*var\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]));
  const both = [...fns].filter((n) => vars.has(n));
  assert.deepEqual(both, [], `declared as both a function and a var: ${both.join(', ')}`);
});

// A DOM small enough to be a fixture: the parts of it morph.js touches, and a parser for the
// markup these tests write (elements, attributes in double quotes, text).
function fakeDom() {
  class N {
    constructor(type, name, value) { this.nodeType = type; this.nodeName = name; this.nodeValue = value; this.childNodes = []; this.parentNode = null; this.attributes = []; }
    get id() { return this.getAttribute('id') || ''; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    hasAttribute(n) { return this.attributes.some((a) => a.name === n); }
    getAttribute(n) { const a = this.attributes.find((a) => a.name === n); return a ? a.value : null; }
    setAttribute(n, v) { const a = this.attributes.find((a) => a.name === n); if (a) a.value = v; else this.attributes.push({ name: n, value: v }); }
    removeAttribute(n) { this.attributes = this.attributes.filter((a) => a.name !== n); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c; }
    removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
    get outerHTML() { return this.nodeType === 3 ? this.nodeValue : `<${this.nodeName.toLowerCase()}${this.attributes.map((a) => ` ${a.name}="${a.value}"`).join('')}>${this.childNodes.map((c) => c.outerHTML).join('')}</${this.nodeName.toLowerCase()}>`; }
  }
  const parse = (html) => {
    const root = new N(11, '#document-fragment', null); let cur = root;
    for (const tok of html.split(/(<[^>]+>)/).filter(Boolean)) {
      if (tok[0] !== '<') cur.appendChild(new N(3, '#text', tok));
      else if (tok[1] === '/') cur = cur.parentNode;
      else { const [, name, attrs] = /^<([a-z0-9]+)(.*?)\/?>$/.exec(tok); const el = new N(1, name.toUpperCase(), null); for (const [, k, v] of attrs.matchAll(/([a-z-]+)="([^"]*)"/g)) el.setAttribute(k, v); cur.appendChild(el); if (!tok.endsWith('/>')) cur = el; }
    }
    return root;
  };
  const document = { createElement: () => ({ set innerHTML(h) { this.content = parse(h); } }) };
  const window = {};
  new Function('window', 'document', fs.readFileSync(path.join(SRC, 'morph.js'), 'utf8'))(window, document);
  const el = (html) => { const r = new N(1, 'DIV', null); for (const c of [...parse(html).childNodes]) r.appendChild(c); return r; };
  return { morph: window.morph, el, html: (n) => n.childNodes.map((c) => c.outerHTML).join('') };
}

test('morph patches what changed and keeps the nodes that did not, so a render is not a reload', () => {
  const { morph, el, html } = fakeDom();
  // the same markup again: nothing moves
  let root = el('<div class="a"><i class="led green"></i>text</div>');
  const led = root.firstChild.firstChild;
  morph(root, '<div class="a"><i class="led green"></i>text</div>');
  assert.equal(root.firstChild.firstChild, led);
  // text and attributes change in place; an attribute that went is removed
  morph(root, '<div class="a on"><i class="led red"></i>later</div>');
  assert.equal(root.firstChild.firstChild, led); assert.equal(led.getAttribute('class'), 'led red');
  assert.equal(html(root), '<div class="a on"><i class="led red"></i>later</div>');
  morph(root, '<div><i></i>later</div>');
  assert.equal(root.firstChild.firstChild, led); assert.equal(led.hasAttribute('class'), false);
  // children come and go at the end
  morph(root, '<div><i></i>later</div><p>new</p>');
  assert.equal(root.childNodes.length, 2); assert.equal(root.firstChild.firstChild, led);
  morph(root, '<div><i></i>later</div>');
  assert.equal(html(root), '<div><i></i>later</div>');
  // a keyed list: an entry gone from the front or added there leaves the other entries' nodes alone
  root = el('<a id="x">x</a><a id="y">y</a><a id="z">z</a>');
  const [x, y, z] = root.childNodes;
  morph(root, '<a id="y">y</a><a id="z">z</a>');
  assert.deepEqual(root.childNodes, [y, z]);
  morph(root, '<a id="w">w</a><a id="y">y2</a><a id="z">z</a>');
  assert.deepEqual(root.childNodes.slice(1), [y, z]); assert.equal(html(root), '<a id="w">w</a><a id="y">y2</a><a id="z">z</a>');
  morph(root, '<a id="z">z</a><a id="y">y2</a>');
  assert.deepEqual(root.childNodes, [z, y]);
  assert.notEqual(x.parentNode, root);
  // a different element in the same place is replaced, not patched
  root = el('<b>one</b>');
  morph(root, '<i>one</i>');
  assert.equal(html(root), '<i>one</i>');
});
