/**
 * Runs `createApi` as a real process (`docs/roadmap.md` phase 15, ADR-0042).
 *
 * `src/api`'s handlers already speak `Request`/`Response` — this file's only job is a socket for
 * them to listen on. No HTTP framework: Node's own `node:http` plus the platform's `Request`/
 * `Response`/`Headers` (global since Node 18) convert an `IncomingMessage` into a `Request`,
 * hand it to `createApi(deps).handle`, and stream the result back. `router.ts`'s `API_ROUTES`
 * remains the only table of what exists; nothing here adds a second routing concept.
 *
 * **This file is the composition root, and the one place that decides what is configured.**
 * Two external providers can now be wired, and each is wired only when its credentials are
 * present. Absent, the corresponding stub *refuses by name* rather than degrading quietly —
 * an unconfigured Splitwise that resolved empty would report "connected, nothing owed", and an
 * unconfigured model that returned a default would put a guess in the review queue with a
 * model's name on it. Both would be worse than the failure they replace.
 *
 * Run with `npx tsx src/server.ts` (or the compiled `dist/server.js`). Env vars:
 *
 * | Variable | Effect |
 * | --- | --- |
 * | `PORT` | Listen port; default 4000. |
 * | `HOST` | Bind address; default `127.0.0.1` (loopback only). |
 * | `DATABASE_URL` | A real Postgres connection string. Unset falls back to PGlite persisted at `PGLITE_DATA_DIR` (default `./local-data/pglite-dev`), rather than the test suite's in-memory instance, so data survives a restart and `scripts/seed-dev-data.ts` populates the same database this process serves. |
 * | `EVIDENCE_STORAGE_PATH` | Where documents are written; default `./local-data/evidence`. |
 * | `ANTHROPIC_API_KEY` | Wires the real model transport. Unset: every AI operation refuses, naming the missing configuration. |
 * | `ANTHROPIC_MODEL` | Overrides the default model. |
 * | `SPLITWISE_API_KEY` + `SPLITWISE_USER_ID` | Wires the real Splitwise adapter. Either missing: every Splitwise call refuses, and an audit records an INCOMPLETE check rather than agreement. |
 * | `AUTH_REQUIRED` | `true`/`false`. Defaults to **true** unless `HOST` is loopback, so binding to a network interface is authenticated by default and turning that off is an explicit act. |
 * | `CORS_ORIGIN` | `web/`'s origin; default `http://localhost:3000`. |
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
import { createAnthropicTransport } from './integrations/anthropic/index.js';
import { createFilesystemEvidenceStore } from './integrations/evidence-store/index.js';
import { createSplitwiseAdapter } from './integrations/splitwise/index.js';
import type {
  CreateSplitwiseExpenseResult,
  RecordSplitwisePaymentResult,
  SplitwiseFriendBalance,
  SplitwisePort,
} from './integrations/splitwise/index.js';

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
/** Loopback by default: this process serves one person's financial history to one machine. */
const HOST = process.env.HOST ?? '127.0.0.1';
const EVIDENCE_STORAGE_PATH = process.env.EVIDENCE_STORAGE_PATH ?? './local-data/evidence';
/** `web/`'s dev origin — this API and its UI are two separate processes (ADR-0042). */
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Whether to enforce authentication.
 *
 * Defaults to **on** for any bind that is not loopback: the moment this listens on an
 * interface something else can reach, the absence of a session check is a person's whole
 * financial history served to whoever asks (audit row 50). Turning it off is possible — a
 * purely local run genuinely does not need it — but it has to be typed out.
 */
function resolveAuthRequired(): boolean {
  const configured = process.env.AUTH_REQUIRED;
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return !LOOPBACK_HOSTS.has(HOST);
}

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

/**
 * The transport when `ANTHROPIC_API_KEY` is unset — every call refuses, by name.
 *
 * Deliberately not a fallback that returns something: a default proposal would enter the
 * review queue carrying a model's name, and the whole point of `ai-boundary.md` is that a
 * proposal says truthfully what produced it.
 */
const UNCONFIGURED_MODEL_TRANSPORT: ModelTransport = {
  modelInfo: { provider: 'none', model: 'unconfigured' },
  complete(): Promise<unknown> {
    return Promise.reject(
      new Error(
        'No AI provider is configured. Set ANTHROPIC_API_KEY (see .env.example and ' +
          'docs/architecture/ai-boundary.md) and restart. Every payment can still be ' +
          'classified by hand from the payment workspace, and every receipt itemized by hand.',
      ),
    );
  },
};

