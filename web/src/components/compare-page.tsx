import { ButtonLink } from "./button-link";
import { Section } from "./section";
import { Footer } from "../sections/footer";
import { Nav } from "../sections/nav";
import { LAST_VERIFIED, type Competitor } from "../lib/compare";
import { LINKS } from "../lib/site";

function PickList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
      <h2 className="font-mono text-sm font-medium text-neutral-100">
        {title}
      </h2>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item} className="flex gap-3 text-sm text-neutral-400">
            <span className="text-accent select-none">·</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ComparePage({ c }: { c: Competitor }) {
  return (
    <>
      <Nav />
      <main>
        <Section eyebrow="An honest comparison">
          <h1 className="max-w-4xl font-display text-4xl font-bold tracking-tight md:text-6xl">
            Rubick vs {c.name}.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-neutral-400">{c.verdict}</p>

          <div className="mt-14 grid gap-4 md:grid-cols-2">
            <PickList title={`Pick ${c.name} if`} items={c.pickThem} />
            <PickList title="Pick Rubick if" items={c.pickRubick} />
          </div>

          <div className="mt-14 overflow-x-auto rounded-xl border border-neutral-800">
            <table className="w-full min-w-130 border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900/60 text-left font-mono">
                  <th className="px-5 py-3 font-medium text-neutral-500"></th>
                  <th className="px-5 py-3 font-medium text-neutral-100">
                    Rubick
                  </th>
                  <th className="px-5 py-3 font-medium text-neutral-100">
                    {c.name}
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((row) => (
                  <tr
                    key={row.label}
                    className="border-b border-neutral-800/60 last:border-0"
                  >
                    <td className="px-5 py-3 font-mono text-neutral-500">
                      {row.label}
                    </td>
                    <td className="px-5 py-3 text-neutral-200">{row.rubick}</td>
                    <td className="px-5 py-3 text-neutral-400">{row.them}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-6 max-w-2xl text-sm text-neutral-400">
            {c.honestNote}
          </p>
          <p className="mt-3 font-mono text-sm text-neutral-500">
            Last verified {LAST_VERIFIED}. Facts age; when in doubt, trust their
            site over this table.
          </p>

          <div className="mt-12 flex flex-wrap items-center gap-4">
            <ButtonLink href="/#install">Try Rubick</ButtonLink>
            <ButtonLink href={LINKS.github} variant="ghost">
              Read the source
            </ButtonLink>
          </div>
        </Section>
      </main>
      <Footer />
    </>
  );
}
