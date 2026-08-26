/**
 * What Argo CD and Flux genuinely share, and deliberately nothing more.
 *
 * The temptation with two delivery vendors is a "GitOps" model both pages
 * are drawn from, and it is the wrong move: Argo puts source and destination
 * in **one** object, Flux **splits** them — a `GitRepository` fetches, a
 * `Kustomization` applies, and several appliers share one source. Flattening
 * that into Argo's shape would hide the most common Flux failure, which is a
 * source that stopped fetching while every applier below it keeps reporting
 * the last revision it managed to apply.
 *
 * So the shape is not shared. What is shared is the handful of facts that are
 * literally the same fact: a git remote, a commit, and where on the web those
 * two resolve to. Both vendors also express health as `status.conditions` and
 * both state ages in ISO timestamps — the first is {@link conditionOf} in
 * `kit.ts` because every operator does it, and the second is `formatAge`,
 * which the whole app already has.
 */

import type { en } from "@/i18n/catalogue";

/** The object that delivers something, and where it is in this app. */
export interface DeliveryOwner {
  kind: string;
  name: string;
  namespace: string;
  to: string;
}

/**
 * One object, in as much detail as deciding its provenance takes.
 *
 * Labels and annotations and nothing else, because that is the whole cost
 * story: both vendors stamp their claim onto the object itself, so every list
 * this app already draws is holding the answer before anybody asks. A query
 * shape that needed a live read per object would make this a detail-page
 * feature and quietly kill the column.
 */
