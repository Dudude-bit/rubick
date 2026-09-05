import { useState } from "react";
import { Reveal } from "../components/motion/reveal";
import { Section } from "../components/section";
import { LINKS } from "../lib/site";
import { useHydrated } from "../lib/use-hydrated";

type Label = { key: string; reads: string };
type Provider = {
  id: string;
  name: string;
  credential: string;
  signIn: string;
  reads: string;
  labels: Label[];
  exercised:
    "Daily" | "Least exercised" | "Fixture verified" | "Not documented";
  evidence: string;
};

const UNDOCUMENTED = {
  exercised: "Not documented",
  evidence:
    "The README does not state a live-cluster testing level for this path.",
} as const;
const LOCAL_AUTH = {
  credential: "Client certificate or token",
  signIn: "Rubick uses the credentials in your kubeconfig, as kubectl does.",
};
const PROVIDERS: Provider[] = [
  {
    id: "gke",
    name: "GKE",
    credential: "gke-gcloud-auth-plugin",
    signIn:
      "A GKE exec kubeconfig names this plugin to get a token. Rubick reads that configuration.",
    reads:
      "The context name identifies the GKE flavour. Node labels name the pool and spot or preemptible capacity.",
    labels: [
      { key: "cloud.google.com/gke-nodepool", reads: "node pool" },
      { key: "cloud.google.com/gke-spot", reads: "spot when true" },
      {
        key: "cloud.google.com/gke-preemptible",
        reads: "preemptible when true",
      },
      {
        key: "cloud.google.com/gke-provisioning",
        reads: "spot or preemptible",
      },
    ],
    exercised: "Daily",
    evidence:
      "Rubick is developed against a GKE cluster running Traefik and cert-manager, inspected every day.",
  },
  {
    id: "eks",
    name: "EKS",
    credential: "aws eks get-token",
    signIn:
      "An EKS exec kubeconfig can name this command to get a token. Rubick uses the configured command and credentials.",
    reads:
      "The context ARN or EKS name identifies the EKS flavour. Labels name managed node groups; Karpenter labels name the pool that made its nodes.",
    labels: [
      { key: "eks.amazonaws.com/nodegroup", reads: "node group" },
      {
        key: "eks.amazonaws.com/capacityType",
        reads: "spot, compared without case",
      },
      { key: "karpenter.sh/nodepool", reads: "Karpenter pool" },
      { key: "karpenter.sh/provisioner-name", reads: "older Karpenter pool" },
      { key: "karpenter.sh/capacity-type", reads: "spot when spot" },
    ],
    exercised: "Least exercised",
    evidence:
      "The README names AWS among the least exercised paths. The ALB integration has unit tests, without live EKS verification.",
  },
  {
    id: "aks",
    name: "AKS",
    credential: "kubelogin",
    signIn:
      "An AKS exec kubeconfig can name kubelogin to get a token. The credentials come from your kubeconfig setup.",
    reads:
      "The context name identifies the AKS flavour. Labels name the agent pool and spot capacity.",
    labels: [
      { key: "kubernetes.azure.com/agentpool", reads: "agent pool" },
      { key: "kubernetes.azure.com/priority", reads: "spot when spot" },
      {
        key: "kubernetes.azure.com/scalesetpriority",
        reads: "older spot label",
      },
    ],
    exercised: "Least exercised",
    evidence:
      "The README names Azure among the least exercised paths. The AKS add-ons have unit tests, without live AKS verification.",
  },
  {
    id: "k3s",
    name: "k3s",
    ...LOCAL_AUTH,
    reads:
      "A k3s word in the context name reads as K3S before cloud names are considered. This integration adds no provider-specific node label keys.",
    labels: [],
    ...UNDOCUMENTED,
  },
  {
    id: "k3d",
    name: "k3d",
    ...LOCAL_AUTH,
    reads:
      "A context starting with k3d- reads as K3D, even if its name also says eks. This integration adds no provider-specific node label keys.",
    labels: [],
    exercised: "Fixture verified",
    evidence:
      "The lies.yaml fixture on this page was applied and read on a k3d cluster while this page was built.",
  },
  {
    id: "kind",
    name: "kind",
    ...LOCAL_AUTH,
    reads:
      "Rubick reads Kubernetes objects through the configured context. There is no kind-specific flavour or node label reader in the integration registry.",
    labels: [],
    ...UNDOCUMENTED,
  },
  {
    id: "minikube",
    name: "minikube",
    ...LOCAL_AUTH,
    reads:
      "A context name containing minikube reads as LOCAL before cloud names are considered. This integration adds no provider-specific node label keys.",
    labels: [],
    ...UNDOCUMENTED,
  },
  {
    id: "other",
    name: "Anything else with a kubeconfig",
    credential: "Token, certificate, OIDC or exec plugin",
    signIn:
      "Your kubeconfig states how to authenticate. Rubick uses those credentials to reach the Kubernetes API.",
    reads:
      "Kubernetes objects and recognised node labels, where present and permitted. An unrecognised label does not establish a cloud, pool or spot status.",
    labels: [],
    ...UNDOCUMENTED,
  },
];

