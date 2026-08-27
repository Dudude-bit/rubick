/**
 * What AKS's two add-ons' objects say.
 *
 * **aad-pod-identity.** Three kinds that only mean anything together, and
 * that is exactly why they read so badly as three separate lists.
 * `AzureIdentity` is a managed identity in Azure written down;
 * `AzureIdentityBinding` says which pods may become it, by label selector;
 * `AzureAssignedIdentity` is what the controller creates when a pod actually
 * matched. The reader's question is one sentence — *this identity binds those
 * pods* — and it currently costs three list pages and a squint.
 *
 * The one thing worth colouring is a binding whose `spec.azureIdentity` names
 * an `AzureIdentity` that does not exist. Nothing validates that string: the
 * binding is accepted, no pod ever gets the identity, and every call from
 * those pods fails with a 403 that has no Kubernetes-side symptom at all.
 * That is a missing *object*, checked by looking for it — not an inference
 * from a missing status, which these objects would not support: their status
 * is `availableReplicas` and nothing else.
 *
 * **AGIC.** `AzureIngressProhibitedTarget` is the opposite kind of object —
 * pure spec, no status, and it does not configure anything so much as fence
 * something off. It says "do not touch this hostname or these paths on the
 * Application Gateway", which is how AGIC is run beside a gateway that
 * something else also configures. A reader who cannot see these has no way
 * to explain why an Ingress they wrote is being ignored.
 */

import type { T } from "@/i18n/useT";
import type { CustomResourceInfo } from "@/generated/types";
import { getValueByPath } from "../kit";

export const AZURE_IDENTITY_CRD = "azureidentities.aadpodidentity.k8s.io";
export const AZURE_IDENTITY_BINDING_CRD =
  "azureidentitybindings.aadpodidentity.k8s.io";
export const PROHIBITED_TARGET_CRD =
  "azureingressprohibitedtargets.appgw.ingress.k8s.io";

const text = (resource: CustomResourceInfo, path: string): string | null => {
  const value = getValueByPath(resource, path);
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * Which identity type this is, in Azure's own numbering.
 *
 * `0` is a user-assigned MSI, `1` a service principal with a client secret,
 * `2` a service principal with a certificate. The numbers are what is in the
 * object; the words are what a reader can act on, and an unrecognised number
 * keeps its number rather than being called something.
 */
export function identityType(
  identity: CustomResourceInfo,
  t: T
): string | null {
  const value = getValueByPath(identity, "spec.type");
  switch (value) {
    case 0:
      return t("readings", "azureUserAssignedMsi");
    case 1:
      return t("readings", "azureServicePrincipal");
    case 2:
      return t("readings", "azureServicePrincipalCert");
    default:
      return value === undefined || value === null ? null : String(value);
  }
}

export function identityClientId(identity: CustomResourceInfo): string | null {
  return text(identity, "spec.clientID");
}

/**
 * The Azure resource an identity is, shortened to the part that identifies
 * it. A full resource id is a hundred and sixty characters of subscription
 * and resource group; the name at the end is what the reader recognises.
 */
export function identityResource(identity: CustomResourceInfo): string | null {
  const id = text(identity, "spec.resourceID");
  if (id === null) return null;
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? id;
}

export function identitySummary(identity: CustomResourceInfo, t: T): string {
  const parts = [identityType(identity, t), identityResource(identity)].filter(
    Boolean
  );
  return parts.length > 0
    ? parts.join(" · ")
    : t("readings", "azureNoIdentityNamedPlain");
}

/** The `AzureIdentity` a binding points at, by name and unvalidated. */
export function bindingIdentity(binding: CustomResourceInfo): string | null {
  return text(binding, "spec.azureIdentity");
}

/** The pod label a binding matches on — `aadpodidbinding: <selector>`. */
export function bindingSelector(binding: CustomResourceInfo): string | null {
  return text(binding, "spec.selector");
}

/**
 * "web-identity binds pods labelled aadpodidbinding=web", which is the whole
 * object in one line and the sentence three list pages could not say.
 */
export function bindingSummary(binding: CustomResourceInfo, t: T): string {
  const identity = bindingIdentity(binding);
  const selector = bindingSelector(binding);
  const parts = [
    identity === null ? null : t("readings", "azureBinds", { name: identity }),
    selector === null
      ? null
      : t("readings", "azureToPodsLabelled", { selector }),
  ].filter(Boolean);
  return parts.length > 0
    ? parts.join(" ")
    : t("readings", "azureNamesNeither");
}

/**
 * Bindings whose identity does not exist, by name.
 *
 * A real missing object rather than a missing status: every `AzureIdentity`
 * in the cluster was listed, and this one is not among them.
 */
export function danglingBindings(
  bindings: CustomResourceInfo[],
  identities: CustomResourceInfo[]
): CustomResourceInfo[] {
  const known = new Set(
    identities.map((identity) => `${identity.namespace}/${identity.name}`)
  );
  return bindings.filter((binding) => {
    const named = bindingIdentity(binding);
    // A binding that names nothing at all is malformed in a different way and
    // is not claimed to reference a missing object.
    if (named === null) return false;
    return !known.has(`${binding.namespace}/${named}`);
  });
}

export function prohibitedTargetSummary(
  target: CustomResourceInfo,
  t: T
): string {
  const host = text(target, "spec.hostname");
  const paths = getValueByPath(target, "spec.paths");
  const list = Array.isArray(paths)
    ? paths.filter((path) => typeof path === "string")
    : [];
  const parts = [
    host === null ? t("readings", "azureAnyHostname") : host,
    list.length > 0 ? list.join(", ") : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
