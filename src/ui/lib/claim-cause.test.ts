import { describe, expect, it } from "vite-plus/test";

import type {
  EventInfo,
  PersistentVolumeClaimInfo,
  PersistentVolumeInfo,
  StorageClassInfo,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  CLAIM_GRACE_MS,
  causeRole,
  claimCause,
  claimCauseText,
  claimRole,
  claimWarning,
  type ClassesRead,
  type VolumesRead,
} from "./claim-cause";

const t: T = (section, key, values) => translate("en", section, key, values);
const NOW = Date.parse("2026-10-15T12:00:00Z");

function claim(
  over: Partial<PersistentVolumeClaimInfo> = {}
): PersistentVolumeClaimInfo {
  return {
    uid: "u1",
    name: "orphan-claim",
    namespace: "cause-demo",
    status: "Pending",
    volume: null,
    capacity: null,
    accessModes: ["ReadWriteOnce"],
    storageClass: null,
    labels: {},
    annotations: {},
    createdAt: new Date(NOW - 2 * 86_400_000).toISOString(),
    ...over,
  };
}

function volume(
  name: string,
  over: Partial<PersistentVolumeInfo> = {}
): PersistentVolumeInfo {
  return {
    name,
    uid: name,
    capacity: "1Gi",
    accessModes: ["RWO"],
    reclaimPolicy: "Retain",
    status: "Available",
    claim: null,
    storageClass: "local-path",
    reason: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ...over,
  };
}

function cls(
  name: string,
  over: Partial<StorageClassInfo> = {}
): StorageClassInfo {
  return {
    name,
    uid: name,
    provisioner: "ebs.csi.aws.com",
    reclaimPolicy: "Delete",
    volumeBindingMode: "Immediate",
    allowVolumeExpansion: false,
    isDefault: false,
    parameters: {},
    labels: {},
    annotations: {},
    createdAt: null,
    ...over,
  };
}

const standard = cls("standard", { isDefault: true });

const read = (classes: ClassesRead, volumes: VolumesRead = []) => ({
  classes,
  volumes,
});

describe("why a claim is Pending", () => {
  /**
   * Live, orphan-claim named StorageClass fast-ssd-missing and sat a blue
   * Pending for two days on its list, page and peek. Fails if a class the
   * cluster lacks, or a missing default, is not said as such and in red.
   */
  it("names the class the cluster lacks, and says when there is no default", () => {
    const missing = claimCause(
      claim({ storageClass: "fast-ssd-missing" }),
      read([standard])
    );
    expect(missing).toEqual({ says: "classMissing", name: "fast-ssd-missing" });
    expect(claimCauseText(missing!, t)).toBe(
      "StorageClass fast-ssd-missing does not exist, so nothing will provision a volume for it"
    );
    expect(causeRole(claim(), missing!, NOW)).toBe("err");
    expect(claimCause(claim(), read([cls("manual")]))).toEqual({
      says: "noDefaultClass",
    });
  });

  /**
   * Classes that could not be read look exactly like a cluster with none,
   * which would make every claim's class "missing". Fails if an unread read
   * names a cause other than not knowing, or a read still under way names
   * any.
   */
  it("says the classes could not be read rather than that the class is missing", () => {
    const named = claim({ storageClass: "standard" });
    expect(claimCause(named, read("unread"))).toEqual({ says: "classUnread" });
    expect(claimCause(named, read("reading"))).toBeNull();
    expect(causeRole(named, { says: "classUnread" }, NOW)).toBe("warn");
  });

  /** Fails if a claim whose class binds on first consumer reads as a fault however long it has waited. */
  it("draws a claim that waits for its pod by design as a wait", () => {
    const waits = claimCause(
      claim({ storageClass: "local-path" }),
      read([cls("local-path", { volumeBindingMode: "WaitForFirstConsumer" })])
    );
    expect(waits).toEqual({ says: "waitsForPod", name: "local-path" });
    expect(causeRole(claim(), waits!, NOW)).toBe("pending");
  });

  /** Fails if a claim the default class should provision stops naming the provisioner that has not, or one that never will. */
  it("names the provisioner that has not made a volume, and a class that makes none", () => {
    expect(claimCause(claim(), read([standard]))).toEqual({
      says: "unprovisioned",
      name: "standard",
      provisioner: "ebs.csi.aws.com",
    });
    expect(
      claimCause(
        claim({ storageClass: "manual" }),
        read([cls("manual", { provisioner: "kubernetes.io/no-provisioner" })])
      )
    ).toEqual({ says: "noProvisioner", name: "manual" });
  });

  /**
   * `storageClassName: ""` asks for a volume made by hand and is never
   * provisioned; a claim naming no class takes the default. They travelled
   * as the same empty string, so a claim asking for no class beside a
   * WaitForFirstConsumer default read as a wait by design. Fails if the two
   * are taken for each other.
   */
  it("tells a claim that asks for no class from one that takes the default", () => {
    const local = cls("local-path", {
      isDefault: true,
      volumeBindingMode: "WaitForFirstConsumer",
    });
    expect(claimCause(claim({ storageClass: "" }), read([local]))).toEqual({
      says: "staticOnly",
    });
    expect(claimCause(claim({ storageClass: null }), read([local]))).toEqual({
      says: "waitsForPod",
      name: "local-path",
    });
    expect(causeRole(claim(), { says: "staticOnly" }, NOW)).toBe("warn");
  });

  /** A claim that names its volume is never provisioned for; fails if its class is blamed, or if it waits on the classes being read. */
  it("says a claim that asks for a volume waits for that volume", () => {
    const asks = claim({ volume: "pv-orders", storageClass: "gone" });
    const there = [volume("pv-orders")];
    expect(claimCause(asks, read("reading", there))).toEqual({
      says: "namesVolume",
      volume: "pv-orders",
    });
    expect(claimCause(asks, read([], there))).toEqual({
      says: "namesVolume",
      volume: "pv-orders",
    });
  });

  /** Fails if a claim no longer Pending is given a cause, or loses its phase's colour. */
  it("leaves a claim that is not Pending to its phase", () => {
    expect(claimCause(claim({ status: "Bound" }), read([]))).toBeNull();
    expect(claimRole(claim({ status: "Lost" }), null, NOW)).toBe("err");
    expect(claimRole(claim({ status: "Bound" }), null, NOW)).toBe("ok");
  });
});

