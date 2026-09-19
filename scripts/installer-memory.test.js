'use strict';
// scripts/installer-memory.test.js - the installers' memory MCP registration: level selection,
// keep-path-on-update, idempotence, a user's own server surviving, malformed/bad-input handling -
// both twins, driven end to end against throwaway sandboxes. Modeled on the peer stack's
// scripts/installer-memory.test.js, scoped to what cursor-stack actually has: no memory-import /
// autoMemoryEnabled here (that is a claude-stack-only concept - the auto-memory notes it imports
// from do not exist on this platform). Same shared-network posture as the peer file: the
// installers' own MCP-runtime version-pin resolution (npm view / pypi.org) hits the real network -
// this is an integration test, not a mock, and no attempt is made to stub it away. STACK_SOURCE_REPO
// points at a local clone of this repo's current tree (built once in test.before, this branch's
// commit) so the installers' own `ensure_source` clone-fallback never needs the real GitHub remote.
// NEVER touches the real ~/.cursor or ~/.memory-mcp - every sandbox gets its own HOME.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SH = path.join(ROOT, 'scripts', 'cursor-stack.sh');
const PS1 = path.join(ROOT, 'scripts', 'cursor-stack.ps1');

const hasPwsh = spawnSync('pwsh', ['-v'], { encoding: 'utf8' }).status === 0;
const skipNoPwsh = hasPwsh ? false : 'pwsh not installed - ps1 behavioral test skipped';
const TWINS = ['sh', 'ps1'];

const mkTmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true });

