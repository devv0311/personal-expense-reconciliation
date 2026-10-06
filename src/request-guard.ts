/**
 * Which requests this process will serve at all, decided from two headers a browser always sends.
 *
 * It lives beside `server.ts`, not in `src/api`, for the reason CORS does: it is a transport
 * concern, and `src/api` has no idea who is calling it. It is not authentication. It closes two
 * ways a web page the owner merely *visits* could use the owner's own browser as a way in to a
 * ledger that has no password because it only listens on loopback:
 *
 *  - **A cross-site write.** CORS stops a hostile page *reading* a response; it never stops the
 *    browser *sending* a "simple" request — a `POST` whose body is declared `text/plain` needs no
 *    preflight, and the JSON parser does not care what the body was declared as. Every write
 *    route would otherwise accept it, with no cookie because there is no session to steal. A
 *    browser always labels such a request with its `Origin`, so a write whose `Origin` is not the
 *    one web origin this API serves is refused. A caller that sends no `Origin` (a script, `curl`,
 *    a test) is not a browser acting for a hostile page and is unaffected.
 *  - **DNS rebinding.** A hostile page's own domain can be re-pointed at 127.0.0.1, which makes
 *    the *read* same-origin from the browser's point of view. The `Host` header still names the
 *    hostile domain, so on a loopback bind a request whose `Host` is not a loopback name is refused.
 *
 * Neither rule weakens anything: a browser talking to this API from the configured web origin is
 * always allowed, and a bind to a real interface keeps authentication on by default
 * (`resolveAuthRequired` in `server.ts`).
 */

/**
 * Headers every response carries, whatever route answered it. A DAST scan (HawkScan, round 15) found `X-Content-Type-Options` missing on every JSON
 * route; the evidence-download route already set it. `nosniff` stops a browser reinterpreting a response body as another type, which matters most for
 * the uploaded documents this API serves back and costs nothing on JSON.
 */
export const BASELINE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
};

/** Applies {@link BASELINE_RESPONSE_HEADERS} through any `setHeader`-shaped function (a Node `ServerResponse`, or a test double). */
export function applyBaselineHeaders(setHeader: (name: string, value: string) => unknown): void {
  for (const [name, value] of Object.entries(BASELINE_RESPONSE_HEADERS)) setHeader(name, value);
}

/** What the check needs to know about one request. Both headers are `null` when absent. */
export interface GuardedRequest {
  readonly method: string;
  readonly origin: string | null;
  readonly host: string | null;
}

export interface RequestGuardPolicy {
  /** The one web origin allowed to write — the same value as the CORS allow-origin. */
  readonly allowedOrigin: string;
  /** True when the server only listens on loopback, so only loopback names are legitimate hosts. */
  readonly loopbackBound: boolean;
}

export interface RefusedRequest {
  readonly status: 403;
  readonly code: 'ORIGIN_NOT_ALLOWED' | 'HOST_NOT_ALLOWED';
  readonly message: string;
}

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The host name in a `Host` header, without a port and without IPv6 brackets. */
export function hostName(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 || trimmed.indexOf(':') !== colon ? trimmed : trimmed.slice(0, colon);
}

/** `null` when the request may proceed; otherwise what to answer instead. */
export function refuseUntrustedRequest(
  request: GuardedRequest,
  policy: RequestGuardPolicy,
): RefusedRequest | null {
  if (
    policy.loopbackBound &&
    request.host !== null &&
    !LOOPBACK_NAMES.has(hostName(request.host))
  ) {
    return {
      status: 403,
      code: 'HOST_NOT_ALLOWED',
      message:
        'This ledger only answers requests addressed to localhost, 127.0.0.1 or ::1. A request ' +
        'addressed to another name is refused so a web page cannot reach it by re-pointing a domain.',
    };
  }

  if (
    !SAFE_METHODS.has(request.method.toUpperCase()) &&
    request.origin !== null &&
    request.origin !== policy.allowedOrigin
  ) {
    return {
      status: 403,
      code: 'ORIGIN_NOT_ALLOWED',
      message:
        'This request was sent by a web page on another origin, and changes to the ledger are only ' +
        'accepted from the one web origin this ledger is configured to serve. Nothing was changed.',
    };
  }

  return null;
}
