import { Buffer } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const changelog = 'CHANGELOG.md';
const archiveDirectory = join('changelog', 'archive');
// Canonical SemVer, including prerelease/build suffixes; never a filesystem path.
const numeric = '(?:0|[1-9]\\d*)';
const prerelease = `(?:${numeric}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function archive() {
  if (!existsSync(changelog)) return;
  if (!lstatSync(changelog).isFile()) throw new Error('CHANGELOG.md must be a regular file');
  const bytes = readFileSync(changelog);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('CHANGELOG.md must contain valid UTF-8');

  const headings = [];
  let offset = 0;
  let fence;
  for (const line of text.split(/(?<=\n)/)) {
    const raw = line.replace(/\r?\n$/, '');
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else {
      // Supports linked conventional-changelog headings and plain SemVer.
      const heading = raw.match(
        /^ {0,3}#{1,3}[ \t]+(?:\[([^\]]+)\](?:\([^\n]*\))?|([^\s]+))(?:[ \t].*)?$/,
      );
      const label = heading?.[1] ?? heading?.[2];
      if (label?.toLowerCase() === 'unreleased') {
        headings.push({ offset });
      } else if (
        label &&
        /^[vV]?\d+\./.test(label) &&
        /(?:\(\d{4}-\d{2}-\d{2}\)|-\s+\d{4}-\d{2}-\d{2})\s*#*\s*$/.test(raw)
      ) {
        const version = label.replace(/^v/i, '');
        if (!versionPattern.test(version)) throw new Error(`Invalid release heading: ${label}`);
        headings.push({ offset, version });
      }
    }
    offset += line.length;
  }
  const releases = headings.filter((heading) => heading.version);
  if (releases.length <= 10) return;
  if (fence) throw new Error('Cannot archive an incomplete fenced section');
  if (new Set(releases.map((heading) => heading.version)).size !== releases.length) {
    throw new Error('Duplicate release versions in CHANGELOG.md');
  }

  const older = new Set(releases.slice(10));
  const plan = [];
  let retained = text.slice(0, headings[0].offset);
  for (const [index, heading] of headings.entries()) {
    const content = text.slice(heading.offset, headings[index + 1]?.offset ?? text.length);
    if (older.has(heading))
      plan.push({ file: join(archiveDirectory, `v${heading.version}.md`), content });
    else retained += content;
  }

  // Preflight every conflict before writing anything. Existing identical files
  // also make retries safe if an earlier run stopped after writing some archives.
  for (const directory of ['changelog', archiveDirectory]) {
    if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
      throw new Error(`Archive directory must be a real directory: ${directory}`);
    }
  }
  function verifyExisting(file, content) {
    if (!lstatSync(file).isFile() || !readFileSync(file).equals(Buffer.from(content))) {
      throw new Error(`Conflicting archive; nothing removed from CHANGELOG.md: ${file}`);
    }
  }
  for (const { file, content } of plan) if (existsSync(file)) verifyExisting(file, content);

  mkdirSync(archiveDirectory, { recursive: true });
  for (const { file, content } of plan) {
    try {
      writeFileSync(file, content, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      verifyExisting(file, content);
    }
  }

  // Replace the main file only after every archive is safely present.
  const temporary = `${changelog}.tmp-${process.pid}`;
  writeFileSync(temporary, retained, { flag: 'wx', mode: lstatSync(changelog).mode });
  try {
    if (!readFileSync(changelog).equals(bytes))
      throw new Error('CHANGELOG.md changed during archival');
    renameSync(temporary, changelog);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

try {
  archive();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
