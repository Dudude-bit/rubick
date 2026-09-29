/**
 * What Flux's own kinds say about one object, reusing `fluxPicture`, the
 * same reader the page walks, handed just this one object. The cross-object
 * findings that need the rest of the cluster (a frozen source, an unused
 * one) are suppressed rather than guessed at: every source kind is marked
 * unread, so `fluxPicture` never asserts "no such source" or "nobody uses
 * this" about an object it was never shown.
 */

import { Layers } from "lucide-react";

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { iconSvg } from "@/lib/icon-svg";
import { refOf } from "@/lib/report-parts";
import type { ReportSection, ReportValue } from "@/lib/report";
import {
  fluxPicture,
  reconcilerState,
  revisionText,
  sourceState,
  type KindUnread,
} from "./model";

const GROUP = /\.toolkit\.fluxcd\.io$/;
const SOURCE_KINDS = [
  "GitRepository",
  "OCIRepository",
  "HelmRepository",
  "Bucket",
];
/** Forces every reconciler's source, and every source's users, to read as
 *  unknown rather than absent: this report never sees the rest of the cluster. */
const UNREAD: KindUnread[] = [
  ...SOURCE_KINDS.map((kind) => ({ kind, crd: "", reason: "" })),
  { kind: "HelmRelease", crd: "", reason: "" },
];

function fakeResource(object: {
  namespace: string | null;
  name: string;
  kind: string;
  spec: unknown;
  status: unknown;
}): CustomResourceInfo {
  return {
    name: object.name,
    namespace: object.namespace,
    uid: "",
    apiVersion: "toolkit.fluxcd.io/v1",
    kind: object.kind,
    spec: object.spec,
    status: object.status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

function reconcilerSection(
  object: {
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection {
  const fake = fakeResource(object);
  const picture =
    object.kind === "Kustomization"
      ? fluxPicture([fake], [], [], UNREAD)
      : fluxPicture([], [fake], [], UNREAD);
  const reconciler = picture.reconcilers[0]!;
  const state = reconcilerState(reconciler, t);

  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [{ text: state.text, role: state.tone }],
    },
  ];
  if (reconciler.sourceRef) {
    rows.push({
      label: t("share", "fluxSource"),
      values: [
        {
          text: `${reconciler.sourceRef.kind}/${reconciler.sourceRef.name}`,
          ref: refOf(reconciler.sourceRef),
        },
      ],
    });
  }
  rows.push({
    label: t("share", "fluxApplied"),
    values: [
      {
        text: revisionText(reconciler.applied, t),
        mono: reconciler.applied !== null,
      },
    ],
  });
  if (reconciler.interval) {
    rows.push({
      label: t("share", "fluxInterval"),
      values: [{ text: reconciler.interval, mono: true }],
    });
  }
  if (reconciler.message) {
    rows.push({
      label: t("share", "fluxMessage"),
      values: [
        {
          text: reconciler.message,
          role: reconciler.ready === false ? "err" : undefined,
        },
      ],
    });
  }

  return {
    id: `flux-${object.kind.toLowerCase()}`,
    title: object.kind,
    icon: iconSvg(Layers),
    body: { type: "facts", rows },
  };
}

function sourceSection(
  object: {
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection {
  const fake = fakeResource(object);
  const picture = fluxPicture(
    [],
    [],
    [{ kind: object.kind, objects: [fake] }],
    UNREAD
  );
  const source = picture.sources[0]!;
  const state = sourceState(source, t);

  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "status"),
      values: [{ text: state.text, role: state.tone }],
    },
  ];
  if (source.url)
    rows.push({ label: "URL", values: [{ text: source.url, mono: true }] });
  if (source.ref)
    rows.push({
      label: t("share", "fluxRef"),
      values: [{ text: source.ref, mono: true }],
    });
  if (source.interval) {
    rows.push({
      label: t("share", "fluxInterval"),
      values: [{ text: source.interval, mono: true }],
    });
  }
  if (source.artifact) {
    rows.push({
      label: t("share", "fluxArtifact"),
      values: [{ text: revisionText(source.artifact.revision, t), mono: true }],
    });
  }
  if (source.message) {
    rows.push({
      label: t("share", "fluxMessage"),
      values: [
        {
          text: source.message,
          role: source.ready === false ? "err" : undefined,
        },
      ],
    });
  }

  return {
    id: `flux-${object.kind.toLowerCase()}`,
    title: object.kind,
    icon: iconSvg(Layers),
    body: { type: "facts", rows },
  };
}

export function reportOf(
  object: {
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
    spec: unknown;
    status: unknown;
  },
  t: T
): ReportSection[] | null {
  if (!GROUP.test(object.group)) return null;
  if (object.kind === "Kustomization" || object.kind === "HelmRelease") {
    return [reconcilerSection(object, t)];
  }
  if (SOURCE_KINDS.includes(object.kind)) {
    return [sourceSection(object, t)];
  }
  return null;
}
