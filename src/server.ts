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
 * | `AI_DOCUMENT_VISION` | `true` lets a multimodal model transcribe a **photographed** receipt whose bytes have no text layer — the one path on which a document leaves this machine (ADR-0051). Unset/false: a photographed receipt is refused by name and can still be itemized by hand. A generated PDF is always read locally, configured or not. |
 * | `SPLITWISE_API_KEY` + `SPLITWISE_USER_ID` | Wires the real Splitwise adapter. Either missing: every Splitwise call refuses, and an audit records an INCOMPLETE check rather than agreement. |
 * | `AUTH_REQUIRED` | `true`/`false`. Defaults to **true** unless `HOST` is loopback, so binding to a network interface is authenticated by default and turning that off is an explicit act. |
 * | `CORS_ORIGIN` | `web/`'s origin; default `http://localhost:3000`. |
 * | `INTAKE_FORWARDING_TOKEN` | The shared secret a mail rule or phone shortcut sends to `POST /api/intake/messages`. Unset: that endpoint refuses every request rather than standing open. |
 * | `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` | Wires the real WhatsApp Cloud API transport, so a **reviewed** proof pack can be sent (ADR-0053). Either missing: sending refuses by name and the screen says so before anything is typed. Copying a pack has never needed this and still does not. |
 * | `BALANCE_PROVIDER_URL` + `BALANCE_PROVIDER_TOKEN` | Wires a live bank/card balance read against a configured HTTPS JSON endpoint (ADR-0054). Either missing: every read is recorded as **incomplete**, never as an empty success. A reading is compared against the ledger and can never become a reconciliation boundary, configured or not. |
 */

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { createApi } from './api/index.js';
import type { ApiDependencies } from './api/index.js';
import { createAiService } from './ai/index.js';
import type { ModelTransport } from './ai/index.js';
import type { DocumentTextExtractor } from './integrations/document-text/index.js';
import { createPgliteDatabase, createPostgresDatabase } from './db/index.js';
import type { DatabaseHandle } from './db/index.js';
import { createAnthropicTransport } from './integrations/anthropic/index.js';
import {
  createDocumentTextExtractor,
  createVisionDocumentTextExtractor,
} from './integrations/document-text/index.js';
import { DEFAULT_ANTHROPIC_MODEL } from './integrations/anthropic/index.js';
import { createFilesystemEvidenceStore } from './integrations/evidence-store/index.js';
import {
  createUnconfiguredMessageTransport,
  createWhatsAppCloudTransport,
} from './integrations/message-transport/index.js';
import type { MessageTransport } from './integrations/message-transport/index.js';
import {
  createHttpBalanceProvider,
  createUnconfiguredBalanceProvider,
} from './integrations/balance-provider/index.js';
import type { BalanceProviderPort } from './integrations/balance-provider/index.js';
import { createSplitwiseAdapter } from './integrations/splitwise/index.js';
import type {
  CreateSplitwiseExpenseResult,
  DeleteSplitwiseEntryResult,
  RecordSplitwisePaymentResult,
  SplitwiseFriendBalance,
  SplitwisePort,
  UpdateSplitwiseExpenseResult,
  UpdateSplitwisePaymentResult,
} from './integrations/splitwise/index.js';

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
/** Loopback by default: this process serves one person's financial history to one machine. */
const HOST = process.env.HOST ?? '127.0.0.1';
const EVIDENCE_STORAGE_PATH = process.env.EVIDENCE_STORAGE_PATH ?? './local-data/evidence';
/** `web/`'s dev origin — this API and its UI are two separate processes (ADR-0042). */
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * The forwarding token, or `undefined`.
 *
 * Undefined closes `POST /api/intake/messages` (`src/api/intake-routes.ts`). That is the
 * direction this has to fail in: the endpoint appends evidence without a session, so an
 * installation that never configured forwarding must not have an anonymous write path.
 */
const INTAKE_FORWARDING_TOKEN =
  process.env.INTAKE_FORWARDING_TOKEN === undefined ||
  process.env.INTAKE_FORWARDING_TOKEN.trim().length === 0
    ? undefined
    : process.env.INTAKE_FORWARDING_TOKEN.trim();

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
    // The repair writes (ADR-0055) are declared and rejecting, not omitted. Omitting them
    // would say "this adapter cannot correct an entry in place" — a statement about the
    // capability — when the truth is "there are no credentials", which is exactly what
    // `createExpense` above already reports. A screen reading `capability` should not be told
    // the repair is impossible here when configuring a key is all it would take.
    updateExpense: (): Promise<UpdateSplitwiseExpenseResult> => notConfigured('updateExpense'),
    deleteEntry: (): Promise<DeleteSplitwiseEntryResult> => notConfigured('deleteEntry'),
    updatePayment: (): Promise<UpdateSplitwisePaymentResult> => notConfigured('updatePayment'),
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

/**
 * The document reader: local PDF text always, optical transcription only if opted into.
 *
 * Two conditions, both required, and the second one deliberately separate from
 * `ANTHROPIC_API_KEY`: having a model configured for *classification* is not consent to send
 * it a photograph of a receipt. `security-model.md` keeps document bytes local by default, and
 * ADR-0051 makes widening that a typed-out decision rather than a side effect of having a key.
 */
