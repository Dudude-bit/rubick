import { ButtonLink } from "../components/button-link";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";

export function OpenSource() {
  return (
    <Section eyebrow="License">
      <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
        Steal our code. Legally.
      </h2>
      <p className="mt-6 max-w-2xl text-neutral-400">
        GPL-3.0-or-later. Fork it, change it, sell it if you like, ship the
        source with it. Running it at home or across your whole company is not
        distribution and obliges you to nothing.
      </p>
      <p className="mt-4 max-w-2xl font-mono text-sm text-neutral-500">
        Built with Tauri, Rust and kube-rs. React on top. No Electron anywhere
        in the building.
      </p>
      <div className="mt-8">
        <ButtonLink href={LINKS.github}>Read the source</ButtonLink>
      </div>
    </Section>
  );
}
