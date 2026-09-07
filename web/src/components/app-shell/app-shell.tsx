"use client";

import type { ReactNode } from "react";
import { CommandPalette } from "@/components/app-shell/command-palette";
import { ShortcutHelp } from "@/components/app-shell/shortcut-help";
import { ShortcutProvider } from "@/components/app-shell/shortcuts";
import { Nav } from "@/components/nav";
import { QueryProvider } from "@/components/query-provider";

/**
 * The chrome every screen sits inside: query cache, keyboard layer, navigation, and the two
 * overlays the keyboard layer opens.
 *
 * A skip link comes first in the DOM so a keyboard reader can get past the six-item nav in one
 * key rather than six — the nav is small enough that this is a courtesy rather than a rescue,
 * but it is the difference between a 100 and a 96 on the accessibility bar `Design.md` sets.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <ShortcutProvider
        renderOverlays={({
          commandPaletteOpen,
          shortcutHelpOpen,
          closeCommandPalette,
          closeShortcutHelp,
          sections,
        }) => (
          <>
            <CommandPalette open={commandPaletteOpen} onClose={closeCommandPalette} />
            <ShortcutHelp open={shortcutHelpOpen} onClose={closeShortcutHelp} sections={sections} />
          </>
        )}
      >
        <a
          href="#main"
          className="sr-only rounded-sm bg-panel px-3 py-2 text-body text-ink focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:border focus:border-rule"
        >
          Skip to content
        </a>
        <Nav />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-7 sm:px-6 sm:py-10"
        >
          {children}
        </main>
      </ShortcutProvider>
    </QueryProvider>
  );
}
