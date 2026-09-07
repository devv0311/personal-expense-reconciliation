import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { navigationMock } from "./src/test-support/next-navigation";

/**
 * `next/navigation`'s hooks read a context the App Router provides at runtime. Under jsdom
 * there is none, so `useSearchParams()` returns `null` and `useRouter()` throws — replaced once
 * here rather than making every component defensive about a shape the real app never sees.
 * `src/test-support/next-navigation.ts` is what a test drives it through.
 */
vi.mock("next/navigation", () => navigationMock);
