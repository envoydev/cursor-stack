// scripts/memory-session.test.js - the memory sessionStart hook (hooks/memory-session.js), driven
// through stdin payloads against throwaway fixture projects, Cursor's own event/payload shapes
// (sessionStart, additional_context - see hooks/docs-session.js's own header for the contract this was
// ported against). NEVER touches ~/.memory-mcp or the real ~/.cursor - every test points HOME at a
// fresh empty temp dir so the account-file fallback lookup can never see real data even though this
// machine's own ~/.cursor exists.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

let DatabaseSync = null;
try { process.removeAllListeners('warning'); ({ DatabaseSync } = require('node:sqlite')); } catch {}
const skipNoSqlite = DatabaseSync ? false : 'node:sqlite unavailable on this Node (needs >= 22.13, or 22.12 with --experimental-sqlite) - db-backed hook tests skipped';

const HOOK = path.join(__dirname, '..', 'hooks', 'memory-session.js');
const SCHEMA = fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-schema.sql'), 'utf8');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function buildDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO memories (content_hash, content, tags, memory_type, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((r, i) => {
    insert.run(r.hash || `hash-${i}`, r.content, r.tags || '', r.memory_type || 'reference', r.created_at != null ? r.created_at : 1_000_000 - i, r.deleted_at != null ? r.deleted_at : null);
  });
  db.close();
}

// A throwaway project: a memory-mcp fixture db at the canonical 'project' level path (so the hook's own
// levelOfPath resolves it to 'project', proving the derivation end to end rather than falling back to
// 'unknown'), registered through .cursor/mcp.json exactly the way the installer writes it. An isolated,
// empty HOME means the account-fallback branch always finds nothing real.
function fixtureProject({ rows = null, relatedNames = null, registered = true } = {}) {
  const root = tmpDir('memory-session-');
  const home = tmpDir('memory-session-home-');
  const dbPath = path.join(root, '.memory-mcp', 'memory.db');
  if (rows) buildDb(dbPath, rows);
  if (registered) {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { memory: { command: 'uvx', args: ['--with', 'numpy', '--from', 'mcp-memory-service[sqlite]', 'memory', 'server'], env: { MCP_MEMORY_STORAGE_BACKEND: 'sqlite_vec', MCP_MEMORY_SQLITE_PATH: dbPath, MCP_MEMORY_SQLITE_PRAGMAS: 'busy_timeout=15000' } } },
    }));
  }
  if (relatedNames) {
    const docDir = path.join(root, '.cursor', 'docs', 'related-projects');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, 'RELATED-PROJECTS.md'), relatedNames.map((n) => `## ${n}\n<!-- id: ${n} -->\n`).join('\n'));
  }
  const hook = (payload, extra = {}) => spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extra },
  });
  return { root, home, dbPath, hook, rm: () => { rmDir(root); rmDir(home); } };
}

test('a session start with a registered, populated database pushes the memory block, headed and ordered, tool names named directly', { skip: skipNoSqlite }, () => {
  const p = fixtureProject({ relatedNames: ['sibling-a'] });
  try {
    const projectName = path.basename(p.root);
    buildDb(p.dbPath, [
      { content: 'own project note', tags: `project:${projectName}`, memory_type: 'reference', created_at: 300 },
      { content: 'a global preference', tags: '', memory_type: 'preference_signal', created_at: 200 },
      { content: 'a sibling note', tags: 'project:sibling-a', memory_type: 'reference', created_at: 100 },
    ]);
    const r = p.hook({ hook_event_name: 'sessionStart', workspace_roots: [p.root], cwd: p.root });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const text = out.additional_context;
    assert.strictEqual(typeof text, 'string');
    assert.match(text, /^Memory \(memory MCP, project\):/);
    const ownIdx = text.indexOf('own project note');
    const prefIdx = text.indexOf('a global preference');
    const sibIdx = text.indexOf('a sibling note');
    assert.ok(ownIdx > -1 && prefIdx > ownIdx && sibIdx > prefIdx, text);
    // No ToolSearch line - Cursor has no tool-search deferral, so the tools are named directly.
    assert.match(text, /memory_store \/ memory_search \/ memory_list/);
    assert.doesNotMatch(text, /ToolSearch/);
    // Proof this is the real end-to-end stdout, not a shape assumption.
    console.log('--- memory-session.js real stdout (fixture project) ---\n' + r.stdout + '\n--- end ---');
  } finally { p.rm(); }
});

test('an empty database is silent', { skip: skipNoSqlite }, () => {
  const p = fixtureProject({ rows: [] });
  try {
    const r = p.hook({ hook_event_name: 'sessionStart', workspace_roots: [p.root], cwd: p.root });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { p.rm(); }
});

test('no memory server registered for the project is silent', () => {
  const p = fixtureProject({ registered: false });
  try {
    const r = p.hook({ hook_event_name: 'sessionStart', workspace_roots: [p.root], cwd: p.root });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { p.rm(); }
});

test('garbage stdin is silent, exit 0', () => {
  const p = fixtureProject();
  try {
    const r = p.hook('{ this is not json at all ]]]', {});
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { p.rm(); }
});

test('a hook_event_name other than sessionStart is silent', () => {
  const p = fixtureProject();
  try {
    const r = p.hook({ hook_event_name: 'preToolUse', workspace_roots: [p.root], cwd: p.root });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { p.rm(); }
});

test('a 500-row database resolves in well under 1s', { skip: skipNoSqlite }, () => {
  const p = fixtureProject();
  try {
    const projectName = path.basename(p.root);
    const rows = [];
    for (let i = 0; i < 500; i++) rows.push({ content: `row ${i} ${'x'.repeat(60)}`, tags: i % 4 === 0 ? `project:${projectName}` : '', memory_type: i % 4 === 0 ? 'reference' : 'preference_signal', created_at: i });
    buildDb(p.dbPath, rows);
    const started = Date.now();
    const r = p.hook({ hook_event_name: 'sessionStart', workspace_roots: [p.root], cwd: p.root });
    const elapsed = Date.now() - started;
    assert.strictEqual(r.status, 0);
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
    assert.match(r.stdout, /^\{"additional_context"/);
  } finally { p.rm(); }
});

// --- stdin bound ---------------------------------------------------------------------------------
// A hook whose stdin is never closed must not hang until the harness's own hook timeout - readInput
// races the real read against a 2s bound and resolves empty rather than waiting forever. Driven
// directly against the exported function (not a spawned process) so the test does not itself need to
// hold a pipe open indefinitely to prove it.

test('readInput resolves to an empty payload after its bound when the stream never closes', async () => {
  const { readInput } = require('../hooks/memory-session.js');
  const fake = new EventEmitter();
  fake.setEncoding = () => {};
  const started = Date.now();
  const result = await readInput(fake);
  const elapsed = Date.now() - started;
  assert.deepStrictEqual(result, {});
  assert.ok(elapsed >= 1900, `resolved too early: ${elapsed}ms`);
  assert.ok(elapsed < 3500, `resolved too late: ${elapsed}ms`);
});

test('readInput resolves as soon as the stream ends, well before the bound', async () => {
  const { readInput } = require('../hooks/memory-session.js');
  const fake = new EventEmitter();
  fake.setEncoding = () => {};
  const started = Date.now();
  const p = readInput(fake);
  fake.emit('data', JSON.stringify({ hook_event_name: 'sessionStart' }));
  fake.emit('end');
  const result = await p;
  const elapsed = Date.now() - started;
  assert.deepStrictEqual(result, { hook_event_name: 'sessionStart' });
  assert.ok(elapsed < 500, `took ${elapsed}ms`);
});
