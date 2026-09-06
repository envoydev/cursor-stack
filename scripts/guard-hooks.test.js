// Behavior tests for the guard hooks, which had NO coverage at all - the hooks were ported from the
// peer stack and a port is exactly where a gate quietly stops gating. Each case pins a real
// regression: a silent evasion the gate exists to stop, or a false positive that blocked honest
// work. Both directions matter - a hook that fires on the wrong turn teaches the model to route
// around it, and the bypass it learns then defeats the gate on the turn that mattered.
//
// These drive the hooks the way Cursor does: the payload as JSON on stdin, an allow/deny permission
// object read back off stdout. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-guards-'));

function ask(hook, payload, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CURSOR_DOCS_PATH: path.join(TMP, 'docs'), ...env },
  });
  try { return JSON.parse(r.stdout).permission; } catch { return `UNPARSEABLE: ${r.stdout}${r.stderr}`; }
}
const shell = (hook, command, extra = {}, env = {}) => ask(hook, { command, ...extra }, env);
const heredoc = (body, target = 'plan.md') => `cat <<'EOF' > ${target}\n${body}\nEOF`;

// A repo with `files` staged fixtures past the commit gate's 2-file / 15-line trivial bar.
function repo(files = 0) {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A'); git('commit', '-qm', 'seed');
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x\n'.repeat(30));
  git('add', '-A');
  return dir;
}
const headOf = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
function receipt(dir, name, body) {
  const d = path.join(dir, '.cursor', 'docs', 'flow');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), body);
}
const inRepo = (dir, command, env = {}) =>
  ask('guard-ungated-commit.js', { command, cwd: dir }, { CURSOR_DOCS_PATH: path.join(dir, '.cursor', 'docs'), ...env });

test('guard-catastrophic-rm: unrecoverable targets are refused, ordinary cleanup is not', () => {
  const RM = 'guard-catastrophic-rm.js';
  assert.equal(shell(RM, 'rm -rf ~'), 'deny', 'home');
  assert.equal(shell(RM, 'rm -rf "$HOME"/*'), 'deny', 'quoted prefix with the glob outside');
  assert.equal(shell(RM, 'rm -rf /usr /lib /etc'), 'deny', 'the multi-arg system wipe');
  assert.equal(shell(RM, 'rm -rf bin obj node_modules'), 'allow', 'ordinary build cleanup');
  assert.equal(shell(RM, 'rm -rf .playwright'), 'allow', 'one named directory');
  assert.equal(shell(RM, heredoc('never run rm -rf / on this box')), 'allow', 'a document describing it is data');
});

test('guard-catastrophic-rm: the git verbs that destroy a tree, and only while it is dirty', () => {
  // Git destroys uncommitted work with no reflog behind it, and this guard had zero git coverage -
  // a destructive `git checkout --` passed every guard in the stack. Gated on ACTUAL loss, so the
  // overwhelmingly common case of resetting an already-clean checkout stays silent.
  const RM = 'guard-catastrophic-rm.js';
  const dirty = repo(1);
  const clean = repo(0);
  assert.equal(shell(RM, 'git reset --hard', { cwd: dirty }), 'deny', 'reset --hard with work to lose');
  assert.equal(shell(RM, 'git reset --hard', { cwd: clean }), 'allow', 'nothing to destroy');
  assert.equal(shell(RM, 'git checkout -- .', { cwd: dirty }), 'deny', 'checkout --');
  assert.equal(shell(RM, 'git clean -fd', { cwd: dirty }), 'deny', 'clean -f');
  assert.equal(shell(RM, 'git restore --staged f0.txt', { cwd: dirty }), 'allow', '--staged moves nothing on disk');
  assert.equal(shell(RM, "echo 'git reset --hard'", { cwd: dirty }), 'allow',
    'a quoted span is data - denying it teaches the obfuscation that defeats this gate for real');
});

test('guard-protected-force-push: a shared branch cannot be rewritten or deleted', () => {
  const FP = 'guard-protected-force-push.js';
  assert.equal(shell(FP, 'git push --force origin main'), 'deny');
  assert.equal(shell(FP, 'git push origin :main'), 'deny', 'the empty-source deletion refspec');
  assert.equal(shell(FP, 'git push --mirror origin'), 'deny');
  assert.equal(shell(FP, 'git push --force origin my-feature'), 'allow', 'a feature branch is yours');
  assert.equal(shell(FP, 'git push origin main'), 'allow', 'a fast-forward push is not a rewrite');
  assert.equal(shell(FP, 'echo "git push --force origin main"'), 'allow',
    'the verb must be the segment\'s own command, not a substring of another program\'s argument');
});

