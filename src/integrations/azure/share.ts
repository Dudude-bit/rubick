import { KeyRound } from "lucide-react";

import type { T } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { AksPicture } from "./data";
import {
  AZURE_IDENTITY_BINDING_CRD,
  AZURE_IDENTITY_CRD,
  bindingSummary,
  danglingBindings,
} from "./model";

/**
 * Bindings naming an AzureIdentity that does not exist. With either list
 * unread that is not knowable: a refused identity list makes every binding
 * look dangling, and a refused binding list makes none.
 */
export function danglingSection(
  picture: AksPicture | undefined,
  error: unknown,
  t: T
): PlacedSection | null {
  const shell = {
    id: "azure-dangling-bindings",
    order: ORDER.own,
    title: t("share", "azureDangling"),
    icon: iconSvg(KeyRound),
  };
  const unread = (why: string): PlacedSection => ({
    ...shell,
    count: null,
    unread: why,
    body: { type: "findings", items: [] },
  });
  if (error) return unread(errorToShow(error));
  if (!picture) return unread(t("share", "stillReading"));
  const refused = picture.unread.filter(
    (read) =>
      read.what === AZURE_IDENTITY_CRD ||
      read.what === AZURE_IDENTITY_BINDING_CRD
  );
  if (refused.length > 0)
    return unread(
      refused
        .map(
          (read) =>
            `${t("empty", "crdCouldNotBeListed", { crd: read.what })}: ${read.reason}`
        )
        .join("; ")
    );
  const dangling = danglingBindings(picture.bindings, picture.identities);
  if (dangling.length === 0) return null;
  return {
    ...shell,
    count: dangling.length,
    body: {
      type: "findings",
      items: dangling.map((binding) => ({
        title: binding.name,
        detail: bindingSummary(binding, t),
        role: "err" as const,
        ref: refOf({
          kind: "AzureIdentityBinding",
          name: binding.name,
          namespace: binding.namespace,
        }),
      })),
    },
  };
}