// One local clone of this repo's current tree, reused by every test via STACK_SOURCE_REPO. A plain
// `git clone <local path>` (no network) whose local branch is renamed to 'main' - the installers'
// own clone-fallback is hardcoded to `-b main`, and this branch is not it.
let SOURCE_CLONE = null;
test.before(() => {
  SOURCE_CLONE = mkTmp('installer-memory-src-');
  execFileSync('git', ['clone', '-q', ROOT, SOURCE_CLONE]);
  const branch = execFileSync('git', ['-C', SOURCE_CLONE, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (branch !== 'main') execFileSync('git', ['-C', SOURCE_CLONE, 'branch', '-m', branch, 'main']);
});
test.after(() => { if (SOURCE_CLONE) rmDir(SOURCE_CLONE); });

function sandbox() {
  const work = mkTmp('instmem-');
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, STACK_SOURCE_REPO: SOURCE_CLONE };
  return { work, repo, home, env, rm: () => rmDir(work) };
}

// run(): the happy path, throws (with stdout/stderr attached) on a non-zero exit - every test that
// expects success uses this so a regression fails loudly instead of silently reading a stale file.
function run(twin, sb, action, args = []) {
  if (twin === 'sh') return execFileSync('bash', [SH, action, ...args], { cwd: sb.repo, encoding: 'utf8', env: sb.env });
  return execFileSync('pwsh', ['-NoProfile', '-File', PS1, action, ...args], { cwd: sb.repo, encoding: 'utf8', env: sb.env });
}
// runExpectFail(): the boundary path - never throws, returns the spawnSync result so a test can
// assert the exit code and stderr directly.
function runExpectFail(twin, sb, action, args = []) {
  const bin = twin === 'sh' ? 'bash' : 'pwsh';
  const fullArgs = twin === 'sh' ? [SH, action, ...args] : ['-NoProfile', '-File', PS1, action, ...args];
  return spawnSync(bin, fullArgs, { cwd: sb.repo, encoding: 'utf8', env: sb.env });
}

const mcpPath = (sb) => path.join(sb.repo, '.cursor', 'mcp.json');
const mcpServers = (sb) => JSON.parse(fs.readFileSync(mcpPath(sb), 'utf8')).mcpServers;
const memEntry = (sb) => mcpServers(sb).memory;
const levelArg = (twin, level) => (twin === 'sh' ? [`memory-${level}`] : ['-MemoryLevel', level]);

for (const twin of TWINS) {
  const skip = twin === 'ps1' && skipNoPwsh;

  test(`${twin}: fresh install (no level word) -> global path, and a re-run is byte-identical`, { skip }, () => {
    const sb = sandbox();
    try {
      run(twin, sb, 'install');
      const e1 = memEntry(sb);
      assert.strictEqual(e1.command, 'uvx', `${twin}: command`);
      assert.ok(e1.args.includes('--with') && e1.args.includes('numpy'), `${twin}: --with numpy missing`);
      assert.ok(e1.args.some((a) => a.startsWith('mcp-memory-service[sqlite]')), `${twin}: [sqlite] extra missing: ${e1.args}`);
      assert.strictEqual(e1.env.MCP_MEMORY_STORAGE_BACKEND, 'sqlite_vec', `${twin}: backend`);
      assert.strictEqual(e1.env.MCP_MEMORY_SQLITE_PATH, path.join(sb.home, '.memory-mcp', 'memory.db'), `${twin}: global path`);
      // Native Windows PowerShell legitimately joins with '\\' (Join-Path); only a MIXED separator
      // (both '/' and '\\' in the same path) is ever wrong - so this only asserts on a platform where
      // '\\' can never be a real separator to begin with.
      if (process.platform !== 'win32') assert.ok(!e1.env.MCP_MEMORY_SQLITE_PATH.includes('\\'), `${twin}: a literal backslash leaked into the global db path: ${e1.env.MCP_MEMORY_SQLITE_PATH}`);
      assert.strictEqual(e1.env.MCP_MEMORY_SQLITE_PRAGMAS, 'busy_timeout=15000', `${twin}: pragma`);
      const before = fs.readFileSync(mcpPath(sb), 'utf8');
      run(twin, sb, 'install');
      const after = fs.readFileSync(mcpPath(sb), 'utf8');
      assert.strictEqual(after, before, `${twin}: a plain re-run must not rewrite an already-registered memory entry`);
    } finally { sb.rm(); }
  });

  test(`${twin}: memory-scoped with a space -> memory_<space>.db`, { skip }, () => {
    const sb = sandbox();
    try {
      run(twin, sb, 'install', twin === 'sh' ? ['myspace', 'memory-scoped'] : ['myspace', '-MemoryLevel', 'scoped']);
      const e = memEntry(sb);
      assert.strictEqual(e.env.MCP_MEMORY_SQLITE_PATH, path.join(sb.home, '.memory-mcp', 'memory_myspace.db'), `${twin}: scoped path`);
    } finally { sb.rm(); }
  });

  test(`${twin}: a level word is never itself swallowed as the space (paired with a real space word)`, { skip }, () => {
    const sb = sandbox();
    try {
      // 'someword' must become the space; 'memory-scoped' / '-MemoryLevel scoped' must be consumed
      // as the level and never concatenated into, or mistaken for, the space value.
      run(twin, sb, 'install', twin === 'sh' ? ['someword', 'memory-scoped'] : ['-Space', 'someword', '-MemoryLevel', 'scoped']);
      const e = memEntry(sb);
      assert.strictEqual(e.env.MCP_MEMORY_SQLITE_PATH, path.join(sb.home, '.memory-mcp', 'memory_someword.db'), `${twin}: space word must win, not the level word`);
    } finally { sb.rm(); }
  });

  test(`${twin}: memory-scoped with no space -> memory_default.db (the level word alone never becomes the space)`, { skip }, () => {
    const sb = sandbox();
    try {
      run(twin, sb, 'install', levelArg(twin, 'scoped'));
      const e = memEntry(sb);
      assert.strictEqual(e.env.MCP_MEMORY_SQLITE_PATH, path.join(sb.home, '.memory-mcp', 'memory_default.db'), `${twin}: default scoped path`);
    } finally { sb.rm(); }
  });

  test(`${twin}: memory-project -> <project>/.memory-mcp/memory.db, .gitignore = *`, { skip }, () => {
    const sb = sandbox();
    try {
      run(twin, sb, 'install', levelArg(twin, 'project'));
      const e = memEntry(sb);
      assert.strictEqual(e.env.MCP_MEMORY_SQLITE_PATH, path.join(fs.realpathSync(sb.repo), '.memory-mcp', 'memory.db'), `${twin}: project path`);
      if (process.platform !== 'win32') assert.ok(!e.env.MCP_MEMORY_SQLITE_PATH.includes('\\'), `${twin}: a literal backslash leaked into the project db path: ${e.env.MCP_MEMORY_SQLITE_PATH}`);
      const gi = fs.readFileSync(path.join(sb.repo, '.memory-mcp', '.gitignore'), 'utf8');
      assert.strictEqual(gi, '*\n', `${twin}: .memory-mcp/.gitignore content`);
    } finally { sb.rm(); }
  });

  test(`${twin}: memory-project resolves to the MAIN checkout even when installed from a linked worktree`, { skip }, () => {
    const sb = sandbox();
    try {
      const wt = path.join(sb.work, 'worktree');
      execFileSync('git', ['-C', sb.repo, 'worktree', 'add', '-q', '-b', 'feature', wt]);
      const args = levelArg(twin, 'project');
      if (twin === 'sh') execFileSync('bash', [SH, 'install', ...args], { cwd: wt, encoding: 'utf8', env: sb.env });
      else execFileSync('pwsh', ['-NoProfile', '-File', PS1, 'install', ...args], { cwd: wt, encoding: 'utf8', env: sb.env });
      const entry = JSON.parse(fs.readFileSync(path.join(wt, '.cursor', 'mcp.json'), 'utf8')).mcpServers.memory;
      assert.strictEqual(entry.env.MCP_MEMORY_SQLITE_PATH, path.join(fs.realpathSync(sb.repo), '.memory-mcp', 'memory.db'), `${twin}: project-level db must live under the MAIN checkout, never the worktree that installed it`);
      assert.ok(fs.existsSync(path.join(sb.repo, '.memory-mcp', '.gitignore')), `${twin}: .gitignore must land in the MAIN checkout's .memory-mcp, not the worktree's`);
      assert.ok(!fs.existsSync(path.join(wt, '.memory-mcp')), `${twin}: no .memory-mcp folder should exist inside the worktree itself`);
    } finally { sb.rm(); }
  });

  test(`${twin}: a level word that changes an existing registered path prints the transition line`, { skip }, () => {
    const sb = sandbox();
    try {
      run(twin, sb, 'install'); // registers at global (the default), no level word
      const before = memEntry(sb).env.MCP_MEMORY_SQLITE_PATH;
      const out = run(twin, sb, 'update', levelArg(twin, 'project'));
      const after = memEntry(sb).env.MCP_MEMORY_SQLITE_PATH;
      assert.notStrictEqual(after, before, `${twin}: the path must actually change`);
      assert.match(out, /memory: level global -> project: .*\(old memories stay in .*\)/, `${twin}: transition line missing or malformed:\n${out}`);
      assert.ok(out.includes(before), `${twin}: the OLD path must be named in the transition line`);
    } finally { sb.rm(); }
  });

  test(`${twin}: update over an old-shape registration keeps the custom path byte-for-byte, upgrades the rest, and leaves a hand-added server untouched`, { skip }, () => {
    const sb = sandbox();
    try {
      fs.mkdirSync(path.join(sb.repo, '.cursor'), { recursive: true });
      const seeded = {
        mcpServers: {
          memory: {
            command: 'uvx',
            args: ['--from', 'mcp-memory-service==10.0.0', 'memory', 'server'],
            env: { MCP_MEMORY_STORAGE_BACKEND: 'sqlite_vec', MCP_MEMORY_SQLITE_PATH: '/my/totally/custom/legacy-memory.db' },
          },
          'my-hand-added-server': { command: 'node', args: ['/opt/custom/my-server.js'], env: { MY_TOKEN: 'keep-me-untouched' } },
        },
      };
      fs.writeFileSync(mcpPath(sb), JSON.stringify(seeded, null, 2));
      run(twin, sb, 'update');
      const servers = mcpServers(sb);
      const e = servers.memory;
      assert.strictEqual(e.env.MCP_MEMORY_SQLITE_PATH, '/my/totally/custom/legacy-memory.db', `${twin}: custom path must survive byte-for-byte`);
      assert.ok(e.args.some((a) => a.startsWith('mcp-memory-service[sqlite]')), `${twin}: pin must upgrade to the [sqlite] extra: ${e.args}`);
      assert.ok(e.args.includes('--with') && e.args.includes('numpy'), `${twin}: --with numpy must be added`);
      assert.strictEqual(e.env.MCP_MEMORY_SQLITE_PRAGMAS, 'busy_timeout=15000', `${twin}: pragmas must be added`);
      assert.deepStrictEqual(servers['my-hand-added-server'], seeded.mcpServers['my-hand-added-server'], `${twin}: a hand-added, unrelated MCP server must survive untouched`);
    } finally { sb.rm(); }
  });

  test(`${twin}: a malformed .cursor/mcp.json is left untouched, install still exits 0`, { skip }, () => {
    const sb = sandbox();
    try {
      fs.mkdirSync(path.join(sb.repo, '.cursor'), { recursive: true });
      const garbage = '{ this is not valid json';
      fs.writeFileSync(mcpPath(sb), garbage);
      const out = run(twin, sb, 'install'); // throws if non-zero - proves the run does not abort
      assert.strictEqual(fs.readFileSync(mcpPath(sb), 'utf8'), garbage, `${twin}: a bad-shape mcp.json must be left byte-for-byte untouched`);
      assert.match(out, /not valid JSON|wiring failed/i, `${twin}: the run must say why it left the file alone`);
    } finally { sb.rm(); }
  });
}

test('sh: two memory level words in one run -> usage error, nothing written', () => {
  const sb = sandbox();
  try {
    const r = runExpectFail('sh', sb, 'install', ['memory-scoped', 'memory-project']);
    assert.notStrictEqual(r.status, 0, 'a conflicting pair of level words must fail, not silently pick one');
    assert.match(r.stderr, /only one memory level word/i);
    assert.ok(!fs.existsSync(mcpPath(sb)), 'nothing should be written before the usage error');
  } finally { sb.rm(); }
});

test('ps1: an invalid -MemoryLevel value -> parameter validation error, nothing written', { skip: skipNoPwsh }, () => {
  const sb = sandbox();
  try {
    const r = runExpectFail('ps1', sb, 'install', ['-MemoryLevel', 'bogus']);
    assert.notStrictEqual(r.status, 0, 'an out-of-set -MemoryLevel value must fail, not silently pick a default');
    assert.ok(!fs.existsSync(mcpPath(sb)), 'nothing should be written before the parameter validation error');
  } finally { sb.rm(); }
});

test('sh: SCOPE=global refuses memory-project -> usage error, nothing written', () => {
  const sb = sandbox();
  sb.env.SCOPE = 'global';
  try {
    const r = runExpectFail('sh', sb, 'install', ['memory-project']);
    assert.notStrictEqual(r.status, 0, 'memory-project at global scope must fail, not silently adopt this repo as the account-wide db');
    assert.match(r.stderr, /memory-project.*global|SCOPE=global/i);
    assert.ok(!fs.existsSync(path.join(sb.home, '.cursor', 'mcp.json')), 'nothing should be written to the account mcp.json before the usage error');
  } finally { sb.rm(); }
});

test('ps1: SCOPE=global refuses -MemoryLevel project -> usage error, nothing written', { skip: skipNoPwsh }, () => {
  const sb = sandbox();
  sb.env.SCOPE = 'global';
  try {
    const r = runExpectFail('ps1', sb, 'install', ['-MemoryLevel', 'project']);
    assert.notStrictEqual(r.status, 0, 'memory-project at global scope must fail, not silently adopt this repo as the account-wide db');
    assert.ok(!fs.existsSync(path.join(sb.home, '.cursor', 'mcp.json')), 'nothing should be written to the account mcp.json before the usage error');
  } finally { sb.rm(); }
});
