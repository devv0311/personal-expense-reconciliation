/**
 * How this process answers SIGINT/SIGTERM: drain, then close the ledger, then exit — in that
 * order, each step waited for.
 *
 * It lives in its own module, apart from `src/server.ts`, for one reason: `server.ts` is the
 * composition root and starts a real listener and a real database the moment it is imported.
 * The ordering below is the part that has to be provable, so it is kept somewhere a test can
 * import without opening anything (`tests/integration/server-shutdown.test.ts`).
 *
 * What was wrong before: `server.close(); await database.close(); process.exit(0)`. `close()`
 * is asynchronous and was not awaited, so the database was released — and the process then
 * exited — while a request was still being served. On this installation the database is a
 * PGlite directory on disk, and a signal arriving mid-write is the exact shape of the
 * September 2026 incident that left a ledger unopenable. A half-served response is the lesser
 * of the two problems.
 *
 * Draining is not just `await close()`, either. `close()` stops the listener and then waits for
 * every connection to go away, and a keep-alive connection from `web/` never does on its own —
 * the callback would simply never fire and Ctrl-C would hang. So idle connections are released
 * as they become idle (a sweep, because a connection that is busy now becomes idle the moment
 * its response finishes), and a connection that is *still* busy after the grace period is cut.
 * Cutting it is reported loudly rather than silently: a person who sees it can decide whether
 * the request that would not finish mattered.
 */

/**
 * The part of `node:http`'s `Server` a shutdown needs. `http.Server` satisfies it as-is — the
 * narrower type exists so a test can drive a real listener without this module importing one.
 */
export interface ClosableHttpServer {
  close(callback?: (error?: Error) => void): unknown;
  /** Releases connections with no request in flight. Present since Node 18.2. */
  closeIdleConnections(): void;
  /** Cuts every connection, in flight or not. The last resort, never the first move. */
  closeAllConnections(): void;
}

export interface GracefulShutdownOptions {
  readonly server: ClosableHttpServer;
  readonly closeDatabase: () => Promise<void>;
  readonly exit: (code: number) => void;
  /** How long a request still in flight may hold the shutdown open. Default 10s. */
  readonly graceMs?: number;
  /** How often connections that have just gone idle are released. Default 50ms. */
  readonly sweepMs?: number;
  readonly log?: (message: string) => void;
}

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_SWEEP_MS = 50;

/**
 * Returns the one function both signal handlers call.
 *
 * It is idempotent by construction: every call after the first returns the same promise, so an
 * impatient second Ctrl-C cannot start a second teardown, close the database twice, or exit
 * out from under the first. Deliberately it does **not** treat a second signal as "force quit
 * now" — that would mean killing PGlite mid-write on purpose, which is the failure this whole
 * file exists to avoid. The grace period already bounds how long patience lasts.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  const { server, closeDatabase, exit } = options;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
  const log =
    options.log ??
    ((message: string) => {
      console.warn(message);
    });

  let running: Promise<void> | undefined;
  return () => (running ??= run());

  async function run(): Promise<void> {
    let exitCode = 0;

    // Both steps are attempted whatever the other does. A listener that refuses to close is no
    // reason to leave the database open, and a database that refuses to close is no reason to
    // stay resident — but either one makes the exit code say so.
    try {
      await closeHttpServer();
    } catch (error) {
      log(`The HTTP server did not close cleanly: ${describeError(error)}`);
      exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (error) {
      log(`The database did not close cleanly: ${describeError(error)}`);
      exitCode = 1;
    }

    exit(exitCode);
  }

  function closeHttpServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearInterval(sweep);
        clearTimeout(deadline);
        if (error === undefined) resolve();
        else reject(error);
      };

      // A connection busy now goes idle as soon as its response finishes; `close()` will not
      // notice, so the sweep is what actually lets a drained keep-alive connection go.
      const sweep = setInterval(() => server.closeIdleConnections(), sweepMs);
      const deadline = setTimeout(() => {
        log(
          `A request was still in flight ${String(graceMs)}ms after shutdown began; its ` +
            'connection is being cut so the database can be closed. Whatever that request was ' +
            'doing did not finish.',
        );
        server.closeAllConnections();
        // Resolved here rather than waiting for the close callback: every socket has just been
        // destroyed and the listener was closed below, so there is nothing left to wait for,
        // and waiting is the one thing a deadline must not do.
        finish();
      }, graceMs);
      // Neither timer may be the reason this process stays alive.
      sweep.unref();
      deadline.unref();

      server.close((error) => finish(error));
      // Connections already idle at this instant — the common case for `web/` — go immediately
      // rather than waiting out the first sweep interval.
      server.closeIdleConnections();
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
