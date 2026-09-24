/**
 * The classification a person reads before they signal a process.
 *
 * Worth testing rather than eyeballing, because the two mistakes are not symmetric: a synthetic
 * stack reported as real wastes a minute, and a real stack reported as synthetic reproduces the
 * September 2026 incident. Every pid below is invented.
 */

import { describe, expect, it } from 'vitest';

import { REAL_PORTS } from '../src/db/real-ledger-guard.js';
import { describeStacks, renderReport, type ListeningProcess } from './stack-status.js';

const listener = (port: number, pid: number, pgid: number): ListeningProcess => ({
  port,
  pid,
  pgid,
});

describe('telling the two stacks apart', () => {
  it('classifies by port, which is the only thing that actually differs', () => {
    // Both stacks run `tsx src/server.ts`; nothing in the command line separates them. The port
    // does, and so the report keys off it and nothing else.
    const reports = describeStacks([listener(4000, 111, 100), listener(4001, 222, 200)]);

    expect(reports.find((r) => r.port === 4000)?.kind).toBe('real');
    expect(reports.find((r) => r.port === 4001)?.kind).toBe('synthetic');
  });

  it('sends a real port to the launcher’s own stop script, never to a kill', () => {
    const real = describeStacks([listener(4000, 111, 100)]).find((r) => r.port === 4000);

    expect(real?.stopWith).toContain('local-data/stop-real.sh');
    expect(real?.stopWith).not.toMatch(/\bkill\b/);
  });

  it('gives a synthetic port an exact pid, and its group as the wider option', () => {
    const synthetic = describeStacks([listener(4001, 222, 200)]).find((r) => r.port === 4001);

    expect(synthetic?.stopWith).toContain('kill 222');
    expect(synthetic?.stopWith).toContain('kill -TERM -200');
  });

  it('reports a port nobody is on, rather than leaving it out', () => {
    const reports = describeStacks([]);

    expect(reports.length).toBeGreaterThanOrEqual(REAL_PORTS.length);
    for (const report of reports) {
      expect(report.listener).toBeNull();
      expect(report.stopWith).toBe('nothing is listening');
    }
  });

  it('covers every real port, so one cannot be silently dropped from the report', () => {
    const covered = describeStacks([]).map((report) => report.port);
    for (const port of REAL_PORTS) expect(covered).toContain(port);
  });
});

describe('what the report tells a reader to do', () => {
  it('says plainly that it stops nothing', () => {
    expect(renderReport(describeStacks([]))).toContain('this command stops nothing');
  });

  it('states the rule the incident came from', () => {
    const text = renderReport(describeStacks([listener(4000, 111, 100)]));

    expect(text).toContain('Never use pkill/killall/pattern matching');
    expect(text).toContain('docs/testing/process-isolation.md');
  });

  it('never emits a pattern-matching command of its own', () => {
    // The report is copy-pasted. If it ever printed a `pkill`, it would be handing somebody the
    // exact command this whole pass exists to retire.
    const text = renderReport(
      describeStacks([listener(3000, 1, 1), listener(4000, 2, 1), listener(4001, 3, 3)]),
    );
    const commandLines = text
      .split('\n')
      .filter((line) => line.trimStart().startsWith('3') || line.trimStart().startsWith('4'));

    for (const line of commandLines) {
      expect(line).not.toContain('pkill');
      expect(line).not.toContain('killall');
      expect(line).not.toMatch(/kill\s+-f/);
    }
  });
});
