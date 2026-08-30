import { buttonClass, ButtonLink } from "./button-link";
import { Section } from "./section";
import { Footer } from "../sections/footer";
import { Nav } from "../sections/nav";
import { COMPETITORS } from "../lib/compare";
import { LINKS } from "../lib/site";

const PAGES = [
  { label: "The landing page", href: "/" },
  ...COMPETITORS.map((c) => ({
    label: `Rubick vs ${c.name}, honestly`,
    href: `/vs/${c.slug}`,
  })),
  { label: "The source, on GitHub", href: LINKS.github },
];

export function NotFound() {
  return (
    <>
      <Nav />
      <main>
        <Section eyebrow="HTTP 404">
          <h1 className="max-w-4xl font-display text-4xl font-bold tracking-tight md:text-6xl">
            This page does not exist.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-neutral-400">
            We checked. Rubick is a product about admitting what it does not
            know, and here is a live demonstration: we do not know this address,
            and no dashboard will draw it green for you.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => history.back()}
              className={buttonClass("primary")}
            >
              Go back
            </button>
            <ButtonLink href="/" variant="ghost">
              Start over
            </ButtonLink>
          </div>
          <p className="mt-14 font-mono text-sm text-neutral-500">
            Pages that do exist:
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {PAGES.map((p) => (
              <li key={p.href}>
                <a
                  href={p.href}
                  className="font-mono text-sm text-neutral-300 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
                >
                  {p.label}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      </main>
      <Footer />
    </>
  );
}