describe("why a claim that names its volume has not bound to it", () => {
  const asks = claim({
    name: "asks-for-volume",
    volume: "pv-that-is-not-there",
  });

  /**
   * Live, asks-for-volume named pv-that-is-not-there, which no one made, and
   * read "which has not bound to it" with no event to say more: the volume
   * controller writes none for a volume it cannot find. Fails if a volume
   * the read does not hold is not said to be missing, and in red.
   */
  it("says the volume does not exist where the read holds no volume by that name", () => {
    const missing = claimCause(asks, read([], [volume("pv-demo")]));
    expect(missing).toEqual({
      says: "volumeMissing",
      volume: "pv-that-is-not-there",
    });
    expect(claimCauseText(missing!, t)).toBe(
      "It asks for PersistentVolume pv-that-is-not-there, which does not exist, so it stays Pending until one by that name is made"
    );
    expect(causeRole(asks, missing!, NOW)).toBe("err");
  });

  /**
   * Volumes that could not be read look exactly like a cluster with none,
   * which would call every named volume missing. Fails if an unread read
   * says anything but that it could not look, or a read under way says
   * anything at all.
   */
  it("says the volumes could not be read rather than that the volume is missing", () => {
    expect(claimCause(asks, read([], "unread"))).toEqual({
      says: "volumeUnread",
      volume: "pv-that-is-not-there",
    });
    expect(claimCause(asks, read([], "reading"))).toBeNull();
    expect(causeRole(asks, { says: "volumeUnread", volume: "pv" }, NOW)).toBe(
      "warn"
    );
  });

  /**
   * The volume controller never binds a volume that holds another claim, nor
   * one Released by a deleted claim, even one of this claim's own name.
   * Fails if either reads as a volume that merely has not bound yet.
   */
  it("names the claim a volume holds, and a Released volume's deleted one", () => {
    const named = claim({ name: "orders", volume: "pv-orders" });
    expect(
      claimCause(
        named,
        read([], [volume("pv-orders", { status: "Bound", claim: "shop/cart" })])
      )
    ).toEqual({ says: "volumeTaken", volume: "pv-orders", claim: "shop/cart" });
    const released = claimCause(
      named,
      read(
        [],
        [
          volume("pv-orders", {
            status: "Released",
            claim: "cause-demo/orders",
          }),
        ]
      )
    );
    expect(released).toEqual({
      says: "volumeReleased",
      volume: "pv-orders",
      claim: "cause-demo/orders",
    });
    expect(claimCauseText(released!, t)).toContain(
      "which is Released: it still holds PersistentVolumeClaim cause-demo/orders, deleted since"
    );
    expect(
      claimCause(
        named,
        read(
          [],
          [volume("pv-orders", { status: "Bound", claim: "cause-demo/orders" })]
        )
      )
    ).toEqual({ says: "namesVolume", volume: "pv-orders" });
  });
});

describe("the colour of a claim's cause", () => {
  /**
   * Provisioning takes seconds, so a claim a minute old is not news; a class
   * that does not exist is, at once. Fails if a fresh claim's warning is
   * drawn as a fault, or a missing class waits out the grace.
   */
  it("draws a warning inside the grace as a wait, and a missing class red at once", () => {
    const fresh = claim({ createdAt: new Date(NOW - 5_000).toISOString() });
    const unprovisioned = {
      says: "unprovisioned",
      name: "standard",
      provisioner: "ebs.csi.aws.com",
    } as const;
    expect(causeRole(fresh, unprovisioned, NOW)).toBe("pending");
    expect(causeRole(fresh, unprovisioned, NOW + CLAIM_GRACE_MS)).toBe("warn");
    expect(
      causeRole(fresh, { says: "classMissing", name: "fast-ssd" }, NOW)
    ).toBe("err");
  });

  /** Fails if a claim the cluster never dated is taken for a young one. */
  it("reports an undated claim's warning at once", () => {
    expect(
      causeRole(claim({ createdAt: null }), { says: "classUnread" }, NOW)
    ).toBe("warn");
  });
});

describe("the evidence a claim's summary quotes", () => {
  const event = (type: string, reason: string, message: string | null) =>
    ({ type, reason, message }) as EventInfo;

  /** Fails if a Normal event is quoted as the trouble, or an older warning over the newest. */
  it("quotes the newest warning, not the newest event", () => {
    const warning = event(
      "Warning",
      "ProvisioningFailed",
      'storageclass.storage.k8s.io "fast-ssd-missing" not found'
    );
    expect(
      claimWarning([
        event("Normal", "ExternalProvisioning", "waiting for a volume"),
        warning,
        event("Warning", "ProvisioningFailed", "an older failure"),
      ])
    ).toBe(warning);
    expect(claimWarning(undefined)).toBeNull();
  });
});
