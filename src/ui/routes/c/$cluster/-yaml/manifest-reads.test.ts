import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  changesReplicaCount,
  deliveryOfManifest,
  liveReplicaMove,
  withheldCopiesIn,
  withheldKeysIn,
} from "./manifest-reads";
import { WITHHELD_MARKER } from "@/lib/withheld";

describe("the keys a manifest still withholds", () => {
  const corpus = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "src/contracts/withheld-value.json"),
      "utf8"
    )
  ) as {
    marker: string;
    cases: {
      name: string;
      manifest: string;
      keys: string[];
      copies: Record<string, string[]>;
    }[];
  };

  /**
   * The backend refuses a manifest holding its placeholder; the editor has to
   * name the same keys before Apply is offered, or the reader learns of the
   * refusal only after confirming. Fails when the two stop agreeing.
   */
  it("names the keys the backend would refuse the manifest for", () => {
    expect(WITHHELD_MARKER).toBe(corpus.marker);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(6);
    for (const { name, manifest, keys } of corpus.cases) {
      expect([...withheldKeysIn(manifest)].sort(), name).toEqual(
        [...keys].sort()
      );
    }
  });

  /**
   * The backend leaves a blanked record out of what Apply sends, and the
   * editor says which annotations those are. Fails when the two stop naming
   * the same annotations, or the keys blanked in each.
   */
  it("names the blanked records the backend leaves out of an apply", () => {
    const named = corpus.cases.filter(
      ({ copies }) => Object.keys(copies).length > 0
    );
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const { name, manifest, copies } of corpus.cases) {
      const found = Object.fromEntries(
        withheldCopiesIn(manifest).map(({ annotation, keys }) => [
          annotation,
          [...keys].sort(),
        ])
      );
      expect(found, name).toEqual(copies);
    }
  });
});

describe("the delivery question read out of the document itself", () => {
  it("takes the group from apiVersion, which no table has to know", () => {
    expect(
      deliveryOfManifest(
        "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: shop\n  namespace: argocd\n"
      )
    ).toMatchObject({ group: "argoproj.io", kind: "Application" });
    expect(
      deliveryOfManifest(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n"
      )
    ).toMatchObject({ group: "", namespace: null });
  });

  it("carries the labels and annotations the claim is written in", () => {
    const query = deliveryOfManifest(
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: api",
        "  namespace: shop",
        "  labels:",
        "    argocd.argoproj.io/instance: shop",
        "    replicas: 3",
        "  annotations:",
        "    note: hand-applied",
        "",
      ].join("\n")
    );
    expect(query?.labels).toEqual({ "argocd.argoproj.io/instance": "shop" });
    expect(query?.annotations).toEqual({ note: "hand-applied" });
  });

  it("asks nothing of a document it cannot read", () => {
    expect(deliveryOfManifest("")).toBe(null);
    expect(deliveryOfManifest("kind: Deployment\n")).toBe(null);
    expect(
      deliveryOfManifest("apiVersion: v1\nkind: Pod\nmetadata: {}\n")
    ).toBe(null);
    expect(deliveryOfManifest("this: [is: not: yaml\n")).toBe(null);
  });
});

describe("whether a save moves the replica count", () => {
  const doc = (replicas: number | null) =>
    [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: api",
      "spec:",
      ...(replicas === null ? [] : [`  replicas: ${replicas}`]),
      "  template:",
      "    spec: {}",
      "",
    ].join("\n");

  it("reads a replica count out of either document, or neither", () => {
    expect(changesReplicaCount(doc(3), doc(null))).toBe(true);
    expect(changesReplicaCount(doc(null), doc(null))).toBe(false);
    expect(changesReplicaCount(doc(3), doc(3) + "# a comment\n")).toBe(false);
    // A document that will not parse is about to fail on the API server, and
    // its message is better than anything guessed here.
    expect(changesReplicaCount(doc(3), "spec: [broken\n")).toBe(false);
  });
});

const deployment = (name: string, replicas: number) =>
  [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    "  namespace: shop",
    "spec:",
    `  replicas: ${replicas}`,
    "",
  ].join("\n");

const configMap = [
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: api-settings",
  "  namespace: shop",
  "data: {}",
  "",
].join("\n");

