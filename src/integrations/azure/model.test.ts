import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import {
  bindingSummary,
  danglingBindings,
  identitySummary,
  identityType,
  prohibitedTargetSummary,
} from "./model";

const object = (
  kind: string,
  name: string,
  spec: unknown,
  namespace = "k8s-gui-test"
): CustomResourceInfo => ({
  name,
  namespace,
  uid: name,
  apiVersion: "aadpodidentity.k8s.io/v1",
  kind,
  spec,
  status: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
});

describe("what an Azure identity is", () => {
  it("turns Azure's numbering into words and keeps a number it does not know", () => {
    /** Would break if an unrecognised type were called something. `0`, `1`
     *  and `2` are the whole documented set; anything else is a version we
     *  have not read, and the number is at least true. */
    expect(identityType(object("AzureIdentity", "a", { type: 0 }))).toBe(
      "user-assigned MSI"
    );
    expect(identityType(object("AzureIdentity", "a", { type: 1 }))).toBe(
      "service principal"
    );
    expect(identityType(object("AzureIdentity", "a", { type: 9 }))).toBe("9");
    expect(identityType(object("AzureIdentity", "a", {}))).toBeNull();
  });

  it("shortens a resource id to the identity's own name", () => {
    /** A full resource id is a subscription guid, a resource group and a
     *  provider path — a hundred and sixty characters in which the only
     *  part a reader is looking for is the last one. */
    expect(
      identitySummary(
        object("AzureIdentity", "shop", {
          type: 0,
          resourceID:
            "/subscriptions/0000/resourcegroups/prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/shop-api",
        })
      )
    ).toBe("user-assigned MSI · shop-api");
  });
});

describe("what a binding binds", () => {
  it("reads as the sentence three list pages could not say", () => {
    expect(
      bindingSummary(
        object("AzureIdentityBinding", "shop", {
          azureIdentity: "shop-identity",
          selector: "shop",
        })
      )
    ).toBe("binds shop-identity to pods labelled aadpodidbinding=shop");
  });

  it("finds a binding whose identity does not exist", () => {
    /** The one thing here worth a colour, and it is a missing *object*
     *  rather than a missing status: every AzureIdentity was listed and this
     *  name is not among them. Nothing validates that string, so the binding
     *  is accepted, no pod ever gets the identity, and every call the pods
     *  make comes back 403 with no Kubernetes-side symptom at all. */
    const identities = [object("AzureIdentity", "shop-identity", { type: 0 })];
    const bindings = [
      object("AzureIdentityBinding", "good", {
        azureIdentity: "shop-identity",
        selector: "shop",
      }),
      object("AzureIdentityBinding", "typo", {
        azureIdentity: "shop-identiy",
        selector: "shop",
      }),
    ];
    expect(danglingBindings(bindings, identities).map((b) => b.name)).toEqual([
      "typo",
    ]);
  });

  it("does not follow a reference across namespaces", () => {
    /** Would break if a binding were matched to a same-named identity in
     *  another namespace. aad-pod-identity resolves within the namespace, so
     *  reporting that one as found would call a genuinely broken binding
     *  healthy. */
    const identities = [
      object("AzureIdentity", "shop-identity", { type: 0 }, "other"),
    ];
    const bindings = [
      object("AzureIdentityBinding", "here", {
        azureIdentity: "shop-identity",
        selector: "shop",
      }),
    ];
    expect(danglingBindings(bindings, identities)).toHaveLength(1);
  });

  it("does not claim a binding that names nothing is a dangling reference", () => {
    /** A binding with no `azureIdentity` is malformed in a different way and
     *  has no name to report as missing. Counting it here would put a
     *  sentence naming an identity on screen with nothing in the blank. */
    expect(
      danglingBindings([object("AzureIdentityBinding", "empty", {})], [])
    ).toHaveLength(0);
  });
});

describe("what an App Gateway ingress is told to leave alone", () => {
  it("names the catch-all as a catch-all", () => {
    /** A prohibited target with no hostname covers everything, which is the
     *  opposite of "nothing" and the reason an Ingress somebody wrote is
     *  being ignored. */
    expect(
      prohibitedTargetSummary(
        object("AzureIngressProhibitedTarget", "all", { paths: ["/legacy/*"] })
      )
    ).toBe("any hostname · /legacy/*");
    expect(
      prohibitedTargetSummary(
        object("AzureIngressProhibitedTarget", "one", {
          hostname: "shop.example.com",
        })
      )
    ).toBe("shop.example.com");
  });
});