const SHARED_LABELS: Label[] = [
  { key: "node.kubernetes.io/instance-type", reads: "machine type" },
  { key: "beta.kubernetes.io/instance-type", reads: "older machine type" },
  { key: "topology.kubernetes.io/zone", reads: "zone" },
  { key: "failure-domain.beta.kubernetes.io/zone", reads: "older zone" },
  { key: "topology.kubernetes.io/region", reads: "region" },
  { key: "failure-domain.beta.kubernetes.io/region", reads: "older region" },
];

function LabelKeys({ labels }: { labels: Label[] }) {
  return (
    <dl className="mt-4 space-y-3">
      {labels.map((label) => (
        <div key={label.key}>
          <dt className="break-all font-mono text-xs text-neutral-200">
            {label.key}
          </dt>
          <dd className="mt-1 text-xs text-neutral-400">{label.reads}</dd>
        </div>
      ))}
    </dl>
  );
}

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

export function Anywhere() {
  const interactive = useHydrated();
  const [selected, setSelected] = useState("gke");

  return (
    <Section id="anywhere" eyebrow="Where it runs">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          Any cluster your kubeconfig can reach.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Your kubeconfig names the cluster and the credentials. Rubick reads it
          and signs in the way kubectl does, OIDC and exec plugins included.
          Settings, Diagnostics names the directories it searches for a plugin
          and which ones resolve, so a plugin your terminal finds and the app
          does not is a named problem, not a blank screen. Kubernetes 1.21+ is
          required.
        </p>
      </Reveal>
      <Reveal className="mt-12">
        {interactive ? (
          <div
            role="group"
            aria-label="Cluster providers"
            className="mb-6 flex flex-wrap gap-2"
          >
            {PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                type="button"
                aria-pressed={selected === provider.id}
                aria-controls={`provider-${provider.id}`}
                onClick={() => setSelected(provider.id)}
                className={`min-h-11 rounded-md border px-4 py-2 text-sm ${FOCUS} ${selected === provider.id ? "border-neutral-300 bg-neutral-800 text-neutral-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-400 hover:text-neutral-200"}`}
              >
                {provider.name}
              </button>
            ))}
          </div>
        ) : null}
        <div aria-live="polite" aria-atomic="true" className="space-y-3">
          {PROVIDERS.map((provider) => (
            <details
              key={provider.id}
              id={`provider-${provider.id}`}
              open={selected === provider.id}
              hidden={interactive && selected !== provider.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6"
            >
              <summary
                hidden={interactive}
                className={`min-h-11 cursor-pointer font-display text-xl font-bold ${FOCUS}`}
              >
                <h3 className="inline">{provider.name}</h3>
              </summary>
              {interactive ? (
                <h3 className="font-display text-xl font-bold">
                  {provider.name}
                </h3>
              ) : null}
              <div className="mt-6 grid gap-8 md:grid-cols-2">
                <div className="min-w-0">
                  <h4 className="text-sm font-medium text-neutral-200">
                    How it signs in
                  </h4>
                  <p className="mt-3 break-words font-mono text-sm text-neutral-200">
                    {provider.credential}
                  </p>
                  <p className="mt-3 text-sm text-neutral-400">
                    {provider.signIn}
                  </p>
                  <h4 className="mt-6 text-sm font-medium text-neutral-200">
                    How exercised
                  </h4>
                  <p
                    className={`mt-3 inline-block rounded-md border px-2.5 py-1 font-mono text-xs ${provider.exercised === "Daily" ? "border-green-400/60 text-green-300" : provider.exercised === "Fixture verified" ? "border-neutral-500 text-neutral-200" : provider.exercised === "Least exercised" ? "border-amber-400/60 text-amber-300" : "border-dashed border-neutral-600 text-neutral-300"}`}
                  >
                    {provider.exercised}
                  </p>
                  <p className="mt-3 text-sm text-neutral-400">
                    {provider.evidence}
                  </p>
                </div>
                <div className="min-w-0">
                  <h4 className="text-sm font-medium text-neutral-200">
                    What Rubick reads there
                  </h4>
                  <p className="mt-3 text-sm text-neutral-400">
                    {provider.reads}
                  </p>
                  <LabelKeys labels={provider.labels} />
                </div>
              </div>
            </details>
          ))}
        </div>
        <details className="mt-6 rounded-xl border border-neutral-800 p-6">
          <summary
            className={`min-h-11 cursor-pointer text-sm text-neutral-300 ${FOCUS}`}
          >
            Shared node labels, with no cloud account
          </summary>
          <p className="mt-3 max-w-2xl text-sm text-neutral-400">
            Machine types, zones and regions come from these node labels when
            present. Pool and spot labels are read across providers, including
            Karpenter. Reading them needs access to the Kubernetes nodes, with
            no separate cloud account.
          </p>
          <LabelKeys labels={SHARED_LABELS} />
        </details>
      </Reveal>
      <p className="mt-6 text-sm text-neutral-400">
        <a
          href={LINKS.issues}
          className={`underline decoration-neutral-600 underline-offset-4 hover:text-neutral-200 ${FOCUS}`}
        >
          If something reads wrong on yours, that is worth an issue
        </a>
        .
      </p>
    </Section>
  );
}
