"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The app-wide keyboard layer (`docs/roadmap.md` phase 21, ADR-0049).
 *
 * One rule governs everything here, and it is the reason this is a small hand-written listener
 * rather than a shortcut library: **a shortcut moves you somewhere or opens something; it never
 * completes a consequential decision.** `g b` goes to Balances. `Cmd+K` opens the palette.
 * Nothing in this file accepts a proposal, records a settlement, distributes a refund, or
 * copies a proof pack — those are buttons a person presses, after reading what they are about
 * to do (`CLAUDE.md`, "Consequential approval remains explicit").
 *
 * Keystrokes that originate inside a text field are ignored outright, so typing "g" into a
 * reason box never navigates away mid-sentence.
 */

export interface ShortcutSection {
  readonly title: string;
  readonly shortcuts: readonly { readonly keys: string; readonly description: string }[];
}

interface ShortcutContextValue {
  readonly openCommandPalette: () => void;
  readonly openShortcutHelp: () => void;
  /** Screens register their own triage keys here so the help dialog can list them. */
  readonly registerSection: (section: ShortcutSection) => () => void;
  readonly sections: readonly ShortcutSection[];
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

export function useShortcuts(): ShortcutContextValue {
  const value = useContext(ShortcutContext);
  if (value === null) {
    throw new Error("useShortcuts must be used inside <ShortcutProvider>.");
  }
  return value;
}

/** The `g`-prefixed destinations, shared by the help dialog and the listener below. */
export const GO_TO_DESTINATIONS = [
  { key: "v", href: "/review", label: "Review queue" },
  { key: "m", href: "/payments", label: "Payments" },
  { key: "d", href: "/evidence", label: "Evidence" },
  { key: "r", href: "/reconciliation", label: "Reconciliation" },
  { key: "e", href: "/expenses", label: "Expenses" },
  { key: "b", href: "/balances", label: "Balances" },
  { key: "s", href: "/splitwise", label: "Splitwise audit" },
  { key: "p", href: "/proof-packs", label: "Proof packs" },
  { key: "a", href: "/analytics", label: "Analytics" },
  { key: "u", href: "/automation", label: "Automation" },
  { key: "t", href: "/setup", label: "Setup" },
] as const;

const GLOBAL_SECTION: ShortcutSection = {
  title: "Anywhere",
  shortcuts: [
    { keys: "Cmd K / Ctrl K", description: "Open the command palette" },
    { keys: "?", description: "Show this list" },
    { keys: "Esc", description: "Close a dialog, or clear the current selection" },
    ...GO_TO_DESTINATIONS.map((destination) => ({
      keys: `g ${destination.key}`,
      description: `Go to ${destination.label.toLowerCase()}`,
    })),
  ],
};

/** True when a keystroke belongs to whatever the person is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function ShortcutProvider({
  children,
  renderOverlays,
}: {
  children: ReactNode;
  /** The palette and help dialogs, rendered by the shell so this file stays behavior-only. */
  renderOverlays: (state: {
    commandPaletteOpen: boolean;
    shortcutHelpOpen: boolean;
    closeCommandPalette: () => void;
    closeShortcutHelp: () => void;
    sections: readonly ShortcutSection[];
  }) => ReactNode;
}) {
  const router = useRouter();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [extraSections, setExtraSections] = useState<readonly ShortcutSection[]>([]);
  // A "g" seen a moment ago, waiting for its second key. Held in a ref, not state, so the
  // prefix never causes a render of its own.
  const pendingGo = useRef(false);
  const pendingGoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const openShortcutHelp = useCallback(() => setShortcutHelpOpen(true), []);

  const registerSection = useCallback((section: ShortcutSection) => {
    setExtraSections((current) => [...current, section]);
    return () => {
      setExtraSections((current) => current.filter((entry) => entry !== section));
    };
  }, []);

  useEffect(() => {
    const clearPending = () => {
      pendingGo.current = false;
      if (pendingGoTimer.current !== null) clearTimeout(pendingGoTimer.current);
      pendingGoTimer.current = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        clearPending();
        setCommandPaletteOpen(true);
        return;
      }
      if (isTypingTarget(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;

      if (event.key === "?") {
        event.preventDefault();
        clearPending();
        setShortcutHelpOpen(true);
        return;
      }

      if (pendingGo.current) {
        const destination = GO_TO_DESTINATIONS.find(
          (entry) => entry.key === event.key.toLowerCase(),
        );
        clearPending();
        if (destination !== undefined) {
          event.preventDefault();
          router.push(destination.href);
        }
        return;
      }

      if (event.key.toLowerCase() === "g") {
        pendingGo.current = true;
        // A prefix that never expires would turn an unrelated "r" a minute later into a
        // navigation. One second is long enough to type a pair and short enough to forget.
        pendingGoTimer.current = setTimeout(clearPending, 1000);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearPending();
    };
  }, [router]);

  const sections = useMemo(() => [GLOBAL_SECTION, ...extraSections], [extraSections]);

  const value = useMemo(
    () => ({ openCommandPalette, openShortcutHelp, registerSection, sections }),
    [openCommandPalette, openShortcutHelp, registerSection, sections],
  );

  return (
    <ShortcutContext.Provider value={value}>
      {children}
      {renderOverlays({
        commandPaletteOpen,
        shortcutHelpOpen,
        closeCommandPalette: () => setCommandPaletteOpen(false),
        closeShortcutHelp: () => setShortcutHelpOpen(false),
        sections,
      })}
    </ShortcutContext.Provider>
  );
}

/** Registers a screen's own triage keys for the duration it is mounted. */
export function useShortcutSection(section: ShortcutSection): void {
  const { registerSection } = useShortcuts();
  const title = section.title;
  const serialized = JSON.stringify(section.shortcuts);
  useEffect(() => {
    return registerSection({
      title,
      shortcuts: JSON.parse(serialized) as ShortcutSection["shortcuts"],
    });
  }, [registerSection, title, serialized]);
}
