// scripts/memory-engine.test.js - the memory MCP engine (hooks/memory.js): path <-> level derivation,
// registration lookup (Cursor's .cursor/mcp.json, project then account), related-project names, and the
// session selection query over a real sqlite fixture database (scripts/fixtures/memory-schema.sql).
// NEVER touches ~/.memory-mcp or the real ~/.cursor - every database and mcp.json here is built fresh
// under os.tmpdir() and removed after its test.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const m = require('../hooks/memory.js');

let DatabaseSync = null;
try { process.removeAllListeners('warning'); ({ DatabaseSync } = require('node:sqlite')); } catch {}
const skipNoSqlite = DatabaseSync ? false : 'node:sqlite unavailable on this Node (needs >= 22.13, or 22.12 with --experimental-sqlite) - db-backed engine tests skipped';

const SCHEMA = fs.readFileSync(path.join(__dirname, 'fixtures', 'memory-schema.sql'), 'utf8');

// Builds a fixture db from the shipped schema and inserts one row per entry, newest (array index 0)
// getting the highest created_at so plain array order already reads newest-first unless a case
// overrides created_at itself.
function buildDb(dir, rows) {
  const file = path.join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO memories (content_hash, content, tags, memory_type, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((r, i) => {
    insert.run(
      r.hash || `hash-${i}`,
      r.content,
      r.tags || '',
      r.memory_type || 'reference',
      r.created_at != null ? r.created_at : 1_000_000 - i,
      r.deleted_at != null ? r.deleted_at : null,
    );
  });
  db.close();
  return file;
}
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// --- pathForLevel / levelOfPath -------------------------------------------------------------------

test('each level maps to its database and back', () => {
  const home = '/home/u';
  const projectRoot = '/work/app';
  const cases = [
    ['global', { home, projectRoot }, '/home/u/.memory-mcp/memory.db'],
    ['scoped', { home, space: 'work', projectRoot }, '/home/u/.memory-mcp/memory_work.db'],
    ['scoped', { home, projectRoot }, '/home/u/.memory-mcp/memory_default.db'],
    ['project', { home, projectRoot }, '/work/app/.memory-mcp/memory.db'],
  ];
  for (const [level, opts, want] of cases) {
    assert.strictEqual(m.pathForLevel(level, opts), path.normalize(want), level);
    assert.strictEqual(m.levelOfPath(want, { home, projectRoot }), level, want);
  }
});

test('an unknown level throws, a foreign path has no level', () => {
  const home = '/home/u';
  const projectRoot = '/work/app';
  assert.throws(() => m.pathForLevel('team', { home, projectRoot }), /level/);
  assert.strictEqual(m.levelOfPath('/elsewhere/memory.db', { home, projectRoot }), null);
  // A path merely under the scoped directory but not shaped memory_<space>.db is not scoped either.
  assert.strictEqual(m.levelOfPath('/home/u/.memory-mcp/notes.db', { home, projectRoot }), null);
});

// --- registeredDbPath ------------------------------------------------------------------------------

test('registeredDbPath reads the project .cursor/mcp.json memory entry first, expanding ~ and $HOME', () => {
  const root = tmpDir('memory-reg-');
  const home = tmpDir('memory-home-');
  try {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { memory: { command: 'uvx', args: [], env: { MCP_MEMORY_SQLITE_PATH: '~/.memory-mcp/memory.db' } } },
    }));
    assert.strictEqual(m.registeredDbPath(root, { home }), path.join(home, '.memory-mcp', 'memory.db'));

    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { memory: { env: { MCP_MEMORY_SQLITE_PATH: '$HOME/.memory-mcp/memory_work.db' } } },
    }));
    assert.strictEqual(m.registeredDbPath(root, { home }), path.join(home, '.memory-mcp', 'memory_work.db'));
  } finally { rmDir(root); rmDir(home); }
});

