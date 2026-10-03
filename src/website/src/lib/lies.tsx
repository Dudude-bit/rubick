import type { ReactNode } from "react";
import { Trace } from "../components/motion/trace";
import { TruthSwap } from "../components/motion/truth-swap";
import { IMG, SITE } from "./site";

export type Lie = {
  slug: string;
  short: string;
  lie: string;
  bust: string;
  description: string;
  reported: string;
  observed: string;
  evidence: ReactNode;
  visual?: "chain";
  correction?: true;
  /**
   * Its own reproduce block, for a lie the shared throwaway cluster cannot
   * show. The first three live in plain objects and need no CNI; this one
   * needs a cluster that actually enforces policy.
   */
  reproduce?: {
    heading: string;
    blurb: string;
    commands: string[];
    note: string;
  };
  img: (typeof IMG)[keyof typeof IMG];
  alt: string;
};

export const LIES: Lie[] = [
  {
    slug: "running",
    short: "Running",
    lie: '"Running", says the pod.',
    bust: "The container inside has crashed fourteen times. .status.phase does not care, and most dashboards read .status.phase. Rubick derives status the way kubectl does, so a crashloop looks like a crashloop. And when you open the logs they open on the container that failed, at its previous run, not the fresh copy that has not died yet.",
    description:
      "A crashlooping pod reports phase Running and most dashboards believe it. Rubick derives status the way kubectl does and opens the log of the run that failed.",
    reported: "Running",
    observed: "CrashLoopBackOff",
    evidence: (
      <TruthSwap
        reported="Running"
        observed="CrashLoopBackOff · log opened on the run that failed"
      />
    ),
    correction: true,
    img: IMG.logs,
    alt: "Logs opened on the failing init container's previous run",
  },
  {
    slug: "all-green",
    short: "All green",
    lie: '"All green", says the Service.',
    bust: "Healthy pods, matching selector, one mistyped port name. The Service publishes nothing, and it will stay green all week. Rubick reads the endpoints the cluster actually publishes, not the ones you meant to publish.",
    description:
      "Ready pods, a matching selector and a mistyped port name: the Service publishes no usable endpoint and stays green. Rubick reads the EndpointSlices the cluster actually wrote.",
    reported: "3 endpoints",
    observed: "no port published",
    evidence: (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 font-mono text-sm text-neutral-300">
          <span className="size-1.5 rounded-full bg-green-400" />
          selector matches 3/3 pods
        </p>
        <TruthSwap
          reported="3 endpoints"
          observed='published with no port · "htp" matches no container'
        />
      </div>
    ),
    img: IMG.connections,
    alt: "Connections tab grouping a workload's network paths by question",
  },
  {
    slug: "no-route",
    short: "No route",
    lie: '"No route to host", says nobody at all.',
    bust: "Somewhere between the Ingress and the pod, the request dies quietly. Rubick draws the whole chain on the workload's own page, and where the path stops it names the reason: a backend that does not exist, a selector matching nothing, pods running but not ready.",
    description:
      "An Ingress rule pointing at a Service that was never created is accepted, unmarked and dead. Rubick draws the traffic chain and names the link where it stops.",
    reported: "Ingress accepted",
    observed: "Service api-v2 not found",
    evidence: (
      <Trace
        steps={[
          { label: "Ingress" },
          { label: "rule /api" },
          { label: "Service api-v2", tone: "bad" },
        ]}
        linkTone="bad"
        reason="Service api-v2 does not exist. Nothing past it was looked at."
      />
    ),
    visual: "chain",
    img: IMG.chain,
    alt: "A traffic chain that stops, with the reason named at the broken link",
  },
  {
    slug: "protected",
    short: "Protected",
    lie: '"Protected", says the namespace.',
    bust: "Four network policies in the list, three of them enforced. The fourth has an In operator inside an ingress rule with no values under it, which the Cilium operator cannot parse, so it throws the rule away and keeps the object. The name is the same, the age is the same, and the selector at the top still reads as if it covers those pods, which are now open. The only record is a condition inside the policy's status, and no ordinary list of custom resources shows it. Rubick puts that answer first in the row and names the pods left uncovered.",
    description:
      "A CiliumNetworkPolicy its operator rejects stays in the cluster looking like one that works. Rubick reads the Valid condition and shows which pods are left open.",
    reported: "4 policies",
    observed: "1 thrown away for a typo",
    evidence: (
      <div className="flex flex-col gap-2">
        <TruthSwap
          reported="4 policies"
          observed="3 enforcing · 1 thrown away for a typo"
        />
        <p className="font-mono text-sm text-neutral-500">
          Valid: False · invalid label selector: matchExpressions[0].values:
          Required value: must be specified when `operator` is 'In' or 'NotIn'
        </p>
        <p className="font-mono text-sm text-neutral-500">
          kubectl get cnp prints a VALID column, so the CLI is not fooled.
        </p>
      </div>
    ),
    reproduce: {
      heading: "One cluster, one typo.",
      blurb:
        "This one needs a CNI that actually enforces policy, so the throwaway cluster is a little larger than the others: kind without its default network plugin, then Cilium on top. The typo is an In operator with no values under it, four lines deep in an ingress rule, which is easy to write and hard to spot again afterwards.",
      commands: [
        "kind create cluster --config https://rubick.tech/lies/cilium-kind.yaml",
        "helm repo add cilium https://helm.cilium.io/ && helm install cilium cilium/cilium -n kube-system --set ipam.mode=kubernetes",
        "kubectl apply -f https://rubick.tech/lies/protected.yaml",
        "kubectl -n rubick-lies get cnp",
      ],
      note: "# kubectl prints a VALID column, so the CLI is not fooled. A list of custom resources shows four rows and stops there.",
    },
    img: IMG.cilium,
    alt: "Endpoints with the policies that select them, and the ones nothing covers",
  },
];

/** The count as a word, so a fifth lie does not leave the heading wrong. */
export const LIES_COUNT_SAID =
  ["no", "one", "two", "three", "four", "five", "six", "seven"][LIES.length] ??
  String(LIES.length);

export function lieNumber(l: Lie) {
  return LIES.indexOf(l) + 1;
}

export function lieHead(l: Lie) {
  const url = `${SITE.url}/lies/${l.slug}`;
  const title = `Lie #${lieNumber(l)}: ${l.lie}`;
  const image = `${SITE.url}/og/${l.slug}.png`;
  return {
    meta: [
      { title },
      { name: "description", content: l.description },
      { property: "og:title", content: title },
      { property: "og:description", content: l.description },
      { property: "og:url", content: url },
      { property: "og:image", content: image },
      {
        property: "og:image:alt",
        content: `${l.reported}, struck out, next to ${l.observed}`,
      },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: l.description },
      { name: "twitter:image", content: image },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
