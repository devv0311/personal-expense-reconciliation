@AGENTS.md

# web/ — persistent context

**Read `Design.md` before any visual or component change.** It's authoritative for tokens,
typography, component principles, layout/responsive/accessibility rules, and two documented
pitfalls (a `tailwind-merge` custom-token gotcha, a Tailwind v4 font-size-namespace mistake) worth
not re-making. See `README.md` for how to run this package and what phase 15 built.

The short version, if you only read one paragraph: this is a ledger, not a dashboard. One hero
figure per screen, sized `text-display`/`text-figure`; every other number stays quiet. Color is
semantic and single-purpose (`debit`/`credit`/`accent`/`attention` each mean exactly one thing —
`Design.md` "Color"). Reach for a styled native `<select>`/`<input>` before a headless component;
nothing in this app's current scope needs one. No icon library, no animation library, no card
around every section.
