import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

const ANTI = [
  {
    title: "Cost estimates",
    body: "Spot pricing and negotiated rates make them wrong more often than right, and a wrong number about money poisons the right ones.",
  },
  {
    title: "A whole-cluster topology graph",
    body: "A force-directed blob looks like insight and answers nothing. Routing is a chain in a fixed order, so that is what you get.",
  },
  {
    title: "Editing routes or renewing certificates",
    body: "Reading them well is a feature. Writing them has a different blast radius. An ACME rate limit is five failures an hour.",
  },
  {
    title: "Guessing",
    body: 'If a name in a log line might be an object, it stays text. Anything never asked about says "not looked at" instead of leaving a gap that reads as "nothing there".',
  },
];

export function AntiFeatures() {
  return (
    <Section eyebrow="Scope, defended">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Features we are proud to not have.
        </h2>
      </Reveal>
      <ul className="mt-12 max-w-3xl">
        {ANTI.map((a, i) => (
          <Reveal
            key={a.title}
            as="li"
            delay={i * 65}
            className="relative flex gap-5 py-6"
          >
            {i > 0 ? (
              <span
                aria-hidden
                className="rule-x absolute inset-x-0 top-0 h-px bg-neutral-800/70"
              />
            ) : null}
            <span className="lock text-accent font-mono text-sm leading-6 select-none">
              no
            </span>
            <div>
              <h3 className="font-display font-bold">{a.title}</h3>
              <p className="mt-2 text-sm text-neutral-400">{a.body}</p>
            </div>
          </Reveal>
        ))}
      </ul>
    </Section>
  );
}
