/**
 * What AKS's add-ons are doing for this cluster right now.
 *
 * The problem line is a dangling reference rather than a status, and it has
 * to be: none of these objects reports health. An `AzureIdentityBinding`
 * naming an `AzureIdentity` that does not exist is checked by listing both
 * and looking, which is a fact about what is in the cluster — not a reading
 * of a status field that was never written.
 *
 * It earns the colour because of how silent it is. The binding is accepted,
 * no `AzureAssignedIdentity` is ever created, the pods run perfectly, and
 * every call they make to Azure comes back 403 with nothing anywhere in
 * Kubernetes to say why.
 */

import { commands } from "@/lib/commands";

import { crdObjectPath, crdObjectsPath } from "../kit";
import type { VendorFact } from "../registry";
import {
  AZURE_IDENTITY_BINDING_CRD,
  AZURE_IDENTITY_CRD,
  PROHIBITED_TARGET_CRD,
  bindingIdentity,
  danglingBindings,
} from "./model";

export async function facts(): Promise<VendorFact[]> {
  const [identities, bindings, prohibited] = await Promise.all([
    commands.listCustomResources(AZURE_IDENTITY_CRD, null, null, null),
    commands.listCustomResources(AZURE_IDENTITY_BINDING_CRD, null, null, null),
    commands.listCustomResources(PROHIBITED_TARGET_CRD, null, null, null),
  ]);

  const lines: VendorFact[] = [
    {
      say: [
        {
          key: "kindCount" as const,
          values: { n: identities.length, kind: "AzureIdentity" },
        },
        { key: "azureBindings" as const, values: { n: bindings.length } },
        ...(prohibited.length === 0
          ? []
          : [
              {
                key: "azureProhibited" as const,
                values: { n: prohibited.length },
              },
            ]),
      ],
    },
  ];

  const dangling = danglingBindings(bindings, identities);
  if (dangling.length > 0) {
    lines.push({
      say:
        dangling.length === 1
          ? {
              key: "azureNoIdentityNamed" as const,
              values: { name: bindingIdentity(dangling[0]) ?? "" },
            }
          : {
              key: "azureDanglingBindings" as const,
              values: { n: dangling.length },
            },
      tone: "err",
    });
  }

  if (bindings.length > 0) {
    lines.push({
      say: { key: dangling.length === 1 ? "factShowIt" : "factShowThem" },
      to:
        dangling.length === 1
          ? crdObjectPath(
              AZURE_IDENTITY_BINDING_CRD,
              dangling[0].namespace,
              dangling[0].name
            )
          : crdObjectsPath(AZURE_IDENTITY_BINDING_CRD),
    });
  }

  return lines;
}
