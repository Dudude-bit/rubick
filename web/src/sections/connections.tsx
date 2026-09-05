import { Reveal } from "../components/motion/reveal";
import {
  CORE_KINDS,
  keyOf,
  Peek,
  type Ref,
  type Subject,
} from "../components/peek";
import { Section } from "../components/section";

const POD: Ref = { kind: "Pod", name: "checkout", note: "" };

// Everything below was read from the fixture on a k3d cluster, not typed in.
const SUBJECTS: Subject[] = [
  {
    kind: "Pod",
    name: "checkout",
    facts: "rubick-lies · 1 container · 3 restarts and counting",
    status: { label: "CrashLoopBackOff", tone: "bad" },
    chain: [
      { kind: "Ingress", name: "shop", note: "/checkout" },
      { kind: "Service", name: "checkout", note: "0 ready", tone: "bad" },
      { kind: "Pod", name: "checkout", note: "never Ready", tone: "bad" },
    ],
    chainNote:
      "A Gateway listener and an HTTPRoute draw the same chain from the listener down. The fixture uses an Ingress so it needs no CRDs.",
    groups: [
      {
        title: "Needs to run",
        note: "if one of these is missing the pod does not start",
        rows: [
          {
            kind: "ConfigMap",
            name: "checkout-config",
            note: "every key becomes an environment variable",
          },
          {
            kind: "Secret",
            name: "checkout-tls",
            note: "mounted at /etc/tls, read-only",
          },
          {
            kind: "PersistentVolumeClaim",
            name: "checkout-data",
            note: "mounted at /data · Bound, 1Gi",
          },
        ],
      },
      {
        title: "Runs on",
        rows: [
          {
            kind: "Node",
            name: "k3d-k8s-gui-dev-server-0",
            note: "the k3d node the fixture was verified on",
          },
        ],
      },
      {
        title: "Not looked at",
        note: "named, so a group that is absent is never read as a group that is empty",
        rows: [],
        empty: {
          label: "the kinds this page did not read",
          note: "listed by name, with the reason, instead of left as a gap",
        },
      },
    ],
  },
  {
    kind: "ConfigMap",
    name: "checkout-config",
    facts: "2 keys · CHECKOUT_REGION, CHECKOUT_CURRENCY",
    groups: [
      {
        title: "Used by",
        note: "what names this in its pod spec",
        rows: [
          {
            ...POD,
            note: "envFrom, every key becomes an environment variable",
          },
        ],
      },
    ],
  },
  {
    kind: "Secret",
    name: "checkout-tls",
    facts: "Opaque · 2 keys, tls.crt and tls.key · values never shown",
    groups: [
      {
        title: "Used by",
        note: "what names this in its pod spec",
        rows: [{ ...POD, note: "mounted at /etc/tls, read-only" }],
      },
    ],
  },
  {
    kind: "PersistentVolumeClaim",
    name: "checkout-data",
    facts: "Bound · 1Gi · ReadWriteOnce",
    groups: [
      {
        title: "Bound to",
        rows: [
          {
            kind: "PersistentVolume",
            name: "pvc-8d1e2f2f-8df4-47d1-94c2-50174980961d",
            note: "provisioned on claim",
          },
          {
            kind: "StorageClass",
            name: "local-path",
            note: "the default class on k3d",
          },
        ],
      },
      {
        title: "Used by",
        note: "what names this in its pod spec",
        rows: [{ ...POD, note: "mounted at /data" }],
      },
    ],
  },
  {
    kind: "Node",
    name: "k3d-k8s-gui-dev-server-0",
    facts: "v1.35.5+k3s1 · K3s · containerd 2.2.3 · amd64",
    groups: [
      {
        title: "What runs here",
        rows: [
          { ...POD, note: "0/1 ready", tone: "bad" },
          {
            kind: "Deployment",
            name: "api",
            note: "3 pods, all ready",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Ingress",
    name: "shop",
    facts: "host shop.example.test · 4 paths · no TLS",
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          { kind: "Service", name: "api-ok", note: "/ · 3 ready", tone: "ok" },
          {
            kind: "Service",
            name: "api",
            note: "/legacy · published with no port",
            tone: "bad",
          },
          {
            kind: "Service",
            name: "checkout",
            note: "/checkout · 0 ready",
            tone: "bad",
          },
          {
            kind: "Service",
            name: "api-v2",
            note: "/api · no Service by that name",
            tone: "bad",
          },
        ],
      },
    ],
  },
  {
    kind: "Service",
    name: "checkout",
    facts: "ClusterIP 10.43.39.231 · 80 to 8080",
    status: { label: "running, none ready", tone: "bad" },
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          {
            ...POD,
            note: "matched, never Ready, never published",
            tone: "bad",
          },
        ],
      },
      {
        title: "Used by",
        rows: [{ kind: "Ingress", name: "shop", note: "/checkout" }],
      },
    ],
  },
  {
    kind: "Service",
    name: "api-ok",
    facts: "ClusterIP · 80 to http · 3 endpoints on port 80",
    status: { label: "3 ready", tone: "ok" },
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          {
            kind: "Deployment",
            name: "api",
            note: "3 pods, all published",
            tone: "ok",
          },
        ],
      },
      {
        title: "Used by",
        rows: [{ kind: "Ingress", name: "shop", note: "/" }],
      },
    ],
  },
  {
    kind: "Service",
    name: "api",
    facts: "ClusterIP · 80 to htp · addresses published with no port",
    status: { label: "no port", tone: "bad" },
    groups: [
      {
        title: "What answers here",
        note: "what made the pods behind this address",
        rows: [
          {
            kind: "Deployment",
            name: "api",
            note: "3 pods matched, htp matches no container",
            tone: "bad",
          },
        ],
      },
      {
        title: "Used by",
        rows: [{ kind: "Ingress", name: "shop", note: "/legacy" }],
      },
    ],
  },
  {
    kind: "Deployment",
    name: "api",
    facts: "3/3 ready · RollingUpdate · nginx:1.27-alpine",
    status: { label: "3 of 3 ready", tone: "ok" },
    chain: [
      { kind: "Ingress", name: "shop", note: "/" },
      { kind: "Service", name: "api-ok", note: "3 ready", tone: "ok" },
      { kind: "Deployment", name: "api", note: "3 pods", tone: "ok" },
    ],
    chainNote:
      "The same pods sit behind Service api on /legacy, which publishes no port; that path stops one step short of them.",
    groups: [
      {
        title: "Made by, and makes",
        rows: [
          {
            kind: "ReplicaSet",
            name: "api-7bbffd88b6",
            note: "the current revision, 3 pods",
            tone: "ok",
          },
        ],
      },
      {
        title: "Runs on",
        rows: [
          {
            kind: "Node",
            name: "k3d-k8s-gui-dev-server-0",
            note: "all three pods",
          },
        ],
      },
      {
        title: "Not looked at",
        note: "named, so a group that is absent is never read as a group that is empty",
        rows: [],
        empty: {
          label: "the kinds this page did not read",
          note: "listed by name, with the reason, instead of left as a gap",
        },
      },
    ],
  },
  {
    kind: "ReplicaSet",
    name: "api-7bbffd88b6",
    facts: "desired 3 · ready 3 · the current revision of api",
    status: { label: "3 of 3 ready", tone: "ok" },
    groups: [
      {
        title: "Made by, and makes",
        rows: [
          { kind: "Deployment", name: "api", note: "made by" },
          {
            kind: "Pod",
            name: "api-7bbffd88b6-5dndb",
            note: "10.42.0.36 · ready",
            tone: "ok",
          },
          {
            kind: "Pod",
            name: "api-7bbffd88b6-qnxdk",
            note: "10.42.0.37 · ready",
            tone: "ok",
          },
          {
            kind: "Pod",
            name: "api-7bbffd88b6-rmkkg",
            note: "10.42.0.35 · ready",
            tone: "ok",
          },
        ],
      },
    ],
  },
  {
    kind: "Pod",
    name: "api-7bbffd88b6-5dndb",
    facts: "nginx:1.27-alpine · 10.42.0.36 · port http 80",
    status: { label: "Running, 1/1 ready", tone: "ok" },
    groups: [
      {
        title: "Made by, and makes",
        rows: [{ kind: "ReplicaSet", name: "api-7bbffd88b6", note: "made by" }],
      },
      {
        title: "Runs on",
        rows: [{ kind: "Node", name: "k3d-k8s-gui-dev-server-0", note: "" }],
      },
    ],
  },
  {
    kind: "Pod",
    name: "api-7bbffd88b6-qnxdk",
    facts: "nginx:1.27-alpine · 10.42.0.37 · port http 80",
    status: { label: "Running, 1/1 ready", tone: "ok" },
    groups: [
      {
        title: "Made by, and makes",
        rows: [{ kind: "ReplicaSet", name: "api-7bbffd88b6", note: "made by" }],
      },
      {
        title: "Runs on",
        rows: [{ kind: "Node", name: "k3d-k8s-gui-dev-server-0", note: "" }],
      },
    ],
  },
  {
    kind: "Pod",
    name: "api-7bbffd88b6-rmkkg",
    facts: "nginx:1.27-alpine · 10.42.0.35 · port http 80",
    status: { label: "Running, 1/1 ready", tone: "ok" },
    groups: [
      {
        title: "Made by, and makes",
        rows: [{ kind: "ReplicaSet", name: "api-7bbffd88b6", note: "made by" }],
      },
      {
        title: "Runs on",
        rows: [{ kind: "Node", name: "k3d-k8s-gui-dev-server-0", note: "" }],
      },
    ],
  },
  {
    kind: "PersistentVolume",
    name: "pvc-8d1e2f2f-8df4-47d1-94c2-50174980961d",
    facts: "1Gi · ReadWriteOnce · Bound · reclaim Delete",
    groups: [
      {
        title: "Bound to",
        rows: [
          {
            kind: "PersistentVolumeClaim",
            name: "checkout-data",
            note: "the claim it was provisioned for",
          },
          { kind: "StorageClass", name: "local-path", note: "" },
        ],
      },
    ],
  },
  {
    kind: "StorageClass",
    name: "local-path",
    facts:
      "rancher.io/local-path · WaitForFirstConsumer · reclaim Delete · the default class",
    groups: [
      {
        title: "Used by",
        note: "the claims that name this class",
        rows: [
          {
            kind: "PersistentVolumeClaim",
            name: "checkout-data",
            note: "Bound, 1Gi",
          },
        ],
      },
    ],
  },
  {
    kind: "Service",
    name: "api-v2",
    facts:
      "No Service named api-v2 in this namespace. There is nothing to open; the Ingress rule is the only object that mentions it.",
    missing: true,
    status: { label: "does not exist", tone: "bad" },
    groups: [
      {
        title: "Used by",
        rows: [
          {
            kind: "Ingress",
            name: "shop",
            note: "/api, pointing at nothing",
            tone: "bad",
          },
        ],
      },
    ],
  },
];

const ROOT = keyOf(POD);

export function Connections() {
  return (
    <Section eyebrow="Connections">
      <Reveal>
        <h2 className="max-w-3xl font-display text-3xl font-bold tracking-tight md:text-5xl">
          One page, everything it touches.
        </h2>
        <p className="mt-6 max-w-2xl text-neutral-400">
          Open a pod and its neighbourhood is already there: the Ingress and
          Service in front of it, the ConfigMap it reads, the Secret it mounts,
          the volume it claims, the node it landed on, and by name the kinds
          nobody asked about. Every neighbour is a page of its own, one click
          away, with its own neighbours. This is the checkout pod from the
          fixture, as read on a k3d cluster. Click through it.
        </p>
      </Reveal>
      <Peek
        subjects={SUBJECTS}
        kinds={CORE_KINDS}
        root={ROOT}
        className="mt-12 max-w-3xl"
      />
      <p className="mt-6 max-w-2xl font-mono text-sm text-neutral-400">
        Every object the fixture creates, and the one it only mentions, each
        drawn in the groups its own Connections tab uses. What the tab does not
        show is not drawn here either.
      </p>
    </Section>
  );
}
