import {
  FEATURE_ICONS,
  type FeatureIconKind,
} from "../components/feature-icons";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";

const FEATURES: {
  title: string;
  icon: FeatureIconKind;
  color: string;
  body: string;
}[] = [
  {
    title: "Logs",
    icon: "logs",
    color: "#7dd3fc",
    body: "Virtualised, multi-container, filtered server-side, repeats collapsed. They open where the answer is.",
  },
  {
    title: "Shell",
    icon: "shell",
    color: "#4ade80",
    body: "A real terminal tab per pod. The session survives you looking elsewhere.",
  },
  {
    title: "Gateway API",
    icon: "route",
    color: "#60a5fa",
    body: "Gateways, all five route kinds, classes, policies. A route that is not serving says which of the eight links between listener and pod broke.",
  },
  {
    title: "Secrets",
    icon: "secret",
    color: "#fbbf24",
    body: "Binary values shown as binary. Private keys never revealed. Boring on purpose.",
  },
  {
    title: "Custom resources",
    icon: "crd",
    color: "#c084fc",
    body: "Every CRD in the cluster, with YAML editing and validation. Yours included.",
  },
  {
    title: "Helm",
    icon: "helm",
    color: "#2dd4bf",
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
        {FEATURES.map((f, i) => {
          const Icon = FEATURE_ICONS[f.icon];
          return (
            <Reveal
              key={f.title}
              delay={i * 55}
              className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
            >
              <Icon className="size-6" style={{ color: f.color }} />
              <h3 className="mt-4 font-mono text-sm font-medium text-neutral-100">
                {f.title}
              </h3>
              <p className="mt-3 text-sm text-neutral-400">{f.body}</p>
            </Reveal>
          );
        })}
      </div>
    </Section>
  );
}
