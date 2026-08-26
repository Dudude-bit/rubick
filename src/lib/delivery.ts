/**
 * What the app is allowed to say about an object's provenance, and when.
 *
 * ## The trap this file exists to avoid
 *
 * On a cluster Argo or Flux runs, **everything is managed.** A "managed" badge
 * would therefore sit on ninety-five per cent of rows, spending the same pixels
 * the app spends on `CrashLoopBackOff` to say nothing — and the genuinely
 * interesting object on such a cluster is the *un*managed one, so the naive
 * mark lands on precisely the wrong rows. It does not go on the kind glyph
 * either: that glyph is readable because it means one thing, and provenance is
 * a second dimension.
 *
 * So the facts are split by loudness, and this module is where the split is
 * decided rather than in four components that could drift apart:
 *
 * - **Where it comes from** is quiet and always — {@link deliveryMarks}, the
 *   glyph and name beside the status. "Where do I change this" is asked
 *   constantly and costs one small element.
 * - **What it means for you right now** is loud and only when true —
 *   {@link deliveryLine}, which returns `null` for the ordinary managed,
 *   in-sync, nothing-odd object and must, or the Overview grows a banner on
 *   every page of a GitOps cluster and the trap is back one storey up.
 * - **At the point of action** — {@link deliveryIntercept}. It does not block,
 *   it tells: scaling a managed object by hand is a legitimate thing to do in
 *   an incident and the app has no business refusing it. Its business is making
 *   sure nobody does it *believing it will stick*.
 * - **In a list** — {@link deliveryCell}, empty for the ordinary case, because
 *   a problem earns a mark and inventory does not.
 */

import type { T } from "@/i18n/useT";
import { load } from "js-yaml";

import type { Delivery, DeliveryQuery, DeliverySource } from "@/integrations";
import { formatAge } from "./utils";

/**
 * The API group each kind lives in, `""` for the core group.
 *
 * Here and not spelled out at seventeen call sites, because Flux's inventory
 * id is `namespace_name_group_kind` and a group written `"app"` at one call
 * site would not fail — it would quietly report a delivered object as
 * *labelled and disowned*, which is the loudest wrong thing this feature can
 * say.
 */
const API_GROUPS: Record<string, string> = {
  ConfigMap: "",
  CustomResourceDefinition: "apiextensions.k8s.io",
  CronJob: "batch",
  DaemonSet: "apps",
  Deployment: "apps",
  Ingress: "networking.k8s.io",
  Job: "batch",
  PersistentVolume: "",
  PersistentVolumeClaim: "",
  Pod: "",
  ReplicaSet: "apps",
  Secret: "",
  Service: "",
  StatefulSet: "apps",
  StorageClass: "storage.k8s.io",
};

/** A kind's group, or `null` for one this table does not name. */
export function apiGroupOf(kind: string): string | null {
  return API_GROUPS[kind] ?? null;
}

/**
 * One list item or detail object, as the delivery question needs it.
 *
 * The `group` cannot be guessed from the object — it is part of Flux's
 * inventory id and nothing on a `DeploymentInfo` says `apps`. Everything else
 * is on the object already, which is why this is a shape and not a fetch.
 */
export function deliveryOf(
  group: string,
  kind: string,
  object:
    | {
        name: string;
        namespace?: string | null;
        labels?: Record<string, string> | null;
        annotations?: Record<string, string> | null;
      }
    | null
    | undefined
): DeliveryQuery | null {
  if (!object) return null;
  return {
    group,
    kind,
    name: object.name,
    namespace: object.namespace ?? null,
    labels: object.labels ?? {},
    annotations: object.annotations ?? {},
  };
}

/**
 * The kinds whose *lists* get no Delivery column, because the cluster makes
 * them from something else that is delivered.
 *
 * A Pod comes from its controller and a ReplicaSet from its Deployment;
 * neither carries a delivery label, so the column would read `not delivered`
 * on every row of every cluster — which is the section-one trap with the
 * colours swapped. Their *detail* pages still ask, and simply say nothing,
 * because a Pod that somehow is delivered is worth knowing about and costs
 * nothing to check.
 */
const MADE_BY_THE_CLUSTER = new Set(["Pod", "ReplicaSet", "Endpoints"]);

/** What a list page passes to get the column, or `null` for no column. */
export function deliveryScopeOf(
  kind: string
): { group: string; kind: string } | null {
  const group = apiGroupOf(kind);
  if (group === null || MADE_BY_THE_CLUSTER.has(kind)) return null;
  return { group, kind };
}

