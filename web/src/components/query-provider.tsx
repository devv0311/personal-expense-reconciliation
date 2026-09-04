"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

/**
 * One `QueryClient` per browser session, created inside the component so a server-rendered
 * request never leaks its cache into another visitor's (React Query's own SSR guidance) — even
 * though this app's data is entirely client-fetched (`ADR-0042`), keeping this pattern costs
 * nothing and avoids a real bug the moment any page adds server rendering later.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Financial data should look freshly checked, not cached from ten minutes ago.
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
