import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * Renders with a fresh, retry-disabled QueryClient so a mocked-error test doesn't hang on retries.
 *
 * `rerender` is wrapped too, and deliberately: Testing Library's own `rerender` replaces the
 * tree *without* the wrapper it was first rendered in, so a second render of a component that
 * uses a query would throw "No QueryClient set" — a failure about the harness rather than
 * about the component under test. Re-wrapping with the **same** client keeps the rerender a
 * rerender: cache state survives it, exactly as it would in the app.
 */
export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...result,
    rerender: (next: ReactElement) =>
      result.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}
