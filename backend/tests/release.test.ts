import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'node_modules/release-it/bin/release-it.js');
const configuration = JSON.parse(readFileSync(join(root, '.release-it.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const header = configuration.plugins['@release-it/conventional-changelog'].header;
const oldSection = (i: number) =>
  `## 1.0.${i} (2025-01-02)\n\n### 🐛 Bug Fixes\n\n- Fixture release ${i}.\n\n`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: join(cwd, '..'), encoding: 'utf8' }).trim();

function fixture(t: TestContext) {
  const repository = mkdtempSync(join(tmpdir(), 'trivia-release-'));
  const cwd = join(repository, 'backend');
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  copyFileSync(join(root, '.release-it.json'), join(cwd, '.release-it.json'));
  for (const script of ['archive-changelog.mjs', 'check-release-tree.mjs']) {
    copyFileSync(join(root, 'scripts', script), join(cwd, 'scripts', script));
  }
  const pkg = {
    name: 'trivia-release-fixture',
    version: '1.0.10',
    private: true,
    scripts: {
      release: manifest.scripts.release,
      'release:dry-run': manifest.scripts['release:dry-run'],
    },
  };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(
    join(cwd, 'package-lock.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: pkg.name, version: pkg.version } },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(repository, 'CHANGELOG.md'),
    header + '\n\n' + Array.from({ length: 11 }, (_, i) => oldSection(10 - i)).join(''),
  );
  writeFileSync(join(repository, '.gitignore'), 'node_modules/\n');
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  git(cwd, 'init', '--initial-branch=main');
  git(cwd, 'config', 'user.name', 'Release Fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'config', 'commit.gpgSign', 'false');
  git(cwd, 'config', 'tag.gpgSign', 'false');
  git(cwd, 'config', 'core.hooksPath', join(repository, '.git/hooks'));
  git(cwd, 'add', '.');
  git(cwd, 'commit', '--message', 'chore: seed disposable release fixture');
  git(cwd, 'tag', '--annotate', '--message', 'Fixture version', 'v1.0.10');
  return cwd;
}

function commit(cwd: string, message: string) {
  git(cwd, 'commit', '--allow-empty', '--message', message);
}
function read(cwd: string, path: string) {
  const directory = path === 'CHANGELOG.md' || path.startsWith('changelog/') ? '..' : '.';
  return readFileSync(join(cwd, directory, path), 'utf8');
}
function assertVersions(cwd: string, expected: string) {
  const pkg = JSON.parse(read(cwd, 'package.json'));
  const lock = JSON.parse(read(cwd, 'package-lock.json'));
  assert.equal(pkg.version, expected);
  assert.equal(lock.version, expected);
  assert.equal(lock.packages[''].version, expected);
}
const release = (cwd: string, ...args: string[]) =>
  promisify(execFile)(process.execPath, [cli, '--ci', ...args], {
    cwd,
    timeout: 30_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, npm_config_cache: join(cwd, '../.git/npm-cache') },
  });

test('repository version and pinned release dependencies match the lockfile', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  for (const name of ['release-it', '@release-it/conventional-changelog']) {
    const version = manifest.devDependencies[name];
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[''].devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
});

test(
  'real release lifecycle generates notes, archives, stages new files, and creates an annotated tag',
  { timeout: 40_000 },
  async (t) => {
    const cwd = fixture(t);
    for (const [type, message] of [
      ['feat', 'visible-feature'],
      ['fix', 'visible-fix'],
      ['perf', 'visible-performance'],
      ['revert', 'visible-revert'],
      ['docs', 'visible-documentation'],
      ['refactor', 'visible-refactoring'],
      ['style', 'hidden-style'],
      ['chore', 'hidden-chore'],
      ['test', 'hidden-test'],
      ['build', 'hidden-build'],
      ['ci', 'hidden-ci'],
    ])
      commit(cwd, `${type}: ${message}`);
    const previous = git(cwd, 'rev-parse', 'HEAD');
    await release(cwd);
    assertVersions(cwd, '1.1.0');
    assert.equal(git(cwd, 'log', '-1', '--format=%s'), 'chore(release): v1.1.0');
    assert.equal(git(cwd, 'rev-parse', 'HEAD^'), previous);
    assert.equal(git(cwd, 'cat-file', '-t', 'v1.1.0'), 'tag');
    assert.equal(git(cwd, 'tag', '--list', '--format=%(contents)', 'v1.1.0'), 'Trivia Game v1.1.0');
    assert.equal(git(cwd, 'rev-parse', 'v1.1.0^{commit}'), git(cwd, 'rev-parse', 'HEAD'));
    assert.equal(git(cwd, 'status', '--porcelain', '--untracked-files=all'), '');
    const changelog = read(cwd, 'CHANGELOG.md');
    assert.ok(changelog.startsWith(header));
    assert.match(changelog, /## .*1\.1\.0.*\(\d{4}-\d{2}-\d{2}\)/);
    for (const category of configuration.plugins['@release-it/conventional-changelog'].preset
      .types) {
      if (category.effect === 'bump')
        assert.ok(changelog.includes(category.section), category.section);
      else assert.ok(!changelog.includes(category.section), category.section);
    }
    assert.doesNotMatch(changelog, /hidden-(?:style|chore|test|build|ci)/);
    assert.equal((changelog.match(/^## \[?\d+\.\d+\.\d+/gm) ?? []).length, 10);
    const changed = git(cwd, 'show', '--format=', '--name-only', 'HEAD').split('\n');
    for (const path of [
      'CHANGELOG.md',
      'backend/package.json',
      'backend/package-lock.json',
      'changelog/archive/v1.0.0.md',
      'changelog/archive/v1.0.1.md',
    ]) {
      assert.ok(changed.includes(path), path);
      assert.equal(
        git(cwd, 'show', `HEAD:${path}`),
        read(cwd, path.replace(/^backend\//, '')).trim(),
      );
    }
    assert.equal(read(cwd, 'changelog/archive/v1.0.1.md'), oldSection(1));
    assert.equal(read(cwd, 'changelog/archive/v1.0.0.md'), oldSection(0).trimEnd() + '\n');
  },
);

for (const message of [
  'feat!: change fixture protocol',
  'chore: change fixture tooling\n\nBREAKING CHANGE: old fixture tooling is unsupported',
]) {
  test(
    `breaking semantics preserved: ${message.split('\n')[0]}`,
    { timeout: 40_000 },
    async (t) => {
      const cwd = fixture(t);
      commit(cwd, message);
      await release(cwd);
      assertVersions(cwd, '2.0.0');
      assert.equal(git(cwd, 'cat-file', '-t', 'v2.0.0'), 'tag');
      assert.match(read(cwd, 'CHANGELOG.md'), /BREAKING CHANGES/);
    },
  );
}

test('npm release dry-run is read-only on a clean repository', { timeout: 40_000 }, async (t) => {
  const cwd = fixture(t);
  commit(cwd, 'fix: preview fixture release');
  const previous = git(cwd, 'rev-parse', 'HEAD');
  const before = read(cwd, 'CHANGELOG.md');
  const output = await promisify(execFile)('npm', ['run', 'release:dry-run'], {
    cwd,
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
  assert.match(output.stdout, /1\.0\.11/);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), previous);
  assert.equal(git(cwd, 'tag', '--list'), 'v1.0.10');
  assertVersions(cwd, '1.0.10');
  assert.equal(read(cwd, 'CHANGELOG.md'), before);
  assert.equal(git(cwd, 'status', '--porcelain', '--untracked-files=all'), '');
});

for (const dirty of ['tracked', 'untracked', 'branch']) {
  test(
    `release rejects ${dirty} prerequisite failure before version changes`,
    { timeout: 40_000 },
    async (t) => {
      const cwd = fixture(t);
      commit(cwd, 'fix: prerequisite fixture');
      if (dirty === 'tracked')
        writeFileSync(join(cwd, '../CHANGELOG.md'), read(cwd, 'CHANGELOG.md') + '\nDirty edit.\n');
      if (dirty === 'untracked')
        writeFileSync(join(cwd, 'untracked.txt'), 'Do not include unrelated files.\n');
      if (dirty === 'branch') git(cwd, 'switch', '--create', 'feature/test');
      const previous = git(cwd, 'rev-parse', 'HEAD');
      await assert.rejects(
        release(cwd),
        dirty === 'branch' ? /Must be on branch main/ : /clean working tree/,
      );
      if (dirty === 'untracked') {
        await assert.rejects(
          promisify(execFile)('npm', ['run', 'release:dry-run'], { cwd, timeout: 30_000 }),
          /clean working tree/,
        );
      }
      assertVersions(cwd, '1.0.10');
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), previous);
      assert.equal(git(cwd, 'tag', '--list'), 'v1.0.10');
    },
  );
}

test(
  'archive conflict aborts before commit/tag and retains every old release',
  { timeout: 40_000 },
  async (t) => {
    const cwd = fixture(t);
    mkdirSync(join(cwd, '../changelog/archive'), { recursive: true });
    writeFileSync(join(cwd, '../changelog/archive/v1.0.0.md'), 'Conflicting immutable archive.\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--message', 'fix: exercise archive conflict');
    const previous = git(cwd, 'rev-parse', 'HEAD');
    await assert.rejects(release(cwd), /Conflicting archive/);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), previous);
    assert.equal(git(cwd, 'tag', '--list'), 'v1.0.10');
    assert.equal(read(cwd, 'changelog/archive/v1.0.0.md'), 'Conflicting immutable archive.\n');
    for (let i = 0; i <= 10; i++)
      assert.ok(read(cwd, 'CHANGELOG.md').includes(`Fixture release ${i}.`));
    assertVersions(cwd, '1.0.11');
  },
);
