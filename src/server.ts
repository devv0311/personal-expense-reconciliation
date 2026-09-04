/**
 * Runs `createApi` as a real process (`docs/roadmap.md` phase 15, ADR-0042).
 *
 * `src/api`'s handlers already speak `Request`/`Response` — this file's only job is a socket for
 * them to listen on. No HTTP framework: Node's own `node:http` plus the platform's `Request`/
 * `Response`/`Headers` (global since Node 18) convert an `IncomingMessage` into a `Request`,
 * hand it to `createApi(deps).handle`, and stream the result back. `router.ts`'s `API_ROUTES`
 * remains the only table of what exists; nothing here adds a second routing concept.
 *
 * `ai`/`splitwise` are unconfigured stubs, defined here rather than under `src/ai` or
 * `src/integrations/splitwise` — neither of those modules ships an adapter (ADR-0025, ADR-0040),
 * and this file staying honest about that (never a real Splitwise/AI call) matters more than
 * making local development slightly more convenient. `web/`'s reconciliation, balances and
 * ledger screens never exercise either path.
 *
 * Run with `npx tsx src/server.ts` (or the compiled `dist/server.js`). Env vars:
 * `PORT` (default 4000), `DATABASE_URL` (a real Postgres connection string — unset falls back
 * to PGlite persisted at `PGLITE_DATA_DIR`, default `./local-data/pglite-dev`, rather than the
 * test suite's pure in-memory instance, so data survives a restart and `scripts/seed-dev-data.ts`
 * can populate the same database this process serves), `EVIDENCE_STORAGE_PATH` (default
 * `./local-data/evidence`).
 */

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { createApi } from './api/index.js';
import type { ApiDependencies } from './api/index.js';
import { createAiService } from './ai/index.js';
import type { ModelTransport } from './ai/index.js';
import { createPgliteDatabase, createPostgresDatabase } from './db/index.js';
import type { DatabaseHandle } from './db/index.js';
import { createFilesystemEvidenceStore } from './integrations/evidence-store/index.js';
import type {
  CreateSplitwiseExpenseResult,
  RecordSplitwisePaymentResult,
  SplitwiseFriendBalance,
  SplitwisePort,
} from './integrations/splitwise/index.js';

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
const EVIDENCE_STORAGE_PATH = process.env.EVIDENCE_STORAGE_PATH ?? './local-data/evidence';
/** `web/`'s dev origin — this API and its UI are two separate processes (ADR-0042). */
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

/**
 * A real Postgres server given `DATABASE_URL`; otherwise PGlite persisted on disk at
 * `PGLITE_DATA_DIR` — deliberately **not** `db.openDatabase`'s in-memory fallback, which exists
 * for test isolation (a fresh, empty engine per suite) and would make every server restart
 * (and `scripts/seed-dev-data.ts`, a separate process) see an empty database.
 */
async function openDevDatabase(): Promise<DatabaseHandle> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString !== undefined && connectionString !== '') {
    return createPostgresDatabase(connectionString);
  }
  const dataDir = process.env.PGLITE_DATA_DIR ?? './local-data/pglite-dev';
  return createPgliteDatabase(dataDir);
}

/** No AI provider is wired anywhere in this repository (ADR-0025) — this call never succeeds. */
const UNCONFIGURED_MODEL_TRANSPORT: ModelTransport = {
  modelInfo: { provider: 'none', model: 'unconfigured' },
  complete(): Promise<unknown> {
    return Promise.reject(
      new Error(
        'No AI provider is configured (ADR-0025). src/server.ts ships no adapter — wiring one ' +
          'is a later, deliberate decision, per CLAUDE.md.',
      ),
    );
  },
};

/** No Splitwise adapter is wired anywhere in this repository (ADR-0040) — every call rejects. */
function createUnconfiguredSplitwisePort(): SplitwisePort {
  const notConfigured = (operation: string): Promise<never> =>
    Promise.reject(
      new Error(
        `Splitwise.${operation} is not configured in this environment (ADR-0040). No real ` +
          'adapter is wired anywhere in this repository — CLAUDE.md forbids connecting one ' +
          'during development.',
      ),
    );

  return {
    createExpense: (): Promise<CreateSplitwiseExpenseResult> => notConfigured('createExpense'),
    recordPayment: (): Promise<RecordSplitwisePaymentResult> => notConfigured('recordPayment'),
    // Read-only and non-fatal to its caller (services.runReconciliation catches a failure here
    // and surfaces it as a discrepancy rather than failing the whole run, ADR-0041) — resolving
    // empty would misreport "connected, nothing owed" instead of "not actually configured", so
    // this still rejects like the other two.
    fetchBalances: (): Promise<readonly SplitwiseFriendBalance[]> => notConfigured('fetchBalances'),
  };
}

async function main(): Promise<void> {
  const database = await openDevDatabase();
  await database.migrate();

  const deps: ApiDependencies = {
    db: database.db,
    ai: createAiService(UNCONFIGURED_MODEL_TRANSPORT),
    evidenceStore: createFilesystemEvidenceStore({ root: EVIDENCE_STORAGE_PATH }),
    splitwise: createUnconfiguredSplitwisePort(),
  };
  const api = createApi(deps);

  const server = createServer((req, res) => {
    void (async () => {
      // `web/` runs on a different origin (ADR-0042), so every response — including the
      // preflight `OPTIONS` a browser sends before a non-simple request — needs these headers.
      // This lives here, not in `createApi`, because CORS is a browser/transport concern:
      // `src/api` has no idea what origin is calling it, by design.
      res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const request = toWebRequest(req);
      const response = await api.handle(request);
      res.writeHead(response.status, headersToNodeObject(response.headers));
      if (response.body === null) {
        res.end();
        return;
      }
      Readable.fromWeb(response.body).pipe(res);
    })().catch((error: unknown) => {
      // A handler error this far out means api.handle() itself threw, which it is documented
      // not to do (createApi catches every route's error) — treated as an integrity signal
      // worth logging loudly, not something to hide behind a generic response.
      console.error('Unhandled error serving a request:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  server.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });
}

/* ------------------------------------------------------------------------- internals */

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
  });
}

function headersToNodeObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

main().catch((error: unknown) => {
  console.error('Failed to start the API server:', error);
  process.exitCode = 1;
});