/** The real transport when a key is present; the refusing stub when it is not. */
function resolveModelTransport(): ModelTransport {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) return UNCONFIGURED_MODEL_TRANSPORT;
  const model = process.env.ANTHROPIC_MODEL;
  return createAnthropicTransport({
    apiKey: apiKey.trim(),
    ...(model === undefined || model.trim().length === 0 ? {} : { model: model.trim() }),
  });
}

/**
 * The port when Splitwise credentials are absent — every call rejects.
 *
 * The refusal is the feature. `services.runReconciliation` catches a failed read and surfaces
 * it as a discrepancy; `services.runSplitwiseAudit` records the audit as a **failed** external
 * read rather than a clean one. Resolving empty here would turn "we could not look" into
 * "we looked and everything agreed", which is the exact misreport ADR-0046 exists to prevent.
 */
function createUnconfiguredSplitwisePort(): SplitwisePort {
  const notConfigured = (operation: string): Promise<never> =>
    Promise.reject(
      new Error(
        `Splitwise.${operation} is not configured in this environment. Set SPLITWISE_API_KEY ` +
          'and SPLITWISE_USER_ID (see .env.example) to compare against a real account. Until ' +
          'then an audit reports an incomplete check, never agreement (ADR-0046).',
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
    // `fetchLedgerEntries` (phase 19, ADR-0046) is deliberately absent rather than rejecting:
    // the port declares it optional so an adapter without the capability is representable, and
    // omitting it here is the honest description of a port that has none. The audit records
    // the read as `unsupported` and keeps its findings at aggregate scope — never as agreement.
  };
}

/**
 * The real adapter when both credentials are present; the refusing stub otherwise.
 *
 * Both, because either alone cannot work: the key authenticates, and the user id is which
 * account it authenticates *as* — the value every balance comparison is expressed relative to.
 */
function resolveSplitwisePort(): SplitwisePort {
  const apiKey = process.env.SPLITWISE_API_KEY?.trim();
  const connectedSplitwiseUserId = process.env.SPLITWISE_USER_ID?.trim();
  if (
    apiKey === undefined ||
    apiKey.length === 0 ||
    connectedSplitwiseUserId === undefined ||
    connectedSplitwiseUserId.length === 0
  ) {
    return createUnconfiguredSplitwisePort();
  }
  return createSplitwiseAdapter({ apiKey, connectedSplitwiseUserId });
}

async function main(): Promise<void> {
  const database = await openDevDatabase();
  await database.migrate();

  const transport = resolveModelTransport();
  const splitwise = resolveSplitwisePort();
  const authRequired = resolveAuthRequired();

  const deps: ApiDependencies = {
    db: database.db,
    ai: createAiService(transport),
    evidenceStore: createFilesystemEvidenceStore({ root: EVIDENCE_STORAGE_PATH }),
    splitwise,
    authRequired,
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
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      // The session lives in an `HttpOnly` cookie, and a browser sends one cross-origin only
      // when the response says credentials are allowed. Without this header a sign-in from
      // `web/` would appear to succeed and every subsequent request would arrive anonymous —
      // which, with `AUTH_REQUIRED` on, is a locked-out ledger and no way to tell why.
      // Safe alongside a single named origin; it would not be with `*`, which is why
      // `CORS_ORIGIN` has never been a wildcard.
      res.setHeader('Access-Control-Allow-Credentials', 'true');

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

  server.listen(PORT, HOST, () => {
    // Says plainly what is and is not wired. A person reading this line should be able to
    // tell, without opening a screen, whether a classification run will reach a model and
    // whether a Splitwise audit will reach Splitwise.
    console.log(`API listening on http://${HOST}:${PORT}`);
    console.log(`  authentication: ${authRequired ? 'required' : 'NOT required (local only)'}`);
    console.log(`  model provider: ${transport.modelInfo.provider}/${transport.modelInfo.model}`);
    console.log(
      `  splitwise:      ${
        process.env.SPLITWISE_API_KEY === undefined || process.env.SPLITWISE_API_KEY.trim() === ''
          ? 'not configured (audits will report an incomplete check)'
          : 'configured'
      }`,
    );
    if (!authRequired && !LOOPBACK_HOSTS.has(HOST)) {
      console.warn(
        `  WARNING: bound to ${HOST} with authentication disabled. Anything that can reach ` +
          'this port can read and write the whole ledger.',
      );
    }
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
