import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../scripts/archive-changelog.mjs', import.meta.url));
const introduction = '# Trivia Game Changelog\n\nAn introduction kept verbatim.\n\n';
const unreleased = '## [Unreleased]\n\nUnreleased text, not a published release.\n\n';
const section = (version: string) =>
  `## [${version}](https://example.test/releases/v${version}) (2026-01-02)\n\n### ✨ Features\n\n- Complete content for ${version}.\n\n`;
const sections = (count: number) =>
  Array.from({ length: count }, (_, i) => section(`1.0.${count - i}`));

function fixture(t: TestContext, content: string | Buffer) {
  const cwd = mkdtempSync(join(tmpdir(), 'trivia-archive-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'CHANGELOG.md'), content);
  return cwd;
}
const run = (cwd: string) =>
  promisify(execFile)(process.execPath, [script], { cwd, timeout: 5_000 });
const read = (cwd: string, path = 'CHANGELOG.md') => readFileSync(join(cwd, path), 'utf8');

for (const count of [0, 9, 10]) {
  test(`${count} releases: no archival and no file rewrite`, async (t) => {
    const source = introduction + unreleased + sections(count).join('');
    const cwd = fixture(t, source);
    const modified = statSync(join(cwd, 'CHANGELOG.md')).mtimeMs;
    await run(cwd);
    assert.equal(read(cwd), source);
    assert.equal(statSync(join(cwd, 'CHANGELOG.md')).mtimeMs, modified);
    assert.equal(existsSync(join(cwd, 'changelog')), false);
  });
}

test('older complete sections move verbatim; introduction, Unreleased, dates and order remain', async (t) => {
  const entries = sections(13);
  // Also preserve Unreleased when it appears between release sections.
  const cwd = fixture(t, introduction + entries.slice(0, 12).join('') + unreleased + entries[12]);
  await run(cwd);
  assert.equal(read(cwd), introduction + entries.slice(0, 10).join('') + unreleased);
  assert.deepEqual(readdirSync(join(cwd, 'changelog/archive')), [
    'v1.0.1.md',
    'v1.0.2.md',
    'v1.0.3.md',
  ]);
  for (const version of ['1.0.1', '1.0.2', '1.0.3']) {
    assert.equal(read(cwd, `changelog/archive/v${version}.md`), section(version));
  }
  const retained = read(cwd);
  const modified = statSync(join(cwd, 'CHANGELOG.md')).mtimeMs;
  await run(cwd);
  assert.equal(read(cwd), retained);
  assert.equal(statSync(join(cwd, 'CHANGELOG.md')).mtimeMs, modified);
  assert.deepEqual(readdirSync(join(cwd, 'changelog/archive')), [
    'v1.0.1.md',
    'v1.0.2.md',
    'v1.0.3.md',
  ]);
});

test('CRLF, plain headings, prereleases and fenced content are preserved exactly', async (t) => {
  const oldest =
    '### v0.9.0-rc.1+build.7 (2025-12-01)\n\n```md\n## 99.0.0 (2099-01-01)\n```\n\n~~~md\n## 88.0.0\n~~~\n';
  const entries = sections(10);
  const source = (introduction + unreleased + entries.join('') + oldest).replaceAll('\n', '\r\n');
  const cwd = fixture(t, source);
  await run(cwd);
  assert.equal(read(cwd), (introduction + unreleased + entries.join('')).replaceAll('\n', '\r\n'));
  assert.equal(
    read(cwd, 'changelog/archive/v0.9.0-rc.1+build.7.md'),
    oldest.replaceAll('\n', '\r\n'),
  );
  assert.deepEqual(readdirSync(join(cwd, 'changelog/archive')), ['v0.9.0-rc.1+build.7.md']);
});

test('identical archive content is safe and is not overwritten', async (t) => {
  const cwd = fixture(t, introduction + sections(11).join(''));
  mkdirSync(join(cwd, 'changelog/archive'), { recursive: true });
  const file = join(cwd, 'changelog/archive/v1.0.1.md');
  writeFileSync(file, section('1.0.1'));
  const modified = statSync(file).mtimeMs;
  await run(cwd);
  assert.equal(read(cwd, 'changelog/archive/v1.0.1.md'), section('1.0.1'));
  assert.equal(statSync(file).mtimeMs, modified);
  assert.equal(read(cwd), introduction + sections(11).slice(0, 10).join(''));
});

test('undated version-like headings in notes do not split a complete release', async (t) => {
  const older =
    section('0.9.0') + '### 0.8.0 migration details\n\nKeep this entire note together.\n';
  const retained = introduction + sections(10).join('');
  const cwd = fixture(t, retained + older);
  await run(cwd);
  assert.equal(read(cwd), retained);
  assert.equal(read(cwd, 'changelog/archive/v0.9.0.md'), older);
  assert.deepEqual(readdirSync(join(cwd, 'changelog/archive')), ['v0.9.0.md']);
});

test('all conflicts are checked before any archive or main-file changes', async (t) => {
  const source = introduction + unreleased + sections(13).join('');
  const cwd = fixture(t, source);
  mkdirSync(join(cwd, 'changelog/archive'), { recursive: true });
  writeFileSync(
    join(cwd, 'changelog/archive/v1.0.1.md'),
    'Existing conflicting release content.\n',
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(run(cwd), /Conflicting archive/);
    assert.equal(read(cwd), source);
    assert.deepEqual(readdirSync(join(cwd, 'changelog/archive')), ['v1.0.1.md']);
    assert.equal(
      read(cwd, 'changelog/archive/v1.0.1.md'),
      'Existing conflicting release content.\n',
    );
  }
});

for (const [name, content] of [
  ['duplicate versions', introduction + sections(11).join('') + section('1.0.1')],
  ['unfinished fenced content', introduction + sections(11).join('') + '```md\nunfinished\n'],
  ['invalid version headings', introduction + sections(11).join('') + '## 1.0.01 (2026-01-01)\n'],
] as const) {
  test(`unsafe ${name} fail without losing content`, async (t) => {
    const cwd = fixture(t, content);
    await assert.rejects(run(cwd));
    assert.equal(read(cwd), content);
    assert.equal(existsSync(join(cwd, 'changelog')), false);
  });
}

test('a missing changelog is a no-op', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'trivia-archive-empty-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  await run(cwd);
  assert.deepEqual(readdirSync(cwd), []);
});
