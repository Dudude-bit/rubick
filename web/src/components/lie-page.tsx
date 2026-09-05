import { ButtonLink } from "./button-link";
import { Reveal } from "./motion/reveal";
import { ReproducePanel } from "./reproduce";
import { TrafficChain } from "./traffic-chain";
import { Section } from "./section";
import { WindowFrame } from "./window-frame";
import { Footer } from "../sections/footer";
import { Nav } from "../sections/nav";
import { LIES, lieNumber, type Lie } from "../lib/lies";

export function LiePage({ lie }: { lie: Lie }) {
  const n = lieNumber(lie);
  const others = LIES.filter((l) => l !== lie);
  return (
    <>
      <Nav />
      <main>
        <Section eyebrow={`Lie #${n} of 3`}>
          <Reveal>
            <h1 className="max-w-4xl font-display text-4xl font-bold tracking-tight md:text-6xl">
              {lie.lie}
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-neutral-400">
              {lie.bust}
            </p>
            <div className="mt-8 max-w-2xl rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
              {lie.evidence}
            </div>
          </Reveal>
          {lie.visual === "chain" ? (
            <Reveal className="mt-10 rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 md:p-7">
              <TrafficChain />
            </Reveal>
          ) : null}
          <Reveal settle className="mt-12">
            <WindowFrame img={lie.img} alt={lie.alt} eager />
          </Reveal>
          <ReproducePanel className="mt-16" />
          <Reveal className="mt-16 flex flex-wrap items-center gap-4">
            <ButtonLink href="/#install">Get Rubick</ButtonLink>
            {others.map((o) => (
              <a
                key={o.slug}
                href={`/lies/${o.slug}`}
                className="inline-flex min-h-11 items-center font-mono text-sm text-neutral-400 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
              >
                Lie #{lieNumber(o)}: {o.short}
              </a>
            ))}
          </Reveal>
        </Section>
      </main>
      <Footer />
    </>
  );
}