/**
 * The same question, asked of a manifest rather than of a list row.
 *
 * The YAML editor has no typed object behind it — it has the document, which
 * states its own `apiVersion`, `kind` and `metadata`. Reading the query out of
 * the text is therefore both free and *better* than {@link API_GROUPS}: a
 * custom resource's group is in the document and will never be in that table,
 * so an Argo `Application` edited by hand gets the same answer a Deployment
 * does.
 *
 * Always the text the API server gave, never the buffer. Deleting the tracking
 * label from the editor does not change who owns the object, and asking the
 * question of the edited copy would let a reader talk the warning away by
 * typing.
 */
export function deliveryOfManifest(text: string): DeliveryQuery | null {
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const { apiVersion, kind } = doc;
  if (typeof apiVersion !== "string" || typeof kind !== "string") return null;
  const metadata = isRecord(doc.metadata) ? doc.metadata : {};
  const name = metadata.name;
  if (typeof name !== "string" || name === "") return null;

  const slash = apiVersion.indexOf("/");
  return {
    group: slash === -1 ? "" : apiVersion.slice(0, slash),
    kind,
    name,
    namespace:
      typeof metadata.namespace === "string" ? metadata.namespace : null,
    labels: stringsOf(metadata.labels),
    annotations: stringsOf(metadata.annotations),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the string-valued entries: a label with a number in it is not one. */
function stringsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** {@link deliveryOf} for a kind whose group {@link API_GROUPS} names. */
export function deliveryOfKind(
  kind: string,
  object: Parameters<typeof deliveryOf>[2]
): DeliveryQuery | null {
  const group = apiGroupOf(kind);
  return group === null ? null : deliveryOf(group, kind, object);
}

/** The confirmed sources, in the order the vendors were asked. */
export function delivered(deliveries: Delivery[]): DeliverySource[] {
  return deliveries.flatMap((entry) =>
    entry.state === "delivered" ? [entry.source] : []
  );
}

/** The claims nothing confirmed. */
export function claimedOnly(
  deliveries: Delivery[]
): Array<Extract<Delivery, { state: "claimed" }>> {
  return deliveries.flatMap((entry) =>
    entry.state === "claimed" ? [entry] : []
  );
}

export interface DeliveryMark {
  /** The vendor's registry id, which is how the surface finds its glyph. */
  vendorId: string;
  /** "Argo CD · shop", and " · out of sync" where there is trouble. */
  text: string;
  /** Where the reader goes to change it, or `null` for a claim with no owner. */
  to: string | null;
  tone: "faint" | "warn";
}

/**
 * The header mark: one per vendor that said anything, quiet and always.
 *
 * A claim nothing confirmed still gets a mark, and it is not dressed as
 * provenance — it reads `unconfirmed`, in the warn tone, because an object
 * wearing a delivery label that nothing honours is a fact worth seeing and is
 * not the same fact as being delivered.
 */
export function deliveryMarks(deliveries: Delivery[], t: T): DeliveryMark[] {
  return deliveries.map((entry) => {
    if (entry.state === "claimed") {
      return {
        vendorId: entry.vendorId,
        text: t("readings", "delUnconfirmedMark", {
          vendor: entry.vendor,
          claim: entry.claim,
        }),
        to: entry.owner?.to ?? null,
        tone: "warn" as const,
      };
    }
    const { source } = entry;
    return {
      vendorId: source.vendorId,
      text: [
        source.vendor,
        source.owner.name,
        source.warning &&
          t("readings", source.warning.key, source.warning.values),
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
      to: source.owner.to,
      tone: source.warning ? ("warn" as const) : ("faint" as const),
    };
  });
}

export interface DeliveryLine {
  tone: "info" | "warn";
  title: string;
  detail: string;
  /** Where the manifests are, as the vendor reported it. */
  where: {
    path: string | null;
    revision: string | null;
    repoUrl: string | null;
  } | null;
  /** The owner to open, for the line that has one obvious next step. */
  to: string | null;
}

/**
 * The one earned line above the Overview, or `null`.
 *
 * `null` is the answer for a managed, in-sync object whose delivery is not
 * going to fight you, and that is the majority of a healthy GitOps cluster.
 * The line appears when, and only when, it changes what you would do:
 *
 * - an edit here will be put back (`drift: "reverted"`);
 * - live differs from what was applied (`sync: "drifted"`);
 * - nothing is applying this right now, and will start again when somebody
 *   fixes it (`drift: "unmanaged"`);
 * - the label says delivered and nothing confirms it;
 * - two controllers both deliver it, and are undoing each other.
 */
/** "a and b", "a, b, and c" — the last join is a word, so it comes from the catalogue. */
function joinNames(names: string[], t: T): string {
  if (names.length <= 1) return names[0] ?? "";
  // Two names take no comma before the joining word; three or more do.
  if (names.length === 2) {
    return t("nav", "twoAnd", { a: names[0], b: names[1] });
  }
  return t("nav", "listAndLast", {
    list: names.slice(0, -1).join(", "),
    last: names[names.length - 1],
  });
}

export function deliveryLine(
  deliveries: Delivery[],
  t: T
): DeliveryLine | null {
  const sources = delivered(deliveries);
  const unconfirmed = claimedOnly(deliveries);

  if (sources.length === 0) {
    const claim = unconfirmed[0];
    if (!claim) return null;
    return {
      tone: "warn",
      title: claim.owner
        ? t("readings", "delLabelledNotListed", { claim: claim.claim })
        : t("readings", "delLabelledNoOwner", {
            claim: claim.claim,
            kind: claim.ownerKind,
          }),
      detail: claim.owner
        ? `The label is a claim anybody can write, and the ${claim.ownerKind} it names does not have this object in its inventory. Nothing is applying it, so an edit here stands — and nothing will put it back if it is deleted.`
        : `Nothing here is applying this object. A ${claim.ownerKind} that was deleted without pruning, or a manifest committed with the label already in it, both leave exactly this.`,
      where: null,
      to: claim.owner?.to ?? null,
    };
  }

  if (sources.length > 1) {
    const names = sources.map(
      (source) => `${source.vendor}'s ${source.owner.name}`
    );
    return {
      tone: "warn",
      title: t("readings", "delTwoDeliver", {
        // The joining word is a word: English puts "and" there, Russian puts
        // "и" with no comma before it.
        vendors: joinNames(
          sources.map((source) => source.vendor),
          t
        ),
      }),
      detail: t("readings", "delTwoDeliverDetail", {
        names: joinNames(names, t),
      }),
      where: null,
      to: sources[0].owner.to,
    };
  }

  const source = sources[0];
  const where = {
    path: source.path,
    revision: source.revision,
    repoUrl: source.repoUrl,
  };

  if (source.sync === "drifted") {
    const since = source.lastAppliedAt
      ? t("readings", "delSince", {
          name: source.owner.name,
          ago: formatAge(source.lastAppliedAt),
        })
      : "";
    return {
      tone: "warn",
      title: t("readings", "delDrifted", { since }),
      detail: t("readings", "delDriftedDetail", {
        vendor: source.vendor,
        note: source.note
          ? t("readings", source.note.key, source.note.values)
          : "",
      }).trim(),
      where,
      to: source.owner.to,
    };
  }

  if (source.drift === "unmanaged") {
    return {
      tone: "warn",
      title: t("readings", "delStopped"),
      detail: source.note
        ? t("readings", source.note.key, source.note.values)
        : t("readings", "delStoppedDetail", { name: source.owner.name }),
      where,
      to: source.owner.to,
    };
  }

  if (source.drift === "reverted") {
    return {
      tone: "info",
      title: t("readings", "delFromGit"),
      detail: source.note
        ? t("readings", source.note.key, source.note.values)
        : "",
      where,
      to: source.owner.to,
    };
  }

  // Delivered, in sync, and an edit here would be kept. Nothing to say: the
  // header mark already answers "where does this come from", and a banner
  // repeating it would be on every page of the cluster.
  return null;
}

export interface DeliveryCell {
  text: string;
  tone: "faint" | "warn";
}

/**
 * The `Delivery` column, which is empty for the ordinary case on purpose.
 *
 * `null` renders nothing at all. `not delivered` is faint rather than a
 * warning: on a cluster where most things are delivered it is worth knowing
 * and it is not a fault — it is how you find the thing somebody applied by
 * hand at three in the morning and never wrote down.
 */
export function deliveryCell(
  deliveries: Delivery[],
  t: T
): DeliveryCell | null {
  if (deliveries.length === 0)
    return { text: t("readings", "delNotDelivered"), tone: "faint" };

  const sources = delivered(deliveries);
  if (sources.length === 0)
    return { text: t("readings", "delLabelledNotListedShort"), tone: "warn" };
  if (sources.length > 1)
    return { text: t("readings", "delTwoControllers"), tone: "warn" };

  const source = sources[0];
  if (source.sync === "drifted") {
    return {
      text: source.lastAppliedAt
        ? t("readings", "delOutOfSyncAge", {
            ago: formatAge(source.lastAppliedAt),
          })
        : t("readings", "delOutOfSync"),
      tone: "warn",
    };
  }
  if (source.warning)
    return {
      text: t("readings", source.warning.key, source.warning.values),
      tone: "warn",
    };
  return null;
}

/** The list filter's three answers. `all` draws every row. */
export type DeliveryFilter = "all" | "notDelivered" | "trouble";

export function matchesDeliveryFilter(
  filter: DeliveryFilter,
  deliveries: Delivery[]
): boolean {
  if (filter === "all") return true;
  if (filter === "notDelivered") return deliveries.length === 0;
  // The filter reads the tone and never the words, so it asks in no
  // language rather than making every caller supply one.
  const noWords: T = () => "";
  const cell = deliveryCell(deliveries, noWords);
  return cell?.tone === "warn";
}

export interface DeliveryIntercept {
  title: string;
  /**
   * Who is doing it, in two words — "Argo CD".
   *
   * Only read where a dialog carries more than one warning: with two, the
   * reader has to be told *what* is undoing the change before being told what
   * happens, or the two paragraphs run together into one long complaint.
   */
  subject: string;
  /**
   * The clause that has to be read, in six words. The dialog it lands in
   * already has a title of its own — "Scale Deployment" — and burying the
   * consequence in the middle of a paragraph is how a warning becomes
   * decoration.
   */
  lead: string;
  /** What will happen to what you are about to do. */
  description: string;
  /** "Scale anyway". */
  confirmLabel: string;
  /** Where the change would actually have to be made. */
  where: {
    path: string | null;
    revision: string | null;
    repoUrl: string | null;
    to: string;
  } | null;
}

/**
 * What to say at the moment somebody presses Scale, Restart, Edit or Delete.
 *
 * `null` where there is nothing to warn about, and that includes every object
 * on a cluster with no delivery controller — the control behaves exactly as it
 * did before this existed. It never disables anything: the failure this
 * prevents is not the edit, it is the belief that the edit is permanent.
 */
export function deliveryIntercept(
  deliveries: Delivery[],
  verb: string,
  t: T
): DeliveryIntercept | null {
  const sources = delivered(deliveries).filter(
    (source) => source.drift === "reverted"
  );
  if (sources.length === 0) return null;
  const source = sources[0];

  return {
    title: t("readings", "delVendorWillUndo", { verb, vendor: source.vendor }),
    subject: source.vendor,
    lead: t("readings", "delVendorWillUndoDetail", { vendor: source.vendor }),
    description: `${
      source.note ? t("readings", source.note.key, source.note.values) : ""
    } ${
      source.path
        ? t("readings", "delEditManifests", { path: source.path })
        : t("readings", "delEditWhatApplies", { name: source.owner.name })
    }`.trim(),
    confirmLabel: t("action", "verbAnyway", { verb }),
    where: {
      path: source.path,
      revision: source.revision,
      repoUrl: source.repoUrl,
      to: source.owner.to,
    },
  };
}

/**
 * What to say at the moment somebody applies an edited manifest.
 *
 * The most powerful write in the app, and until now the only one that said
 * nothing — which, once every other control warns, reads as a claim that this
 * one is safe. It is {@link deliveryIntercept} with one case added, and the
 * added case is the reason it is a function of its own.
 *
 * ## Why a stale claim earns a sentence here and not on Scale
 *
 * A disowned label changes nothing about what *happens* — the edit stands
 * either way — so Scale and Delete rightly stay quiet about it. What it
 * changes is what the reader is looking at: the document open in front of
 * them carries a delivery label, and a label is the app's own evidence for
 * "the permanent change belongs in git". Here that evidence is in the buffer,
 * a line above the field being edited, and it is wrong. So the sentence is not
 * a warning about a revert that will not come — promising one would be a lie
 * the reader can check — it is a correction: this stands, and it is not in
 * that repository.
 *
 * Which is also why it confirms with a plain "Apply". "Apply anyway" is the
 * word for overriding a consequence, and there is no consequence to override.
 */
export function deliveryApplyIntercept(
  deliveries: Delivery[],
  t: T
): DeliveryIntercept | null {
  const reverting = deliveryIntercept(deliveries, "Apply", t);
  if (reverting) return reverting;

  const claim = claimedOnly(deliveries)[0];
  if (!claim || delivered(deliveries).length > 0) return null;

  const disowned = claim.owner !== null;
  return {
    title: t("readings", "delApplyLabelNotHonoured"),
    subject: claim.vendor,
    lead: t("readings", "delApplyLabelDetail"),
    // The vendor's name is data, so the sentence is built to need no article
    // in front of it — "a Argo CD label" is the shape that comes out otherwise.
    description: disowned
      ? `It carries a delivery label from ${claim.vendor} naming ${claim.claim}, and that ${claim.ownerKind}'s inventory does not list it. So this apply stands and nothing will put it back — but the permanent change does not belong in ${claim.claim}'s repository either, because ${claim.claim} is not applying this.`
      : `It carries a delivery label from ${claim.vendor} naming ${claim.claim}, and no ${claim.ownerKind} by that name exists. So this apply stands and nothing will put it back — and there is no repository behind the label to make the change in.`,
    confirmLabel: "Apply",
    // No link, deliberately. "Open what delivers it" would send the reader to
    // an owner that does not deliver this, which is the misunderstanding the
    // paragraph exists to correct; the header mark beside the title still
    // routes there for anyone who wants to see the disowning for themselves.
    where: null,
  };
}
