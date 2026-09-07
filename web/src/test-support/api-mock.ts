/**
 * A tiny router in front of `global.fetch`, so a test says which endpoints exist rather than
 * writing a `url.includes(...)` chain per case.
 *
 * Two properties matter for what these tests assert:
 *
 * - **An unrouted request is a failure, loudly.** A screen that quietly fetches something the
 *   test did not expect is a screen the test is not really covering.
 * - **Every recorded call keeps its body**, so a test can prove what a decision actually sent —
 *   the actor, the reason, the item attributions — not merely that a button was clickable.
 */

import { expect, vi } from "vitest";

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export interface ApiMock {
  readonly calls: readonly RecordedCall[];
  callsTo(fragment: string): readonly RecordedCall[];
  /** Asserts exactly one matching call and returns its parsed body. */
  bodyOf(fragment: string): Record<string, unknown>;
}

type Route = (url: string, init: RequestInit | undefined) => unknown;

export interface RouteMap {
  readonly [pathFragment: string]: Route | unknown;
}

export function mockApi(routes: RouteMap, options: { status?: number } = {}): ApiMock {
  const calls: RecordedCall[] = [];

  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });

    const key = Object.keys(routes)
      // Longest match wins, so `/api/expenses/:id/items` is not shadowed by `/api/expenses`.
      .sort((a, b) => b.length - a.length)
      .find((fragment) => url.includes(fragment));

    if (key === undefined) {
      return Promise.reject(
        new Error(`No route mocked for ${method} ${url}. Add it to the test's route map.`),
      );
    }

    const route = routes[key];
    const payload = typeof route === "function" ? (route as Route)(url, init) : route;
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: options.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;

  return {
    calls,
    callsTo: (fragment) => calls.filter((call) => call.url.includes(fragment)),
    bodyOf(fragment) {
      const matching = calls.filter((call) => call.url.includes(fragment));
      expect(matching).toHaveLength(1);
      return matching[0]!.body as Record<string, unknown>;
    },
  };
}

/** Every request fails with one API error body — the shape `ErrorBlock` renders. */
export function mockApiFailure(code: string, message: string, status = 500): void {
  global.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
}

/** A request that never settles — the loading state, held open for as long as a test needs. */
export function mockApiPending(): void {
  global.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}
