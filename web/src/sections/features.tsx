import { Section } from "../components/section";

const FEATURES = [
  {
    title: "Logs",
    body: "Virtualised, multi-container, filtered server-side, repeats collapsed. They open where the answer is.",
  },
  {
    title: "Shell",
    body: "A real terminal tab per pod. The session survives you looking elsewhere.",
  },
  {
    title: "Gateway API",
    body: "Gateways, all five route kinds, classes, policies. A route that is not serving says which of the eight links between listener and pod broke.",
  },
  {
    title: "Secrets",
    body: "Binary values shown as binary. Private keys never revealed. Boring on purpose.",
  },
  {
    title: "Custom resources",
    body: "Every CRD in the cluster, with YAML editing and validation. Yours included.",
  },
  {
    title: "Helm",
    body: "Releases, revisions, rollback, uninstall. No opinions about how you got here.",
  },
];

export function Features() {
  return (
    <Section eyebrow="Also in the box">
      <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
        The boring parts, done properly.
      </h2>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
          >
            <h3 className="font-mono text-sm font-medium text-neutral-100">
              {f.title}
            </h3>
            <p className="mt-3 text-sm text-neutral-400">{f.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