export interface DeliveryQuery {
  /** The API group, or `""` for core — Flux spells its inventory ids with it. */
  group: string;
  kind: string;
  name: string;
  namespace: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/**
 * Who applied an object, from which commit, and whether a hand edit here
 * survives.
 *
 * The answer to the question that stops people mid-task — *can I touch this,
 * or will my change be undone* — and the one shape both vendors genuinely
 * produce, which is why it is here rather than twice in two folders. Argo
 * reaches it through an `Application`, Flux through a `Kustomization` or a
 * `HelmRelease`, and the reader asking does not care which.
 */
export interface DeliverySource {
  /** Named out loud, because the surface that uses this says it out loud. */
  vendor: string;
  /**
   * The registry id, so a surface can find the vendor's own glyph without
   * naming the vendor. Argo's mark and Flux's are different shapes because
   * they are different products, and handing a component across the seam
   * instead would let a vendor decide how the mark is drawn.
   */
  vendorId: string;
  owner: DeliveryOwner;
  /** What is running here, as the owner reports it. */
  revision: string | null;
  repoUrl: string | null;
  /** The directory in the repository the manifests were read from. */
  path: string | null;
  /**
   * What happens to an edit made here.
   *
   * `reverted` is the dangerous one and the reason the line exists.
   * `unmanaged` means the owner is not currently applying anything — it is
   * suspended, or its source is failing — which is a *different* answer to
   * "nothing will revert this", because it will start reverting again the
   * moment somebody fixes it.
   */
  drift: "reverted" | "kept" | "unmanaged";
  /**
   * Whether *this object* differs from what the owner applied.
   *
   * `null` is not a quiet way of saying `synced`, and no surface may draw it
   * as one. Argo compares every object it owns and publishes the verdict in
   * `Application.status.resources`; **Flux publishes no per-object drift at
   * all** — it re-applies its own fields on a timer and corrects silently, so
   * there is no moment at which it records that something differed. `null` is
   * "nobody here knows", and the honest thing to render for it is nothing,
   * with the reason available rather than an implied tick.
   */
  sync: "synced" | "drifted" | null;
  /**
   * When the owner last successfully applied — the nearest thing either
   * vendor publishes to "and it has differed since".
   *
   * Not a drift timestamp, and never to be worded as one: Argo records when
   * it last synced, not when the cluster first stopped matching.
   */
  lastAppliedAt: string | null;
  /**
   * The owner's own trouble, in one word, for the mark that sits beside the
   * name. Argo's is `out of sync`; Flux's is `not reconciling`, because those
   * are different failures and the vendors have different vocabularies for
   * them. `null` where the delivery is doing exactly what it says.
   */
  warning: Saying | null;
  /** Why, where the answer is not obvious from {@link drift} alone. */
  note: Saying | null;
}

/**
 * A line the app will say, named rather than written.
 *
 * These are produced inside a query, where the reader's language is not in
 * scope and would be frozen into the cached answer if it were — switch to
 * Russian and the delivery mark would keep its English until something else
 * caused a refetch. A key survives that; a sentence does not.
 */
export interface Saying {
  key: keyof (typeof en)["readings"];
  values?: Record<string, string | number>;
}

/**
 * What the app is willing to say about where an object came from.
 *
 * The union exists because **the label is a claim and anybody can write one.**
 * A manifest committed with `argocd.argoproj.io/instance` already in it, a
 * copy-pasted YAML, an Application deleted while its objects were left behind,
 * a Kustomization pruned with `prune: false` — every one of those produces an
 * object that says it is delivered and is not. Collapsing that into `null`
 * would throw away a fact worth having (somebody meant this to be managed and
 * it is not), and collapsing it into {@link DeliverySource} would assert a
 * revision and a revert behaviour that nothing is actually enforcing.
 *
 * So there are three answers, and `null` — no claim at all — is the fourth.
 */
export type Delivery =
  /** The owner names the object back in its own inventory. */
  | { state: "delivered"; source: DeliverySource }
  /**
   * The object carries the label and the owner it names does not list it —
   * or does not exist. `owner` is `null` for the second case, which is a
   * different sentence: a name nobody answers to, rather than an owner that
   * disowns it.
   */
  | {
      state: "claimed";
      vendor: string;
      vendorId: string;
      /** The owner's name as the object itself spells it. */
      claim: string;
      ownerKind: string;
      owner: DeliveryOwner | null;
    };

/** The key both the batch call and its callers index an object by. */
export function deliveryKey(object: {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
}): string {
  return [object.group, object.kind, object.namespace ?? "", object.name].join(
    "/"
  );
}

/** Where a repository or a commit can be read on the web. */
export interface GitLink {
  url: string;
  /** Named before the reader leaves, so they know the site: "GitHub". */
  site: string;
}

const GITHUB = "GitHub";
const GITLAB = "GitLab";

/**
 * How short a commit is written. Seven is what both hosts echo back and what
 * every `git log --oneline` in the reader's terminal already shows.
 */
const SHORT = 7;

/** 7 to 40 hex characters, which is a commit and not a branch called `beef`. */
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * A revision as a reader wants to see it.
 *
 * A commit is cut to seven; a branch, a tag or a chart version is left exactly
 * as it was written, because shortening `6.5.4` or `release-1.2` would be
 * mangling a name rather than abbreviating a hash.
 */
export function shortRevision(revision: string): string {
  return SHA.test(revision) && revision.length > SHORT
    ? revision.slice(0, SHORT)
    : revision;
}

/**
 * The web address of a git remote, and only where it falls out of the remote
 * mechanically.
 *
 * The same judgement `registryLink` settled for image registries, applied to
 * the other kind of address this app holds. An `https://` GitHub or GitLab
 * remote resolves to a page with no guessing; an `ssh://` or `git@host:path`
 * remote names a protocol with no website behind it, a self-hosted Gitea or
 * Bitbucket has a URL shape this app would be inventing, and a remote
 * carrying credentials must never be handed to a browser at all. Those get
 * nothing, because a link that lands on a 404 or a login wall makes the
 * reader doubt the app rather than the link.
 */
export function gitRepoLink(repoUrl: string): GitLink | null {
  const parsed = readRemote(repoUrl);
  if (!parsed) return null;
  return { url: `${parsed.base}/${parsed.path}`, site: parsed.site };
}

/**
 * The page for one revision of a remote.
 *
 * A commit gets the commit page; a branch or tag gets the tree at that ref,
 * which both hosts serve and which is what "the revision this is tracking"
 * means when it is not pinned. A revision this cannot classify gets the
 * repository, never a guessed path.
 */
export function gitRevisionLink(
  repoUrl: string,
  revision: string | null
): GitLink | null {
  const parsed = readRemote(repoUrl);
  if (!parsed) return null;
  const base = `${parsed.base}/${parsed.path}`;
  if (!revision) return { url: base, site: parsed.site };

  const infix = parsed.site === GITLAB ? "/-" : "";
  if (SHA.test(revision)) {
    return { url: `${base}${infix}/commit/${revision}`, site: parsed.site };
  }
  // A ref may contain slashes — `release/1.2` — and each segment is a path
  // segment on both hosts, so the separators survive encoding.
  if (/^[\w./-]+$/.test(revision) && !revision.includes("..")) {
    return {
      url: `${base}${infix}/tree/${encodePath(revision)}`,
      site: parsed.site,
    };
  }
  return { url: base, site: parsed.site };
}

interface Remote {
  base: string;
  path: string;
  site: string;
}

function readRemote(repoUrl: string): Remote | null {
  let url: URL;
  try {
    url = new URL(repoUrl.trim());
  } catch {
    // `git@github.com:acme/infra.git` is not a URL at all, and neither is a
    // relative path — which is what a Flux `GitRepository` in a monorepo and
    // an Argo source of type `helm` can both hold.
    return null;
  }
  if (url.protocol !== "https:") return null;
  // A remote with a username or a token in it is a secret, and the browser
  // would put it in history and in the address bar.
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;

  const site =
    url.hostname === "github.com"
      ? GITHUB
      : url.hostname === "gitlab.com"
        ? GITLAB
        : null;
  if (!site) return null;

  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter((part) => part !== "");
  // GitHub is exactly owner/repo; GitLab nests groups arbitrarily deep.
  if (parts.length < 2) return null;
  if (site === GITHUB && parts.length !== 2) return null;
  if (!parts.every((part) => /^[\w.-]+$/.test(part))) return null;

  return {
    base: `https://${url.hostname}`,
    path: encodePath(parts.join("/")),
    site,
  };
}

const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");