test('registeredDbPath falls back to the account ~/.cursor/mcp.json when the project has none', () => {
  const root = tmpDir('memory-reg-');
  const home = tmpDir('memory-home-');
  const config = tmpDir('memory-config-');
  try {
    // No project .cursor/mcp.json at all - falls straight to the account file (configDir stands in for
    // ~/.cursor so the test never touches the real one).
    fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify({
      mcpServers: { memory: { env: { MCP_MEMORY_SQLITE_PATH: path.join(home, '.memory-mcp', 'memory.db') } } },
    }));
    assert.strictEqual(m.registeredDbPath(root, { home, configDir: config }), path.join(home, '.memory-mcp', 'memory.db'));

    // A project .cursor/mcp.json with no memory entry still falls through to the account file.
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { serena: {} } }));
    assert.strictEqual(m.registeredDbPath(root, { home, configDir: config }), path.join(home, '.memory-mcp', 'memory.db'));

    // A project entry wins over the account one when both exist.
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { memory: { env: { MCP_MEMORY_SQLITE_PATH: path.join(root, '.memory-mcp', 'memory.db') } } },
    }));
    assert.strictEqual(m.registeredDbPath(root, { home, configDir: config }), path.join(root, '.memory-mcp', 'memory.db'));
  } finally { rmDir(root); rmDir(home); rmDir(config); }
});

test('registeredDbPath never throws: absent files, garbage JSON, no memory entry all read as not registered', () => {
  const root = tmpDir('memory-reg-');
  const home = tmpDir('memory-home-');
  const config = tmpDir('memory-config-');
  try {
    assert.strictEqual(m.registeredDbPath(root, { home, configDir: config }), null); // nothing exists yet
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), '{ not json');
    fs.writeFileSync(path.join(config, 'mcp.json'), 'also not json');
    assert.strictEqual(m.registeredDbPath(root, { home, configDir: config }), null);
  } finally { rmDir(root); rmDir(home); rmDir(config); }
});

// --- projectName -------------------------------------------------------------------------------

test('projectName is the git repo root basename, else the projectRoot basename', () => {
  const outer = tmpDir('memory-name-');
  try {
    const repo = path.join(outer, 'my-repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const sub = path.join(repo, 'nested', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    assert.strictEqual(m.projectName(sub), 'my-repo');

    const plain = path.join(outer, 'not-a-repo');
    fs.mkdirSync(plain);
    assert.strictEqual(m.projectName(plain), 'not-a-repo');
  } finally { rmDir(outer); }
});

test('projectName resolves the repo root even from inside a linked worktree, never the worktree\'s own folder name', () => {
  // `git rev-parse --show-toplevel` inside a linked worktree answers with the WORKTREE's own folder -
  // which may be named anything (a feature-branch scratch dir here) - not the project. projectName
  // must resolve through --git-common-dir (the one .git every worktree of a repo shares) instead.
  const outer = tmpDir('memory-worktree-');
  try {
    const repo = path.join(outer, 'my-repo');
    fs.mkdirSync(repo);
    let r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    assert.strictEqual(r.status, 0, r.stderr);
    r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
    assert.strictEqual(r.status, 0, r.stderr);
    const wt = path.join(outer, 'totally-differently-named-worktree');
    r = spawnSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: repo });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(m.projectName(wt), 'my-repo');
    assert.notStrictEqual(m.projectName(wt), 'totally-differently-named-worktree');
  } finally { rmDir(outer); }
});

// --- relatedProjects -----------------------------------------------------------------------------

test('relatedProjects reads RELATED-PROJECTS.md headings, else the generated .mdc rule, else []', () => {
  const root = tmpDir('memory-related-');
  const docsRoot = path.join(root, '.cursor', 'docs');
  try {
    // Neither present.
    assert.deepStrictEqual(m.relatedProjects(root, docsRoot), []);

    // The doc, present: one '## <name>' heading per sibling.
    const docDir = path.join(docsRoot, 'related-projects');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(path.join(docDir, 'RELATED-PROJECTS.md'), [
      '# Related projects', '',
      '## acme-billing-api', '<!-- id: acme-billing-api -->', '', '```yaml', 'location: ../acme-billing-api', '```', '',
      '## acme-frontend', '<!-- id: acme-frontend -->', '', '```yaml', 'location: ../acme-frontend', '```', '',
    ].join('\n'));
    assert.deepStrictEqual(m.relatedProjects(root, docsRoot), ['acme-billing-api', 'acme-frontend']);

    // The doc wins even when the rule also exists.
    const rulesDir = path.join(root, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'baseline-project-related-context.mdc'), '---\ndescription: x\n---\n- name: rule-only-sibling\n  location: ../x\n');
    assert.deepStrictEqual(m.relatedProjects(root, docsRoot), ['acme-billing-api', 'acme-frontend']);

    // The doc gone, the rule present - falls back to its 'name:' fields.
    fs.rmSync(docDir, { recursive: true, force: true });
    assert.deepStrictEqual(m.relatedProjects(root, docsRoot), ['rule-only-sibling']);
  } finally { rmDir(root); }
});

