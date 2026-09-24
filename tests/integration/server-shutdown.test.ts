/**
 * That stopping the API lets the work already in the socket finish before the ledger is closed.
 *
 * `src/server.ts` used to answer a signal with `server.close(); await database.close();
 * process.exit(0)`. `close()` is asynchronous and was not awaited, so the database — a PGlite
 * directory on this machine, mid-write — was released while a request was still being served,
 * and `process.exit` then ran under a half-served response. Ctrl-C at the wrong moment is
 * exactly the shape of the September 2026 incident: a signal arriving while PGlite was writing.
 *
 * Everything here is synthetic. The server is a throwaway `node:http` listener on an ephemeral
 * port (never 3000/4000, never 3001/4001/4002), the database is a recorder that counts its own
 * calls, and `exit` is a function that appends to an array. No ledger, real or synthetic, is
 * opened by this file.
 *
 * The properties, in the order they matter:
 *   1. the database closes only after the in-flight response has finished, and that response
 *      arrives whole rather than truncated;
 *   2. the process exits only after the database has closed;
 *   3. a second signal — an impatient second Ctrl-C — closes nothing twice;
 *   4. a database that will not close still ends the process, and says so with its exit code;
 *   5. a request that never finishes cannot hold the shutdown open forever.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createGracefulShutdown } from '../../src/server-shutdown.js';

/** Servers this file started, so a failing assertion never leaves a listener behind. */
const started: Server[] = [];

afterEach(async () => {
  for (const server of started.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  started.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/** Lets every already-queued microtask and timer callback run, without advancing real time much. */
async function settleEventLoop(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('graceful shutdown', () => {
  it('closes the database only after an in-flight request has finished, and that response arrives whole', async () => {
    const order: string[] = [];
    const entered = deferred<void>();
    const release = deferred<void>();

    const { server, port } = await listen((_req, res) => {
      res.on('finish', () => order.push('response-finished'));
      entered.resolve();
      void release.promise.then(() => res.end('ok'));
    });

    const response = fetch(`http://127.0.0.1:${String(port)}/`);
    await entered.promise;

    const shutdown = createGracefulShutdown({
      server,
      closeDatabase: () => {
        order.push('database-closed');
        return Promise.resolve();
      },
      exit: (code) => order.push(`exit:${String(code)}`),
      sweepMs: 10,
    });

    const finished = shutdown();
    await settleEventLoop();
    // The request is still being served. Nothing may have been released yet.
    expect(order).toEqual([]);

    release.resolve();
    const received = await response;
    expect(received.status).toBe(200);
    expect(await received.text()).toBe('ok');

    await finished;
    expect(order).toEqual(['response-finished', 'database-closed', 'exit:0']);
  });

  it('closes nothing twice when a second signal arrives', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));

    let databaseCloses = 0;
    const exits: number[] = [];
    const shutdown = createGracefulShutdown({
      server,
      closeDatabase: () => {
        databaseCloses += 1;
        return Promise.resolve();
      },
      exit: (code) => exits.push(code),
      sweepMs: 10,
    });

    // Three signals at once, then a fourth after the first has already finished.
    await Promise.all([shutdown(), shutdown(), shutdown()]);
    await shutdown();

    expect(databaseCloses).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('still ends the process when the database will not close, with a non-zero exit code', async () => {
    const { server } = await listen((_req, res) => res.end('ok'));

    const exits: number[] = [];
    const logged: string[] = [];
    const shutdown = createGracefulShutdown({
      server,
      closeDatabase: () => Promise.reject(new Error('the ledger refused to close')),
      exit: (code) => exits.push(code),
      log: (message) => logged.push(message),
      sweepMs: 10,
    });

    await expect(shutdown()).resolves.toBeUndefined();
    expect(exits).toEqual([1]);
    expect(logged.join('\n')).toContain('the ledger refused to close');
  });

  it('does not let a request that never finishes hold the shutdown open forever', async () => {
    const { server, port } = await listen(() => {
      // Never responds. The socket stays busy until something destroys it.
    });

    const order: string[] = [];
    const logged: string[] = [];
    // The client's socket is destroyed underneath it; that rejection is the point, not a failure.
    const abandoned = fetch(`http://127.0.0.1:${String(port)}/`).catch(() => undefined);
    await settleEventLoop();

    const shutdown = createGracefulShutdown({
      server,
      closeDatabase: () => {
        order.push('database-closed');
        return Promise.resolve();
      },
      exit: (code) => order.push(`exit:${String(code)}`),
      log: (message) => logged.push(message),
      graceMs: 60,
      sweepMs: 10,
    });

    await shutdown();
    await abandoned;

    expect(order).toEqual(['database-closed', 'exit:0']);
    // The cut is reported, not silent: a person needs to know a request did not finish.
    expect(logged.join('\n')).toMatch(/still in flight/i);
    expect(logged.join('\n')).toMatch(/did not finish/i);
  });
});
