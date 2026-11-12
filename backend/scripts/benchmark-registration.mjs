import { setInterval, clearInterval } from 'node:timers';
import { hashPassword, verifyPassword } from '../dist/application/password.js';
import { readFile } from 'node:fs/promises';
import { cpus, availableParallelism, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
const read = async (p) => (await readFile(p, 'utf8').catch(() => 'unavailable')).trim();
console.log(
  JSON.stringify({
    node: process.version,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    parallelism: availableParallelism(),
    hostMemoryMiB: Math.round(totalmem() / 1048576),
    memoryMax: await read('/sys/fs/cgroup/memory.max'),
    cpuMax: await read('/sys/fs/cgroup/cpu.max'),
    threadPool: process.env.UV_THREADPOOL_SIZE ?? 'default',
  }),
);
const password = 'Benchmark only — not an account password';
const encoded = await hashPassword(password);
// Cases share a process; RSS is an observed peak, not an allocation delta.
for (const [registration, logins] of [
  [0, 4],
  [1, 0],
  [2, 0],
  [4, 0],
  [1, 4],
  [2, 4],
  [4, 4],
]) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  const times = [];
  const loginTimes = [];
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let round = 0; round < 40; round++) {
    const operations = [
      ...Array.from({ length: registration }, () => async () => {
        const t = performance.now();
        await hashPassword(password);
        times.push(performance.now() - t);
      }),
      ...Array.from({ length: logins }, () => async () => {
        const t = performance.now();
        await verifyPassword(encoded, password);
        loginTimes.push(performance.now() - t);
      }),
    ];
    // Alternate admission order so mixed measurements do not favor registration.
    if (round % 2) operations.reverse();
    await Promise.all(operations.map((operation) => operation()));
  }
  clearInterval(timer);
  delay.disable();
  const percentile = (values, fraction) => {
    values.sort((a, b) => a - b);
    return values.length
      ? +values[Math.min(values.length - 1, Math.floor(values.length * fraction))].toFixed(2)
      : null;
  };
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  console.log(
    JSON.stringify({
      registration,
      logins,
      samples: times.length,
      loginSamples: loginTimes.length,
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      loginP95Ms: percentile(loginTimes, 0.95),
      peakRssMiB: +(Math.max(peak, process.memoryUsage().rss) / 1048576).toFixed(1),
      cpuCoreEquivalent: +((used.user + used.system) / 1000 / elapsed).toFixed(2),
      eventLoopP99Ms: +(delay.percentile(99) / 1e6).toFixed(2),
    }),
  );
}
