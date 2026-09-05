import { Correction } from "../components/correction";
import { Reveal } from "../components/motion/reveal";
import { ReproducePanel } from "../components/reproduce";
import { TrafficChain } from "../components/traffic-chain";
import { Section } from "../components/section";
import { WindowFrame } from "../components/window-frame";
import { LIES } from "../lib/lies";

export function Lies() {
  return (
    <Section eyebrow="Status: fine, apparently">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Three lies you have already been told this week.
        </h2>
      </Reveal>
      <div className="mt-16 flex flex-col gap-24 md:gap-32">
        {LIES.map((l, i) => (
          <div
            key={l.slug}
            id={`lie-${i + 1}`}
            className={`scroll-mt-24 ${l.visual === "chain" ? "" : "items-center gap-12 md:grid md:grid-cols-2"}`}
          >
            <Reveal
              className={
                l.visual === "chain"
                  ? "max-w-3xl"
                  : i % 2 === 1
                    ? "md:order-last"
                    : undefined
              }
            >
              <p className="text-accent font-mono text-sm">LIE #{i + 1}</p>
              <p className="mt-3 font-display text-2xl font-bold tracking-tight md:text-3xl">
                {l.lie}
              </p>
              <p className="mt-4 text-neutral-400">{l.bust}</p>
              {l.visual === "chain" ? null : (
                <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
                  {l.evidence}
                </div>
              )}
              {l.correction ? <Correction /> : null}
              <a
                href={`/lies/${l.slug}`}
                className="mt-4 inline-flex min-h-11 items-center font-mono text-sm text-neutral-400 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
              >
                This lie on its own page, to send to whoever needs it
              </a>
            </Reveal>
            {l.visual === "chain" ? (
              <Reveal className="mt-10 rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 md:p-7">
                <TrafficChain />
              </Reveal>
            ) : (
              <Reveal settle delay={70} className="mt-8 md:mt-0">
                <WindowFrame img={l.img} alt={l.alt} />
              </Reveal>
            )}
          </div>
        ))}
      </div>
      <ReproducePanel className="mt-24 md:mt-32" />
    </Section>
  );
}
