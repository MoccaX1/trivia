import { execFileSync } from 'node:child_process';

// release-it checks tracked changes only. Include untracked files before it
// enables --all staging, and run this preflight explicitly for dry-runs too.
const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  encoding: 'utf8',
});
if (status.trim()) {
  console.error('Release requires a clean working tree, including untracked files.');
  process.exitCode = 1;
}