describe("whether a save moves the replica count, in a buffer of several documents", () => {
  /**
   * One parser call read one document and threw on a second, so a buffer
   * with an object added under `---` counted as unreadable and the
   * autoscaler warning went quiet — while the apply, which takes every
   * document, set the new count all the same.
   */
  it("reads the edited object out of a buffer with several documents", () => {
    const edited = `${deployment("api", 5)}---\n${configMap}`;
    expect(changesReplicaCount(deployment("api", 3), edited)).toBe(true);
    expect(
      changesReplicaCount(
        deployment("api", 3),
        `${configMap}---\n${deployment("api", 3)}`
      )
    ).toBe(false);
  });

  /**
   * The apply sends every copy of the object in turn, so the last one decides
   * the count. Reading only the first copy said nothing moved while the
   * second scaled the workload from 3 to 5 under the autoscaler.
   */
  it("reads every copy of the object in the buffer, not only the first", () => {
    const original = deployment("api", 3);
    expect(
      changesReplicaCount(original, `${original}---\n${deployment("api", 5)}`)
    ).toBe(true);
    expect(
      changesReplicaCount(original, `${deployment("api", 5)}---\n${original}`)
    ).toBe(true);
    expect(changesReplicaCount(original, `${original}---\n${original}`)).toBe(
      false
    );
  });

  /** Another Deployment's count is not this one's. */
  it("compares the object the editor opened, not the first one it finds", () => {
    const edited = `${deployment("worker", 9)}---\n${deployment("api", 3)}`;
    expect(changesReplicaCount(deployment("api", 3), edited)).toBe(false);
  });
});

describe("what applying does to the replica count the cluster holds now", () => {
  const answer = (
    says: "configured" | "created" | "refused" | "liveUnread",
    live: string | null,
    would: string | null
  ) => ({
    outcome: says === "configured" ? { says } : { says, said: "" },
    live,
    would,
  });
  const at3 = deployment("api", 3);

  /**
   * The buffer says 3 because the cluster did when it was read; an autoscaler
   * has since gone to 12 and the forced apply takes it back. Both buffers
   * agree, so only the dry run's current object shows it. Fails if the move
   * is missed, or is not told apart from a count the reader typed.
   */
  it("sees a count that moved on the cluster after the manifest was read", () => {
    expect(
      liveReplicaMove(at3, at3, [
        answer("configured", deployment("api", 12), at3),
      ])
    ).toEqual({ from: 12, to: 3, drifted: true });
    expect(
      liveReplicaMove(at3, deployment("api", 5), [
        answer("configured", at3, deployment("api", 5)),
      ])
    ).toEqual({ from: 3, to: 5, drifted: false });
  });

  /** The other half: a save that leaves the count alone must stay quiet, or the warning is on every save. */
  it("says nothing moves when the cluster holds the count being applied", () => {
    expect(
      liveReplicaMove(at3, at3, [answer("configured", at3, at3)])
    ).toBeNull();
  });

  /**
   * "Could not read what is there" is not "the count is the same": a refused
   * get, or a dry run nobody answered, leaves the question open while the
   * buffer still sets a number. Fails if either reads as nothing moving.
   */
  it("calls the move unknown when the current object was not shown", () => {
    expect(liveReplicaMove(at3, at3, [answer("liveUnread", null, at3)])).toBe(
      "unknown"
    );
    expect(liveReplicaMove(at3, at3, null)).toBe("unknown");
  });

  /** Unknown is only worth saying of a buffer that sets a count at all. */
  it("has nothing to be unsure of when the buffer sets no count", () => {
    expect(liveReplicaMove(configMap, configMap, null)).toBeNull();
  });

  /** An object that is not there has no count to reset, and a refused apply resets nothing. */
  it("does not take a missing or refused object for an unread one", () => {
    expect(
      liveReplicaMove(at3, at3, [answer("created", null, at3)])
    ).toBeNull();
    expect(
      liveReplicaMove(at3, at3, [
        answer("refused", deployment("api", 12), null),
      ])
    ).toBeNull();
  });

  /** Another Deployment in the buffer moving its own count is not this one's autoscaler's business. */
  it("reads the editor's own object out of the dry run", () => {
    expect(
      liveReplicaMove(at3, at3, [
        answer("configured", deployment("worker", 1), deployment("worker", 9)),
        answer("configured", at3, at3),
      ])
    ).toBeNull();
  });
});
