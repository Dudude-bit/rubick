import { ButtonLink } from "../components/button-link";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";

export function Testimonials() {
  return (
    <Section eyebrow="Social proof">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          What people are saying.
        </h2>
      </Reveal>
      <Reveal className="ring relative mx-auto mt-12 max-w-2xl rounded-xl border border-dashed border-neutral-800 px-8 py-16 text-center">
        <p className="font-mono text-xl text-neutral-100 md:text-2xl">
          Nothing. Nobody has said anything yet.
        </p>
        <p className="mx-auto mt-6 max-w-md text-neutral-400">
          We could have written some quotes here and put smiling faces next to
          them. It felt off-brand for a product whose entire personality is not
          lying to you.
        </p>
        <p className="mx-auto mt-4 max-w-md text-neutral-400">
          The first thing this box will ever show is a report of a status we got
          wrong, and what we did about it.
        </p>
        <div className="mt-8 flex justify-center">
          <ButtonLink href={LINKS.reportLie} variant="ghost">
            Show us a status we got wrong
          </ButtonLink>
        </div>
      </Reveal>
    </Section>
  );
}
