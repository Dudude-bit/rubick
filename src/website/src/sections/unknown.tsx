import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

const ANSWERS = [
  {
    title: "Looked, and it was empty",
    rubick: "0 Gateways",
    tone: "neutral",
    note: "The list was read and came back empty. This is the only one of the three that means what the zero says.",
  },
  {
    title: "Asked, and was refused",
    rubick: "You do not have permission to list these",
    tone: "warn",
    note: "The cluster answered 403. Whose decision it was is the one fact that makes it actionable, so that is what the row says.",
  },
  {
    title: "Never asked",
    rubick: "Not looked at",
    tone: "dashed",
    note: "Named, so a group that is absent is never read as a group that is empty. A gap on a page is a claim; this is not.",
  },
] as const;

const TONE = {
  neutral: "border-neutral-700 text-neutral-200",
  warn: "border-amber-400/70 text-amber-200",
  dashed: "border-dashed border-neutral-600 text-neutral-400",
} as const;

export function Unknown() {
  return (
    <Section eyebrow="The third answer">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Nothing there, or nobody looked?
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          A list that came back empty, a list the cluster refused to give, and a
          list nobody asked for draw the same green zero on most dashboards.
          Rubick keeps the three apart, because two of them are not answers.
        </p>
      </Reveal>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {ANSWERS.map((a, i) => (
          <Reveal
            key={a.title}
            delay={i * 70}
            className="flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
          >
            <h3 className="font-display font-bold">{a.title}</h3>
            <dl className="mt-5 flex flex-col gap-4 font-mono text-sm">
              <div>
                <dt className="text-xs text-neutral-500">most dashboards</dt>
                <dd className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-neutral-700 px-2.5 py-1 text-neutral-200">
                  <span className="size-1.5 rounded-full bg-green-400" />0
                  Gateways
                </dd>
              </div>
              <div className="relative pt-4">
                <span
                  aria-hidden
                  className="rule-x absolute inset-x-0 top-0 h-px bg-neutral-800"
                />
                <dt className="text-xs text-neutral-500">Rubick</dt>
                <dd
                  className={`mt-1.5 inline-flex items-center gap-2 rounded-md border px-2.5 py-1 ${TONE[a.tone]}`}
                >
                  {a.tone === "neutral" ? (
                    <span className="size-1.5 rounded-full bg-neutral-500" />
                  ) : null}
                  {a.rubick}
                </dd>
              </div>
            </dl>
            <p className="mt-5 text-sm text-neutral-400">{a.note}</p>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