// --- selectForSession ------------------------------------------------------------------------------

test('preferences/corrections (own or untagged) come first, then this project\'s other memories, then related, each newest first within its group', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [
      { content: 'own newest', tags: 'project:myapp', memory_type: 'reference', created_at: 500 },
      { content: 'own oldest', tags: 'myapp', memory_type: 'learning', created_at: 100 }, // bare tag form
      { content: 'own preference', tags: 'project:myapp', memory_type: 'preference_signal', created_at: 350 },
      { content: 'a global preference', tags: '', memory_type: 'preference_signal', created_at: 400 },
      { content: 'a global correction', tags: '', memory_type: 'user_correction', created_at: 300 },
      { content: 'sibling note', tags: 'project:sibling-a', memory_type: 'reference', created_at: 450 },
    ]);
    const { text, counts } = m.selectForSession(file, { project: 'myapp', related: ['sibling-a'], capBytes: 100000 });
    const order = text.split('\n').map((l) => l.replace(/^- \[[^\]]+\] /, ''));
    // Group 1 (preference/correction, own-or-untagged) interleaves by recency regardless of whose
    // tag it carries - an own-tagged preference is never demoted behind an untagged one just because
    // it names a project. Group 2 (this project's other memories) and group 3 (related) follow.
    assert.deepStrictEqual(order, ['a global preference', 'own preference', 'a global correction', 'own newest', 'own oldest', 'sibling note']);
    assert.deepStrictEqual(counts, { preference: 3, own: 2, related: 1 });
  } finally { rmDir(dir); }
});

test('content longer than 400 chars is cut with a trailing ...', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [{ content: 'z'.repeat(450), tags: 'project:myapp', memory_type: 'reference' }]);
    const { text } = m.selectForSession(file, { project: 'myapp', capBytes: 100000 });
    assert.strictEqual(text, `- [project fact] ${'z'.repeat(400)}...`);
  } finally { rmDir(dir); }
});

test('a row that does not fit is skipped, never treated as the end of the list (continue, not break) - I4', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    // 'big' is newest (picked first by recency) and, even after the 400-char cut, still too large for
    // the cap below; 'small' is older but fits easily. The old `break`-on-first-miss behaviour would
    // have stopped at 'big' and never reached 'small' - this proves it does not.
    const file = buildDb(dir, [
      { content: 'b'.repeat(500), tags: 'project:myapp', memory_type: 'reference', created_at: 200 },
      { content: 'ok', tags: 'project:myapp', memory_type: 'reference', created_at: 100 },
    ]);
    const { text, counts } = m.selectForSession(file, { project: 'myapp', capBytes: 50 });
    assert.strictEqual(text, '- [project fact] ok');
    assert.strictEqual(counts.own, 1);
  } finally { rmDir(dir); }
});

test('tag matching is exact on the comma-split list, never a substring - "app" does not match "app-web"', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [
      { content: 'real own note', tags: 'project:app', memory_type: 'reference' },
      { content: 'a different project entirely', tags: 'project:app-web', memory_type: 'reference' },
      { content: 'bare form of a different project', tags: 'app-web', memory_type: 'reference' },
    ]);
    const { text, counts } = m.selectForSession(file, { project: 'app', capBytes: 100000 });
    assert.match(text, /real own note/);
    assert.doesNotMatch(text, /a different project entirely/);
    assert.doesNotMatch(text, /bare form of a different project/);
    assert.strictEqual(counts.own, 1);
  } finally { rmDir(dir); }
});

