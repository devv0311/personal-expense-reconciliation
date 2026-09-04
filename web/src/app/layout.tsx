import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Nav } from "@/components/nav";
import { QueryProvider } from "@/components/query-provider";
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

export const metadata: Metadata = {
  title: "Ledger — reconciliation",
  description:
    "Personal financial reconciliation: who benefited from every payment, and who owes whom.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-paper font-sans text-ink antialiased">
        <QueryProvider>
          <Nav />
          <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
