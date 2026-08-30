import { Section } from "../components/section";
import { LINKS } from "../lib/site";

const INTEGRATIONS = [
  {
    name: "Traefik / ingress-nginx / Istio",
    body: "hosts, rules and middleware read as routing, annotations turned into sentences with the raw key beside each",
  },
  {
    name: "cert-manager",
    body: "expiry wherever TLS is named, and the issuance chain when renewal fails",
  },
  {
    name: "Argo CD / Flux",
    body: "every object says whether it is delivered, from which revision, and whether your edit will survive",
  },
  {
    name: "Prometheus",
    body: "real history, disk fullness, network traffic",
  },
  {
    name: "Loki",
    body: "logs that outlive the pod that wrote them",
  },
  {
    name: "GKE / EKS / AKS",
    body: "node pools, machine types, spot status, read from labels with no cloud account",
  },
];

export function Integrations() {
  return (
    <Section eyebrow="Extensions">
      <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
        It knows what you installed.
      </h2>
      <p className="mt-6 max-w-2xl text-neutral-400">
        Detected integrations need nothing from you. Their CRDs are in the
        cluster or they are not. Configured ones need an address, and Rubick
        never goes looking for one.
      </p>
      <dl className="mt-12 grid gap-x-12 gap-y-8 md:grid-cols-2">
        {INTEGRATIONS.map((x) => (
          <div key={x.name} className="border-l border-neutral-800 pl-5">
            <dt className="font-mono text-sm font-medium text-neutral-100">
              {x.name}
            </dt>
            <dd className="mt-2 text-sm text-neutral-400">{x.body}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-12 font-mono text-sm text-neutral-500">
        Adding one costs a folder and a line. See{" "}
        <a
          href={LINKS.contributing}
          className="text-neutral-300 underline decoration-neutral-700 underline-offset-4 transition-colors hover:text-white"
        >
          CONTRIBUTING
        </a>
        .
      </p>
    </Section>
  );
}