test('a preference tagged with another project is excluded everywhere - it is that project\'s local preference, not global', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [
      { content: 'scoped preference', tags: 'project:otherproject', memory_type: 'preference_signal' },
      { content: 'truly global preference', tags: '', memory_type: 'preference_signal' },
    ]);
    const { text, counts } = m.selectForSession(file, { project: 'myapp', related: [], capBytes: 100000 });
    assert.doesNotMatch(text, /scoped preference/);
    assert.match(text, /truly global preference/);
    assert.strictEqual(counts.preference, 1);
  } finally { rmDir(dir); }
});

test('agent: tagged rows are never selected, whatever else they carry', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [
      { content: 'an own-project row an agent saved', tags: 'project:myapp,agent:some-seat', memory_type: 'reference' },
      { content: 'an agent-saved global preference', tags: 'agent:some-seat', memory_type: 'preference_signal' },
      { content: 'a real own row', tags: 'project:myapp', memory_type: 'reference', created_at: 1 },
    ]);
    const { text, counts } = m.selectForSession(file, { project: 'myapp', capBytes: 100000 });
    assert.doesNotMatch(text, /an agent-saved/);
    assert.doesNotMatch(text, /an own-project row an agent saved/);
    assert.match(text, /a real own row/);
    assert.strictEqual(counts.own, 1);
    assert.strictEqual(counts.preference, 0);
  } finally { rmDir(dir); }
});

test('each printed line carries the friendly label, never the service\'s raw subtype spelling', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [
      { content: 'a preference row', tags: 'project:myapp', memory_type: 'preference_signal', created_at: 400 },
      { content: 'a correction row', tags: 'project:myapp', memory_type: 'user_correction', created_at: 300 },
      { content: 'a reference row', tags: 'project:myapp', memory_type: 'reference', created_at: 200 },
      { content: 'a learning row', tags: 'project:myapp', memory_type: 'learning', created_at: 100 },
      { content: 'an unvalidated-kind row', tags: 'project:myapp', memory_type: 'observation', created_at: 50 },
    ]);
    const { text } = m.selectForSession(file, { project: 'myapp', capBytes: 100000 });
    const lines = text.split('\n');
    assert.deepStrictEqual(lines, [
      '- [preference] a preference row',
      '- [correction] a correction row',
      '- [project fact] a reference row',
      '- [lesson] a learning row',
      '- [observation] an unvalidated-kind row',
    ]);
  } finally { rmDir(dir); }
});

test('a soft-deleted row (deleted_at set) is never selected', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [
      { content: 'deleted own row', tags: 'project:myapp', memory_type: 'reference', deleted_at: 12345 },
      { content: 'live own row', tags: 'project:myapp', memory_type: 'reference' },
    ]);
    const { text } = m.selectForSession(file, { project: 'myapp', capBytes: 100000 });
    assert.doesNotMatch(text, /deleted own row/);
    assert.match(text, /live own row/);
  } finally { rmDir(dir); }
});

test('the cap stops between memories, never inside one', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({ content: `${'a'.repeat(20)}-${i}`, tags: 'project:myapp', memory_type: 'reference', created_at: 100 - i }));
    const file = buildDb(dir, rows);
    const { text, counts } = m.selectForSession(file, { project: 'myapp', capBytes: 120 });
    const lines = text.split('\n');
    assert.strictEqual(lines.length, 3, text);
    assert.deepStrictEqual(lines.map((l) => l.match(/-(\d)$/)[1]), ['0', '1', '2']);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 120);
    assert.strictEqual(counts.own, 3);
    for (const l of lines) assert.match(l, /^- \[project fact\] a{20}-\d$/);
  } finally { rmDir(dir); }
});

test('a cap smaller than the first memory yields nothing, never a partial line', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const file = buildDb(dir, [{ content: 'a'.repeat(200), tags: 'project:myapp', memory_type: 'reference' }]);
    const { text, counts } = m.selectForSession(file, { project: 'myapp', capBytes: 10 });
    assert.strictEqual(text, '');
    assert.deepStrictEqual(counts, { own: 0, preference: 0, related: 0 });
  } finally { rmDir(dir); }
});

