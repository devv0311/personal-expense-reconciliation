import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import { AppShell } from "@/components/app-shell/app-shell";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

/**
 * The third face, and the only one that is not load-bearing for a number.
 *
 * `web/Design.md` said for a year not to introduce a second typeface, and the reason was sound:
 * every face added is another thing that can disagree with the ledger's tabular alignment. This
 * one is confined to headings a person reads as sentences — a page title, a section title, the
 * one decision on the front page — and never touches a figure, a state word, an id or a table.
 * Money stays in `IBM_Plex_Mono`, body and every control stay in `IBM_Plex_Sans`.
 *
 * `display: "swap"` on purpose: a heading that is invisible until a webfont arrives is worse
 * than the same heading briefly set in the fallback serif.
 */
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  // Named after what the product answers, not after the screen that used to be the front door.
  title: "Ledger — what your records add up to",
  description:
    "Turn statements, bills, receipts and screenshots into what you spent, who owes whom, and what still needs a decision.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable} h-full`}
    >
      <body className="flex min-h-full flex-col bg-paper font-sans text-ink antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
