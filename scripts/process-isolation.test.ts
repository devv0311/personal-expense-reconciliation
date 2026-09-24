/**
 * That stopping one stack cannot reach another.
 *
 * Everything here is synthetic: the processes are `sleep`, the only thing read from disk is the
 * *text* of the launcher scripts, and no database, port or record of any kind is touched.
 *
 * The property under test is the one the September 2026 incident violated. A teardown reached for
 * `pkill -f "tsx src/server.ts"`; both the synthetic and the real stack run that exact command, so
 * the pattern matched both, PGlite took SIGTERM mid-write and its ledger never opened again. The
 * replacement signals a **process group**, and the claim that makes it safe — that a group-scoped
 * signal reaches the whole tree and nothing outside it — is a claim about this operating system,
 * so it is demonstrated here rather than assumed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/** Pids this test started, so a failure never leaves a `sleep` behind. */
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is usually the point of the test.
    }
  }
});

function alive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/**
 * Starts a throwaway "stack": a shell in its own session with two background children, mirroring
 * the shape of `start-real.sh` (a launcher plus an API and a website).
 */
function startSyntheticStack(): { pgid: number; pids: number[] } {
  // The helper process puts itself in a fresh session, starts two detached `sleep` children that
  // inherit it, reports the group, and exits. The children outlive it — a process group persists
  // while any member does — so the group id stays a valid target and this stays synchronous.
  const script = [
    'import os, subprocess, json',
    'os.setsid()',
    // DEVNULL on every stream, or the children inherit this process's stdout pipe and the
    // synchronous read below blocks until they exit rather than until the group is reported.
    'quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}',
    'kids = [subprocess.Popen(["sleep", "30"], **quiet) for _ in range(2)]',
    'print(json.dumps({"pgid": os.getpgrp(), "pids": [k.pid for k in kids]}))',
  ].join('\n');

  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  const parsed = JSON.parse(out.trim()) as { pgid: number; pids: number[] };
  started.push(...parsed.pids);
  return parsed;
}

describe('a group-scoped stop reaches one stack and no other', () => {
  it('kills every process in the group', async () => {
    const stack = startSyntheticStack();
    expect(stack.pids.every(alive)).toBe(true);

    process.kill(-stack.pgid, 'SIGTERM');

    expect(await waitUntil(() => stack.pids.every((pid) => !alive(pid)))).toBe(true);
  });

  it('leaves an identical process outside the group completely alone', async () => {
    // The whole point. Both stacks run the same command; only the group differs. If a
    // group-scoped signal leaked, the replacement for the pattern kill would be no safer than
    // the pattern was.
    const doomed = startSyntheticStack();
    const bystander = startSyntheticStack();
    expect(doomed.pgid).not.toBe(bystander.pgid);

    process.kill(-doomed.pgid, 'SIGTERM');

    expect(await waitUntil(() => doomed.pids.every((pid) => !alive(pid)))).toBe(true);
    expect(bystander.pids.every(alive)).toBe(true);
  });

  it('gives each stack its own group, so the two are distinguishable at all', () => {
    const first = startSyntheticStack();
    const second = startSyntheticStack();

    expect(first.pgid).not.toBe(second.pgid);
    expect(first.pgid).toBeGreaterThan(1);
    expect(second.pgid).toBeGreaterThan(1);
  });
});

/**
 * The launcher scripts live under `local-data/`, which `.gitignore` excludes in full, so they are
 * absent on a fresh clone and in CI. These assertions run where the files exist and skip where
 * they do not — a missing private script is not a failing test.
 */
describe('the real launcher no longer stops anything by pattern', () => {
  /** Executable lines only: the incident is quoted at length in the comments, deliberately. */
  function executableLines(path: string): string[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  }

  const stopScript = join(REPO_ROOT, 'local-data/stop-real.sh');
  const startScript = join(REPO_ROOT, 'local-data/start-real.sh');

  it.skipIf(!existsSync(stopScript))('runs no pkill or killall', () => {
    for (const line of executableLines(stopScript)) {
      // `echo`-ing the warning is allowed; invoking the tool is not.
      if (line.startsWith('echo ')) continue;
      expect(line).not.toMatch(/\bpkill\b/);
      expect(line).not.toMatch(/\bkillall\b/);
    }
  });

  it.skipIf(!existsSync(stopScript))('stops by recorded group, then pid files, then port', () => {
    const text = readFileSync(stopScript, 'utf8');
    expect(text).toContain('stack.pgid');
    expect(text).toContain('-sTCP:LISTEN');
    // Its own group is the one thing it must never signal.
    expect(text).toContain('OWN_PGID');
  });

  it.skipIf(!existsSync(startScript))('records a process group for the stop script to use', () => {
    const text = readFileSync(startScript, 'utf8');
    expect(text).toContain('stack.pgid');
    expect(text).toContain('setsid');
  });

  it.skipIf(!existsSync(startScript))('never pattern-kills in its own exit trap', () => {
    for (const line of executableLines(startScript)) {
      expect(line).not.toMatch(/pkill\s+-f/);
      expect(line).not.toMatch(/\bkillall\b/);
    }
  });
});
