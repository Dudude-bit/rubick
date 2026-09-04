import {
  LuKeyRound,
  LuPuzzle,
  LuRoute,
  LuScrollText,
  LuShipWheel,
  LuTerminal,
} from "react-icons/lu";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

const FEATURES = [
  {
    title: "Logs",
    Icon: LuScrollText,
    body: "Virtualised, multi-container, filtered server-side, repeats collapsed. They open where the answer is.",
  },
  {
    title: "Shell",
    Icon: LuTerminal,
    body: "A real terminal tab per pod. The session survives you looking elsewhere.",
  },
  {
    title: "Gateway API",
    Icon: LuRoute,
    body: "Gateways, all five route kinds, classes, policies. A route that is not serving says which of the eight links between listener and pod broke.",
  },
  {
    title: "Secrets",
    Icon: LuKeyRound,
    body: "Binary values shown as binary. Private keys never revealed. Boring on purpose.",
  },
  {
    title: "Custom resources",
    Icon: LuPuzzle,
    body: "Every CRD in the cluster, with YAML editing and validation. Yours included.",
  },
  {
    title: "Helm",
    Icon: LuShipWheel,
    body: "Releases, revisions, rollback, uninstall. No opinions about how you got here.",
  },
];

export function Features() {
  return (
    <Section eyebrow="Also in the box">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          The boring parts, done properly.
        </h2>
      </Reveal>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <Reveal
            key={f.title}
            delay={i * 55}
            className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
          >
            <f.Icon aria-hidden className="size-5 text-neutral-400" />
            <h3 className="mt-4 font-mono text-sm font-medium text-neutral-100">
              {f.title}
            </h3>
            <p className="mt-3 text-sm text-neutral-400">{f.body}</p>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