test('missing file, locked file and wrong-schema file all return { text: "" } without throwing', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    assert.deepStrictEqual(m.selectForSession(path.join(dir, 'nope.db'), { project: 'x' }), { text: '', counts: { own: 0, preference: 0, related: 0 } });

    const wrongFile = path.join(dir, 'wrong.db');
    const wdb = new DatabaseSync(wrongFile);
    wdb.exec('CREATE TABLE other (id INTEGER)');
    wdb.close();
    assert.deepStrictEqual(m.selectForSession(wrongFile, { project: 'x' }), { text: '', counts: { own: 0, preference: 0, related: 0 } });

    const lockedFile = buildDb(dir, [{ content: 'unreadable while locked', tags: 'project:x', memory_type: 'reference' }]);
    const writer = new DatabaseSync(lockedFile);
    writer.exec('BEGIN EXCLUSIVE');
    writer.prepare('INSERT INTO memories (content_hash, content, tags, memory_type, created_at) VALUES (?, ?, ?, ?, ?)').run('extra', 'x', 'project:x', 'reference', 1);
    try {
      assert.deepStrictEqual(m.selectForSession(lockedFile, { project: 'x' }), { text: '', counts: { own: 0, preference: 0, related: 0 } });
    } finally { writer.exec('ROLLBACK'); writer.close(); }
  } finally { rmDir(dir); }
});

test(
  'a WAL database in a read-only directory recovers through the immutable URI retry',
  { skip: skipNoSqlite || (process.platform === 'win32' ? 'chmod-based read-only directories are not reliable on Windows' : false) },
  () => {
    const outer = tmpDir('memory-wal-');
    const dbDir = path.join(outer, 'db');
    fs.mkdirSync(dbDir);
    const file = path.join(dbDir, 'memory.db');
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare('INSERT INTO memories (content_hash, content, tags, memory_type, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)').run('h1', 'wal note', 'project:demo', 'reference', 1000, null);
    db.close();
    fs.chmodSync(dbDir, 0o500);
    try {
      const { text, counts } = m.selectForSession(file, { project: 'demo', capBytes: 100000 });
      assert.match(text, /wal note/, 'the immutable-URI retry should have recovered the row');
      assert.strictEqual(counts.own, 1);
    } finally {
      fs.chmodSync(dbDir, 0o700);
      rmDir(outer);
    }
  },
);

test('a 500-row database selects in well under 1s', { skip: skipNoSqlite }, () => {
  const dir = tmpDir('memory-select-');
  try {
    const rows = [];
    for (let i = 0; i < 500; i++) {
      const kind = i % 3 === 0 ? 'preference_signal' : i % 3 === 1 ? 'learning' : 'reference';
      const tags = i % 5 === 0 ? 'project:myapp' : i % 5 === 1 ? 'project:sibling-a' : i % 5 === 2 ? 'agent:someone' : '';
      rows.push({ content: `row ${i} ${'x'.repeat(80)}`, tags, memory_type: kind, created_at: i });
    }
    const file = buildDb(dir, rows);
    const started = Date.now();
    const { counts } = m.selectForSession(file, { project: 'myapp', related: ['sibling-a'], capBytes: 100000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
    assert.ok(counts.own > 0 && counts.related > 0 && counts.preference > 0);
  } finally { rmDir(dir); }
});

// The engine loaded with path.win32 in place of path, so the Windows spelling rules are pinned on every
// CI platform: separators, a drive letter in another case, a '/'-spelled registration from the installer.
test('win32: a registration spelled with forward slashes or a drive letter in another case still maps to its level', () => {
  const file = path.join(__dirname, '..', 'hooks', 'memory.js');
  const mod = { exports: {} };
  const req = (name) => (name.replace(/^node:/, '') === 'path' ? path.win32 : require(name));
  const src = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
  new Function('require', 'module', 'exports', '__filename', '__dirname', src)(req, mod, mod.exports, file, path.dirname(file));
  const w = mod.exports;
  const opts = { home: 'C:\\Users\\dev', projectRoot: 'c:\\work\\app' };
  assert.strictEqual(w.levelOfPath('C:/Users/dev/.memory-mcp/memory.db', opts), 'global');
  assert.strictEqual(w.levelOfPath('c:\\users\\DEV\\.memory-mcp\\memory_work.db', opts), 'scoped');
  assert.strictEqual(w.levelOfPath('C:/work/app/.memory-mcp/memory.db', opts), 'project');
  assert.strictEqual(w.levelOfPath('C:/elsewhere/.memory-mcp/memory.db', opts), null);
});
