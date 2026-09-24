/**
 * Which stack is on which port, and the exact command that would stop each one.
 *
 * **It stops nothing.** It reads listening sockets and prints. That is the point: the September
 * 2026 incident happened because a teardown reached for a pattern (`pkill -f "tsx src/server.ts"`)
 * that matched both stacks, because both stacks genuinely run that command. Nothing about the
 * command line distinguishes them. The *port* does, and so does the process group — so this
 * prints those, and leaves the kill to a person who has read which pid they are about to signal.
 *
 * Run it with `npx tsx scripts/stack-status.ts` before stopping anything.
 *
 * The classification is the part worth being careful about, and it is pure and tested in
 * `stack-status.test.ts`: a synthetic stack misreported as real is a nuisance, and a real stack
 * misreported as synthetic is the incident happening again.
 */

import { execFileSync } from 'node:child_process';

import { REAL_PORTS } from '../src/db/real-ledger-guard.js';

/** Ports the QA procedure uses (`docs/testing/process-isolation.md`). */
const SYNTHETIC_PORTS: readonly number[] = [3001, 4001, 4002];

export interface ListeningProcess {
  readonly port: number;
  readonly pid: number;
  /** The process group. The real launcher puts its whole stack in one, so it is a safe target. */
  readonly pgid: number;
}

export interface StackReport {
  readonly port: number;
  readonly kind: 'real' | 'synthetic';
  readonly listener: ListeningProcess | null;
  /** The one command that stops exactly this, and nothing else. */
  readonly stopWith: string;
}

/**
 * Classifies what is listening, and says how to stop it — by pid or by the launcher's own script,
 * never by a pattern.
 *
 * A real port gets `local-data/stop-real.sh`, because the launcher wrote the pid files that script
 * reads and knows the whole tree it started. A synthetic port gets `kill <pid>` against the pid
 * that actually holds the socket — **not** the pid the launcher recorded, which for the real stack
 * is two levels above the process holding the database (`npm exec` → `node` → the port holder).
 * That gap is why the pid files alone were never sufficient and why the old stop script fell back
 * to a pattern in the first place.
 */
export function describeStacks(listeners: readonly ListeningProcess[]): readonly StackReport[] {
  const ports = [...REAL_PORTS, ...SYNTHETIC_PORTS].sort((a, b) => a - b);
  return ports.map((port) => {
    const listener = listeners.find((candidate) => candidate.port === port) ?? null;
    const kind = REAL_PORTS.includes(port) ? 'real' : 'synthetic';
    return { port, kind, listener, stopWith: stopCommand(kind, listener) };
  });
}

function stopCommand(kind: 'real' | 'synthetic', listener: ListeningProcess | null): string {
  if (listener === null) return 'nothing is listening';
  if (kind === 'real') {
    return `bash local-data/stop-real.sh   # never a pattern; it stops the group it started`;
  }
  return `kill ${String(listener.pid)}   # or the whole QA group: kill -TERM -${String(listener.pgid)}`;
}

/** Formats the report for a terminal. Pure, so the wording is testable too. */
export function renderReport(reports: readonly StackReport[]): string {
  const lines = [
    'Listening stacks — this command stops nothing.',
    '',
    '  PORT  KIND       PID     PGID    STOP WITH',
  ];
  for (const report of reports) {
    const pid = report.listener === null ? '—' : String(report.listener.pid);
    const pgid = report.listener === null ? '—' : String(report.listener.pgid);
    lines.push(
      `  ${String(report.port).padEnd(5)} ${report.kind.padEnd(10)} ${pid.padEnd(7)} ${pgid.padEnd(7)} ${report.stopWith}`,
    );
  }
  lines.push('');
  lines.push('Never use pkill/killall/pattern matching here: both stacks run the same command');
  lines.push('line, so any pattern that matches one matches the other. See');
  lines.push('docs/testing/process-isolation.md.');
  return lines.join('\n');
}

/** Reads the listening sockets. The only impure part, and it only reads. */
function readListeners(ports: readonly number[]): readonly ListeningProcess[] {
  const found: ListeningProcess[] = [];
  for (const port of ports) {
    let pid: number;
    try {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
      }).trim();
      if (out === '') continue;
      // `-t` prints one pid per line; the first is the listener we care about.
      pid = Number.parseInt(out.split('\n')[0] ?? '', 10);
      if (!Number.isInteger(pid)) continue;
    } catch {
      // `lsof` exits non-zero when nothing matches, which is not an error here.
      continue;
    }
    let pgid = pid;
    try {
      const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
      const parsed = Number.parseInt(out.trim(), 10);
      if (Number.isInteger(parsed)) pgid = parsed;
    } catch {
      // Keep the pid as a conservative stand-in; the printed `kill <pid>` is still correct.
    }
    found.push({ port, pid, pgid });
  }
  return found;
}

function main(): void {
  const ports = [...REAL_PORTS, ...SYNTHETIC_PORTS];
  console.log(renderReport(describeStacks(readListeners(ports))));
}

// Only when run as a command. Without this, importing `describeStacks` in a test would shell out
// to `lsof` as a side effect of the import — a test that inspects the machine it runs on.
if (process.argv[1] !== undefined && import.meta.url.endsWith('stack-status.ts')) {
  const invoked = process.argv[1].endsWith('stack-status.ts');
  if (invoked) main();
}
