// scripts/docs-migrate.test.js - the installers' docs-domain migration, both twins, in throwaway git repos.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SH = path.join(__dirname, 'cursor-stack.sh');
const PS1 = path.join(__dirname, 'cursor-stack.ps1');
const ENGINE = path.join(__dirname, '..', 'hooks', 'docs.js');

// This repo has no installer harness: a full run needs the network and every prerequisite, and the migration is
// pure file work. So the SHIPPED function bodies are cut out of each twin by name and run on their own - the .sh
// under the installer's own `set -euo pipefail`, the .ps1 under its own ErrorActionPreference Stop, with each
// twin's own log and repo-root helpers - so what runs is exactly what ships, and a step that would end the whole
// install ends this run too (the marker line after the call never prints).
function cut(file, names, header, stripComment) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  return names.map((name) => {
    const start = lines.findIndex((l) => header(name).test(l));
    if (start < 0) throw new Error(`${path.basename(file)}: no function ${name}`);
    if (stripComment(lines[start]).trim().endsWith('}')) return lines[start];
    const end = lines.indexOf('}', start);
    if (end < 0) throw new Error(`${path.basename(file)}: ${name} has no closing brace at column 0`);
    return lines.slice(start, end + 1).join('\n');
  }).join('\n\n');
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const SH_FNS = cut(SH, ['log', '_migrate_docs_file', '_enable_docs_domain', 'migrate_docs_domains'],
  (n) => new RegExp(`^${escapeRe(n)}\\(\\) *\\{`), (l) => l.replace(/\s+#.*$/, ''));
const PS_FNS = cut(PS1, ['Log', 'Get-RepoRoot', 'Move-DocsFile', 'Enable-DocsDomain', 'Move-DocsDomains'],
  (n) => new RegExp(`^function ${escapeRe(n)}\\b`), (l) => l);
const DONE = 'MIGRATION-RETURNED';

const baseEnv = (extra) => ({ ...process.env, CURSOR_DOCS_PATH: '', ...extra });
const runSh = (root, extra = {}) => spawnSync('bash', ['-c', `set -euo pipefail\n${SH_FNS}\nmigrate_docs_domains\necho ${DONE}`], { cwd: root, encoding: 'utf8', env: baseEnv(extra) });
function runPs(root, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-migrate-ps-'));
  const script = path.join(dir, 'run.ps1');
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'\n${PS_FNS}\nMove-DocsDomains\n'${DONE}'\n`);
  try { return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { cwd: root, encoding: 'utf8', env: baseEnv(extra) }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const TWINS = [
  // On Windows the `bash` a PATH search finds may be the WSL launcher rather than Git Bash, and the twin that
  // ships there is the .ps1 - the .sh half runs on the two platforms it ships for.
  { name: 'sh', run: runSh, skip: process.platform === 'win32' ? 'the .sh twin is not run on Windows' : false },
  { name: 'ps1', run: runPs, skip: hasPwsh ? false : 'pwsh not installed - the .ps1 twin is not run here' },
];

function project(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-migrate-')));
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init: ${git.stderr}`);
  const write = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  // Every entry but .git, byte for byte - a link recorded as its target, never followed.
  const snapshot = () => {
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (rel === '.git') continue;
        if (e.isSymbolicLink()) out[rel] = `link -> ${fs.readlinkSync(p)}`;
        else if (e.isDirectory()) walk(p);
        else out[rel] = fs.readFileSync(p, 'utf8');
      }
    };
    walk(root);
    return out;
  };
  const engine = (args, docsPath = '.cursor/docs') => spawnSync(process.execPath, [ENGINE, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CURSOR_DOCS_PATH: docsPath, CLAUDE_STACK_DOCS_PATH: '', CLAUDE_DOCS_PATH: '', CURSOR_DOCS_VERSIONING: '', CLAUDE_STACK_DOCS_VERSIONING: '' },
  });
  return {
    root, write, snapshot, engine,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    rm: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const D = '.cursor/docs';
const CODE = '# Code style\n\n## csharp\n<!-- id: csharp -->\n<!-- covers: src/**.cs -->\nBraces open on their own line.\n';
const RELATED = '# Related projects\n\n## billing api\n<!-- id: billing-api -->\nThe billing service this repo calls.\n';
const ASSESS = '# Assessment\n\nFindings.\n';
const PAPER = '# Cross-repo plan\n\nA working paper, never a domain.\n';
const OLD_LAYOUT = {
  [`${D}/PROJECT-CODE-STYLE.md`]: CODE,
  [`${D}/architecture/ASSESSMENT.md`]: ASSESS,
  [`${D}/related-context/PROJECT-RELATED-CONTEXT.md`]: RELATED,
  [`${D}/related-context/plan-billing.md`]: PAPER,
};
const MINIMAL = '{}\n';
const ran = (r, twin) => assert.ok(r.stdout.includes(DONE), `${twin}: the migration returned - stdout ${r.stdout} stderr ${r.stderr}`);
const listed = (p, docsPath) => p.engine(['files'], docsPath).stdout;

const CASES = [
  {
    name: 'update over the pre-domain layout switches on code-style/ and related-projects/, and nothing else',
    check(twin, run) {
      const p = project(OLD_LAYOUT);
      try {
        const r = run(p.root);
        ran(r, twin);
        assert.strictEqual(p.read(`${D}/code-style/CODE-STYLE.md`), CODE, 'moved byte-identical');
        assert.strictEqual(p.read(`${D}/related-projects/RELATED-PROJECTS.md`), RELATED, 'moved byte-identical');
        assert.strictEqual(p.read(`${D}/code-style/watch.json`), MINIMAL);
        assert.strictEqual(p.read(`${D}/related-projects/watch.json`), MINIMAL);
        assert.ok(p.exists(`${D}/quality/ASSESSMENT.md`), 'the assessment moved to quality/');
        assert.strictEqual(p.read(`${D}/related-context/plan-billing.md`), PAPER, 'the working paper stays where it is');
        for (const bare of ['quality', 'related-context', 'architecture']) assert.ok(!p.exists(`${D}/${bare}/watch.json`), `no watch.json in ${bare}/`);
        assert.match(r.stdout, /docs domain \(code style\): wrote an empty code-style\/watch\.json/);
        assert.match(r.stdout, /docs domain \(related projects\): wrote an empty related-projects\/watch\.json/);
        const files = listed(p);
        assert.match(files, /code-style\/CODE-STYLE\.md/, 'the engine reads code-style/ as a domain');
        assert.match(files, /related-projects\/RELATED-PROJECTS\.md/, 'the engine reads related-projects/ as a domain');
        assert.doesNotMatch(files, /quality\/|related-context\//, 'and never the two bare folders');
        const lint = p.engine(['lint']);
        assert.strictEqual(lint.status, 0, lint.stdout);
        assert.match(lint.stdout, /^0 problems/m);
      } finally { p.rm(); }
    },
  },
  {
    name: 're-run changes nothing',
    check(twin, run) {
      const p = project(OLD_LAYOUT);
      try {
        ran(run(p.root), twin);
        const before = p.snapshot();
        const again = run(p.root);
        ran(again, twin);
        assert.deepStrictEqual(p.snapshot(), before);
        assert.doesNotMatch(again.stdout, /docs domain|docs migration/, 'and says nothing about the docs');
      } finally { p.rm(); }
    },
  },
  {
    name: 'an install an earlier run migrated is switched on too - keyed on the doc at its new path',
    check(twin, run) {
      const p = project({ [`${D}/code-style/CODE-STYLE.md`]: CODE, [`${D}/related-projects/RELATED-PROJECTS.md`]: RELATED });
      try {
        assert.doesNotMatch(listed(p), /CODE-STYLE|RELATED-PROJECTS/, 'before: the engine sees neither folder');
        ran(run(p.root), twin);
        assert.strictEqual(p.read(`${D}/code-style/watch.json`), MINIMAL);
        assert.strictEqual(p.read(`${D}/related-projects/watch.json`), MINIMAL);
        assert.match(listed(p), /code-style\/CODE-STYLE\.md[\s\S]*related-projects\/RELATED-PROJECTS\.md/, 'after: both are domains');
      } finally { p.rm(); }
    },
  },
  {
    name: 'an existing watch.json is never touched',
    check(twin, run) {
      const own = '{"sourceRoots":["app"],"watch":[{"kind":"C# style","globs":["app/**.cs"],"sections":["CODE-STYLE#csharp"]}]}';
      const p = project({ [`${D}/code-style/CODE-STYLE.md`]: CODE, [`${D}/code-style/watch.json`]: own, [`${D}/related-projects/RELATED-PROJECTS.md`]: RELATED });
      try {
        const r = run(p.root);
        ran(r, twin);
        assert.strictEqual(p.read(`${D}/code-style/watch.json`), own, 'byte-identical, no newline added');
        assert.doesNotMatch(r.stdout, /docs domain \(code style\)/);
        assert.strictEqual(p.read(`${D}/related-projects/watch.json`), MINIMAL, 'the other folder is still switched on');
      } finally { p.rm(); }
    },
  },
  {
    name: 'no capture doc, no watch.json - quality/, related-context/ and a doc-less code-style/ stay bare',
    check(twin, run) {
      const p = project({
        [`${D}/quality/ASSESSMENT.md`]: ASSESS,
        [`${D}/related-context/plan-billing.md`]: PAPER,
        [`${D}/code-style/references/naming.md`]: '# Naming\n',
      });
      try {
        const before = p.snapshot();
        ran(run(p.root), twin);
        assert.deepStrictEqual(p.snapshot(), before);
      } finally { p.rm(); }
    },
  },
  {
    name: 'a fresh project gets no docs folder at all',
    check(twin, run) {
      const p = project({ 'src/Program.cs': 'class P {}\n' });
      try {
        ran(run(p.root), twin);
        assert.ok(!p.exists('.cursor'), 'nothing created');
      } finally { p.rm(); }
    },
  },
  {
    name: 'CURSOR_DOCS_PATH is honoured',
    check(twin, run) {
      const p = project({ 'docs/PROJECT-CODE-STYLE.md': CODE, [`${D}/code-style/CODE-STYLE.md`]: CODE });
      try {
        ran(run(p.root, { CURSOR_DOCS_PATH: 'docs/' }), twin);
        assert.strictEqual(p.read('docs/code-style/watch.json'), MINIMAL);
        assert.ok(!p.exists(`${D}/code-style/watch.json`), 'the default root is not the docs root here');
        assert.match(listed(p, 'docs'), /docs\/code-style\/CODE-STYLE\.md/);
      } finally { p.rm(); }
    },
  },
  {
    name: 'a dangling watch.json link is left alone, and nothing is written through it',
    skip: process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false,
    check(twin, run) {
      const p = project({ [`${D}/code-style/CODE-STYLE.md`]: CODE });
      try {
        // The target's folder EXISTS, so a write that followed the link would land - its absence afterwards is the proof.
        const target = path.join(p.root, 'elsewhere', 'watch.json');
        fs.mkdirSync(path.dirname(target));
        fs.symlinkSync(target, path.join(p.root, D, 'code-style', 'watch.json'));
        ran(run(p.root), twin);
        assert.strictEqual(fs.readlinkSync(path.join(p.root, D, 'code-style', 'watch.json')), target);
        assert.ok(!fs.existsSync(target), 'the link target was not created');
      } finally { p.rm(); }
    },
  },
  {
    name: 'a folder it cannot write is reported and the run goes on',
    skip: process.platform === 'win32' ? 'a read-only folder mode does not stop a write on Windows'
      : (process.getuid && process.getuid() === 0) ? 'root writes through a read-only mode' : false,
    check(twin, run) {
      const p = project({ [`${D}/code-style/CODE-STYLE.md`]: CODE, [`${D}/related-projects/RELATED-PROJECTS.md`]: RELATED });
      const locked = path.join(p.root, D, 'code-style');
      try {
        fs.chmodSync(locked, 0o555);
        const r = run(p.root);
        ran(r, twin);
        assert.match(r.stdout, /!! docs domain \(code style\): could not write/);
        assert.ok(!p.exists(`${D}/code-style/watch.json`));
        assert.strictEqual(p.read(`${D}/related-projects/watch.json`), MINIMAL, 'the next folder is still switched on');
      } finally { fs.chmodSync(locked, 0o755); p.rm(); }
    },
  },
];

for (const twin of TWINS) {
  for (const c of CASES) {
    test(`${twin.name}: ${c.name}`, { skip: twin.skip || c.skip }, () => c.check(twin.name, twin.run));
  }
}
