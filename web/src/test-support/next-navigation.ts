/**
 * A stand-in for `next/navigation` under jsdom.
 *
 * The App Router's hooks read from a React context the framework provides at runtime; rendered
 * outside it, `useSearchParams()` returns `null` and `useRouter()` throws. Rather than making
 * every component defensive about a shape that is never null in the real app, the module is
 * replaced once, in `vitest.setup.ts`, and tests drive it through the helpers below.
 *
 * `pushedRoutes` is what makes the keyboard and command-palette tests meaningful: they assert
 * where a shortcut *would have* navigated, which is the whole of what those shortcuts do.
 */

import { vi } from "vitest";

let searchParams = new URLSearchParams();
let pathname = "/";

export const pushedRoutes: string[] = [];

export function setSearchParams(init: string | Record<string, string>): void {
  searchParams = new URLSearchParams(init as string);
}

export function setPathname(next: string): void {
  pathname = next;
}

/** Call from `afterEach`: a route pushed by one test must not be visible to the next. */
export function resetNavigation(): void {
  searchParams = new URLSearchParams();
  pathname = "/";
  pushedRoutes.length = 0;
}

export const navigationMock = {
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
  useRouter: () => ({
    push: (href: string) => {
      pushedRoutes.push(href);
    },
    replace: (href: string) => {
      pushedRoutes.push(href);
    },
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  redirect: (href: string) => {
    pushedRoutes.push(href);
  },
};