test('guard-ungated-commit: a non-trivial commit needs its receipt, a trivial one does not', () => {
  const big = repo(4);
  assert.equal(inRepo(big, 'git commit -m x'), 'deny', 'four fixtures and no receipt');
  assert.equal(inRepo(big, heredoc('then run git commit -m x')), 'allow', 'a plan describing a commit is data');
  const small = repo(0);
  fs.writeFileSync(path.join(small, 'seed.txt'), 'seed2\n');
  spawnSync('git', ['-C', small, 'add', '-A']);
  assert.equal(inRepo(small, 'git commit -m x'), 'allow', 'one file, one line - the rule\'s own exemption');
});

test('guard-ungated-commit: the five-line receipt contract', () => {
  // Each line answers a way a receipt was measured passing while recording nothing: `head:` proves
  // it reviewed THIS tree, `spec:` proves it covered the whole diff, `live-probe:` proves it ran the
  // thing, and the quoted words must be the USER asking for this act.
  const conformant = (dir) =>
    `VERIFIED the four fixtures\nauthorized: "commit it"\nhead: ${headOf(dir)}\nspec: 4 files - the fixtures\nlive-probe: tests green\n`;
  let dir = repo(4);
  receipt(dir, 'COMMIT-GATE', conformant(dir));
  assert.equal(inRepo(dir, 'git commit -m x'), 'allow', 'a conformant receipt passes');

  dir = repo(4);
  receipt(dir, 'COMMIT-GATE', 'VERIFIED the four fixtures\nauthorized: "commit it"\n');
  assert.equal(inRepo(dir, 'git commit -m x'), 'deny', 'the old two-line receipt no longer holds');

  dir = repo(4);
  receipt(dir, 'COMMIT-GATE',
    `VERIFIED x\nauthorized: "what time is it?"\nhead: ${headOf(dir)}\nspec: 4 files\nlive-probe: NOT RUN - no suite\n`);
  assert.equal(inRepo(dir, 'git commit -m x'), 'deny',
    'a quote with no commit verb records the user saying something, not asking for THIS act');

  dir = repo(4);
  receipt(dir, 'COMMIT-GATE', 'WAIVED - "just commit it, skip the review"\n');
  assert.equal(inRepo(dir, 'git commit -m x'), 'allow', 'an explicit waiver in the user\'s own words');
});

test('guard-ungated-commit: an absolute docs root inside the repo does not fail its own receipt', () => {
  // The receipt lives under the docs root, so it is itself an untracked changed file. Excluding it
  // only for a RELATIVE root meant an absolute in-repo root made every conformant receipt fail its
  // own `spec:` count - the gate blocking the commit it had just authorized.
  const dir = repo(4);
  const docs = path.join(dir, '.cursor', 'docs');
  receipt(dir, 'COMMIT-GATE',
    `VERIFIED the four fixtures\nauthorized: "commit it"\nhead: ${headOf(dir)}\nspec: 4 files\nlive-probe: tests green\n`);
  assert.equal(ask('guard-ungated-commit.js', { command: 'git commit -m x', cwd: dir }, { CURSOR_DOCS_PATH: docs }),
    'allow', 'an absolute in-repo docs root is excluded from the changed-file count');
});

test('guard-ungated-commit: publishing carries the same ceremony', () => {
  // `git push` puts the work where other people and CI get it, and a shared branch cannot be
  // un-pushed quietly. Nothing gated it before: replayed across four bundles on the peer stack,
  // every push and merge passed every guard.
  let dir = repo(0);
  assert.equal(inRepo(dir, 'git push origin main'), 'deny', 'no PUSH-GATE receipt');
  receipt(dir, 'PUSH-GATE',
    `VERIFIED one commit\nauthorized: "push it"\nhead: ${headOf(dir)}\nspec: 1 commit to origin/main\nlive-probe: tests green\n`);
  assert.equal(inRepo(dir, 'git push origin main'), 'allow', 'a conformant publish receipt');

  dir = repo(0);
  assert.equal(inRepo(dir, 'git push --dry-run origin main'), 'allow', 'a dry run publishes nothing');
  assert.equal(inRepo(dir, 'git push origin main', { CURSOR_PUSH_GATE: '0' }), 'allow',
    'the half switches off where the remote is already gated');
  assert.equal(inRepo(dir, 'ls -la'), 'allow', 'an unrelated command is never judged');
});