function resolveDocumentTextExtractor(): DocumentTextExtractor {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const enabled = process.env.AI_DOCUMENT_VISION === 'true';

  if (!enabled) {
    return createDocumentTextExtractor({
      visionUnavailableReason:
        'Optical extraction is off. A generated PDF is still read locally, but a photographed ' +
        'or scanned receipt cannot be read on this machine — set AI_DOCUMENT_VISION=true (with ' +
        'ANTHROPIC_API_KEY) to let a multimodal model transcribe it, which sends the document ' +
        'itself to the provider (ADR-0051), or itemize the receipt by hand.',
    });
  }
  if (apiKey === undefined || apiKey.length === 0) {
    return createDocumentTextExtractor({
      visionUnavailableReason:
        'AI_DOCUMENT_VISION is on but ANTHROPIC_API_KEY is not set, so there is no provider to ' +
        'transcribe with. A photographed receipt is refused rather than read as an empty one.',
    });
  }
  return createDocumentTextExtractor({
    vision: createVisionDocumentTextExtractor({
      apiKey,
      model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    }),
  });
}

/**
 * The real WhatsApp transport when both credentials are present; the refusing one otherwise.
 *
 * Both, because either alone cannot send: the token authenticates, and the phone number id is
 * which WhatsApp Business number it authenticates *as* — the number the recipient will see the
 * message come from.
 *
 * The refusing transport is not a degraded mode. It resolves every send as a recorded failure
 * naming the missing variables, so an installation without credentials gets an honest
 * configuration state rather than a delivery record claiming somebody was shown their balance.
 */
function resolveMessageTransport(): MessageTransport {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (
    accessToken === undefined ||
    accessToken.length === 0 ||
    phoneNumberId === undefined ||
    phoneNumberId.length === 0
  ) {
    return createUnconfiguredMessageTransport();
  }
  return createWhatsAppCloudTransport({ accessToken, phoneNumberId });
}

/**
 * The real balance provider when an endpoint and a token are both present; otherwise one that
 * reports every read as incomplete.
 *
 * The unconfigured case is deliberately *not* an empty success. `{ readings: [], complete:
 * true }` would say "we checked every account and there was nothing to report", and a screen
 * reading that would be entitled to show agreement — the exact misreport ADR-0046 exists to
 * prevent, applied to a different external system.
 */
function resolveBalanceProvider(): BalanceProviderPort {
  const endpointUrl = process.env.BALANCE_PROVIDER_URL?.trim();
  const accessToken = process.env.BALANCE_PROVIDER_TOKEN?.trim();
  if (
    endpointUrl === undefined ||
    endpointUrl.length === 0 ||
    accessToken === undefined ||
    accessToken.length === 0
  ) {
    return createUnconfiguredBalanceProvider();
  }
  return createHttpBalanceProvider({
    endpointUrl,
    accessToken,
    ...(process.env.BALANCE_PROVIDER_ID === undefined
      ? {}
      : { providerId: process.env.BALANCE_PROVIDER_ID.trim() }),
    ...(process.env.BALANCE_PROVIDER_LABEL === undefined
      ? {}
      : { label: process.env.BALANCE_PROVIDER_LABEL.trim() }),
  });
}

async function main(): Promise<void> {
  const database = await openDevDatabase();
  await database.migrate();

  const transport = resolveModelTransport();
  const documentText = resolveDocumentTextExtractor();
  const splitwise = resolveSplitwisePort();
  const messageTransport = resolveMessageTransport();
  const balanceProvider = resolveBalanceProvider();
  const authRequired = resolveAuthRequired();

  const deps: ApiDependencies = {
    db: database.db,
    ai: createAiService(transport),
    evidenceStore: createFilesystemEvidenceStore({ root: EVIDENCE_STORAGE_PATH }),
    documentText,
    splitwise,
    messageTransport,
    balanceProvider,
    authRequired,
    ...(INTAKE_FORWARDING_TOKEN === undefined
      ? {}
      : { intakeForwardingToken: INTAKE_FORWARDING_TOKEN }),
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
    console.log(
      `  document text:  local PDF text layer${
        documentText.describe().readsImages
          ? ' + model transcription of images (AI_DOCUMENT_VISION=true)'
          : ' only (a photographed receipt is refused, not read as empty)'
      }`,
    );
    const balances = balanceProvider.describe();
    console.log(
      `  balances:       ${
        balances.configured
          ? `${balances.label} via ${balances.endpointHost ?? 'a configured endpoint'} (compared, never a boundary)`
          : 'not configured (every read is recorded as incomplete, never as agreement)'
      }`,
    );
    const messaging = messageTransport.describe();
    console.log(
      `  messaging:      ${
        messaging.configured
          ? `${messaging.label} (a reviewed proof pack can be sent)`
          : 'not configured (a pack can be previewed and copied; sending refuses by name)'
      }`,
    );
    console.log(
      `  forwarding:     ${
        INTAKE_FORWARDING_TOKEN === undefined
          ? 'not configured (POST /api/intake/messages refuses every request)'
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
