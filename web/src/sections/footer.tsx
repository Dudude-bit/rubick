import { Reveal } from "../components/motion/reveal";
import { COMPETITORS } from "../lib/compare";
import { LINKS } from "../lib/site";

const FOOTER_LINKS = [
  { label: "GitHub", href: LINKS.github },
  { label: "Releases", href: LINKS.releases },
  { label: "Contributing", href: LINKS.contributing },
  { label: "Security", href: LINKS.security },
  { label: "GPL-3.0-or-later", href: LINKS.license },
];

export function Footer() {
  return (
    <footer className="border-t border-neutral-800/70">
      <Reveal className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-12">
        <nav className="flex flex-wrap gap-x-8 gap-y-3">
          {FOOTER_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sm text-neutral-400 transition-colors hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <p className="font-mono text-sm text-neutral-500">
          Honest comparisons:{" "}
          {COMPETITORS.map((c, i) => (
            <span key={c.slug}>
              {i > 0 ? " / " : ""}
              <a
                href={`/vs/${c.slug}`}
                className="text-neutral-300 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
              >
                vs {c.name}
              </a>
            </span>
          ))}
        </p>
        <p className="font-mono text-xs text-neutral-600">
          <span className="underline-draw">
            No analytics on this page either.
          </span>{" "}
          View source, it is just HTML.
        </p>
        <p className="font-mono text-xs text-neutral-600">
          <span data-receipt suppressHydrationWarning>
            Sizes are measured at build and written here.
          </span>
        </p>
      </Reveal>
    </footer>
  );
}
