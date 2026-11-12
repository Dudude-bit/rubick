import { Fragment } from "react";
import { FaGithub } from "react-icons/fa6";
import { ButtonLink } from "../components/button-link";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";

const RECEIPT = [
  ["license", "GPL-3.0-or-later"],
  ["runtime", "Tauri, Rust, kube-rs. React on top. No Electron."],
  ["account", "none"],
  ["telemetry", "none"],
] as const;

export function OpenSource() {
  return (
    <Section eyebrow="License">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Steal our code. Legally.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          GPL-3.0-or-later. Fork it, change it, ship the source with it. Running
          it at home or across your whole company is not distribution and
          obliges you to nothing.
        </p>
      </Reveal>
      <Reveal className="relative mt-8 max-w-2xl pl-5">
        <span
          aria-hidden
          className="rule-y absolute inset-y-0 left-0 w-px bg-neutral-700"
        />
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 font-mono text-sm">
          {RECEIPT.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-neutral-500">{k}</dt>
              <dd className="text-neutral-300">{v}</dd>
            </Fragment>
          ))}
        </dl>
      </Reveal>
      <div className="mt-8">
        <ButtonLink href={LINKS.github}>
          <FaGithub aria-hidden className="size-4" />
          Read the source
        </ButtonLink>
      </div>
    </Section>
  );
}
