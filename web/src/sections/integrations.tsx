import {
  LuArchive,
  LuActivity,
  LuCloud,
  LuGitBranch,
  LuShieldCheck,
  LuWaypoints,
} from "react-icons/lu";
import { DetectionDiagram } from "../components/detection-diagram";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";

const INTEGRATIONS = [
  {
    name: "Traefik / ingress-nginx / Istio",
    Icon: LuWaypoints,
    color: "#24a1c1",
    body: "hosts, rules and middleware read as routing, annotations turned into sentences with the raw key beside each",
  },
  {
    name: "cert-manager",
    Icon: LuShieldCheck,
    color: "#4f8ef7",
    body: "expiry wherever TLS is named, and the issuance chain when renewal fails",
  },
  {
    name: "Argo CD / Flux",
    Icon: LuGitBranch,
    color: "#ef7b4d",
    body: "every object says whether it is delivered, from which revision, and whether your edit will survive",
  },
  {
    name: "Prometheus",
    Icon: LuActivity,
    color: "#e6522c",
    body: "real history, disk fullness, network traffic",
  },
  {
    name: "Loki",
    Icon: LuArchive,
    color: "#f5bc1c",
    body: "logs that outlive the pod that wrote them",
  },
  {
    name: "GKE / EKS / AKS",
    Icon: LuCloud,
    color: "#7dd3fc",
    body: "node pools, machine types, spot status, read from labels with no cloud account",
  },
];

export function Integrations() {
  return (
    <Section id="integrations" eyebrow="Extensions">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          It knows what you installed.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Detected integrations need nothing from you. Their CRDs are in the
          cluster or they are not. Configured ones need an address, and Rubick
          never goes looking for one.
        </p>
      </Reveal>
      <DetectionDiagram />
      <dl className="mt-12 grid gap-x-12 gap-y-8 md:grid-cols-2">
        {INTEGRATIONS.map((x, i) => (
          <Reveal key={x.name} delay={i * 45} className="relative pl-5">
            <span
              aria-hidden
              className="rule-y absolute inset-y-0 left-0 w-px opacity-80"
              style={{ background: x.color }}
            />
            <dt className="flex items-center gap-2.5 font-mono text-sm font-medium text-neutral-100">
              <x.Icon
                aria-hidden
                className="size-4 shrink-0"
                style={{ color: x.color }}
              />
              {x.name}
            </dt>
            <dd className="mt-2 text-sm text-neutral-400">{x.body}</dd>
          </Reveal>
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
