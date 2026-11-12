// @vitest-environment jsdom
import { createElement, Fragment, isValidElement, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { StatusBadge } from "@/components/ui/status-badge";
import type { CustomResourceInfo } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { statusRole } from "@/lib/status-role";
import { crd } from "./crd";

const en: T = (section, key, values) => translate("en", section, key, values);

const drawn = (node: unknown) =>
  render(createElement(Fragment, null, node as ReactNode)).container
    .textContent;

function policy(status: unknown): CustomResourceInfo {
  return {
    name: "p",
    namespace: "shop",
    kind: "CiliumNetworkPolicy",
    spec: {},
    status,
  } as CustomResourceInfo;
}

describe("the column that says whether a policy is in force", () => {
  const inForce = crd.columnsFor("CiliumNetworkPolicy")[0];
  const t = (() => "") as never;

  /**
   * A column, not the view's `status`: the list draws `columnsFor` and reads
   * `status` nowhere, so a rejected policy behind the latter is one nobody
   * sees without opening it. Fails if the column moves out of the list.
   */
  it("is the first thing on the row, and says which of the three it is", () => {
    expect(inForce.id).toBe("inForce");
    expect(
      inForce.accessor(
        policy({ conditions: [{ type: "Valid", status: "True" }] }),
        t
      )
    ).toBe("Valid");
    expect(
      inForce.accessor(
        policy({ conditions: [{ type: "Valid", status: "False" }] }),
        t
      )
    ).toBe("Rejected");
    expect(inForce.accessor(policy(null), t)).toBeNull();
  });

  /**
   * The badge colours by looking the word up in `statusRole`'s table, and a
   * word that is not in it comes back neutral — a rejected policy in grey.
   * Fails if either word is dropped from that table.
   */
  it("uses words the badge table knows", () => {
    expect(statusRole("Valid")).toBe("ok");
    expect(statusRole("Rejected")).toBe("err");
  });

  /**
   * The list draws a bare `null` as "none", which under "In force" read as
   * a policy that is not, beside a page saying the agent has not answered.
   * Fails if the third state is left to the list's default again.
   */
  it("says not written yet for a policy nobody has answered about", () => {
    const value = inForce.accessor(policy(null), en);
    expect(drawn(inForce.cell?.(value, en))).toBe("not written yet");
  });

  /** A cell of its own, so the badge the list would have drawn is its job. */
  it("draws the verdict as a badge, not as a bare word", () => {
    const node = inForce.cell?.("Rejected", en);
    expect(isValidElement(node) && node.type).toBe(StatusBadge);
    expect(drawn(node)).toBe("Rejected");
  });
});

describe("which kinds Cilium claims", () => {
  it("claims its own group and nobody else's", () => {
    expect(crd.matches("cilium.io", "CiliumNetworkPolicy")).toBe(true);
    expect(crd.matches("CILIUM.IO", "CiliumNetworkPolicy")).toBe(true);
    expect(crd.matches("networking.istio.io", "VirtualService")).toBe(false);
    expect(crd.matches("cilium.example.com", "Thing")).toBe(false);
  });

  /**
   * A vendor's columns *replace* the CRD's own printer columns, so a kind
   * this file has nothing to say about must claim none. It used to fall
   * through to the policy columns, which told a `CiliumNode` — one of which
   * Cilium writes per node — that it selected every endpoint in the cluster
   * and denied them everything, while throwing away the two columns the CRD
   * itself declares. Fails if the default arm starts answering again.
   */
  it("leaves a kind it has nothing to say about to its own columns", () => {
    for (const kind of [
      "CiliumNode",
      "CiliumIdentity",
      "CiliumLoadBalancerIPPool",
      "CiliumCIDRGroup",
      "CiliumBGPClusterConfig",
      "CiliumL2AnnouncementPolicy",
      "CiliumPodIPPool",
      "CiliumNodeConfig",
    ]) {
      expect(crd.columnsFor(kind)).toEqual([]);
    }
    expect(crd.columnsFor("CiliumEndpoint").map((c) => c.id)).toContain(
      "identity"
    );
  });

  /**
   * Without a `cell` the list wraps a bare string in a `StatusBadge`, and a
   * pod IP is not a status. The verdict draws its own badge, above.
   */
  it("draws every endpoint column itself", () => {
    for (const column of crd.columnsFor("CiliumEndpoint")) {
      expect(column.cell).toBeDefined();
    }
  });

  /**
   * An endpoint's identity, state and address are the agent's to write.
   * Drawn as "none", one it had not written yet read as an endpoint with
   * no identity. Fails if an unwritten status is an empty field again.
   */
  it("says not written yet for an endpoint the agent has written nothing on", () => {
    const said = (status: unknown) =>
      crd
        .columnsFor("CiliumEndpoint")
        .map((column) =>
          drawn(column.cell?.(column.accessor(policy(status), en), en))
        );
    expect(said(null)).toEqual([
      "not written yet",
      "not written yet",
      "not written yet",
    ]);
    expect(
      said({
        identity: { id: 4211 },
        state: "ready",
        networking: { addressing: [{ ipv4: "10.0.1.7" }] },
      })
    ).toEqual(["4211", "ready", "10.0.1.7"]);
  });
});
