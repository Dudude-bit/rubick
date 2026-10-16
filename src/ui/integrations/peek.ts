/**
 * The peeks a vendor owns, keyed by the CRD that defines the object.
 *
 * Its own module rather than a line in the registry, because the peek panel
 * is core and must not pull every vendor's page code in to show a Pod: this
 * imports exactly the summarisers, which import exactly their readers. A CRD
 * nobody here claims falls back to the generic flatten, which every kind
 * answers.
 */

import type { CustomResourceDetailInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import {
  peekIngressRoute,
  peekMiddleware,
  type VendorPeekBody,
} from "./traefik/peek";

export type { VendorPeekBody, VendorPeekGroup } from "./traefik/peek";

const BY_CRD: Array<
  [RegExp, (resource: CustomResourceDetailInfo, t: T) => VendorPeekBody]
> = [
  // Both API groups: a v2 cluster serves `traefik.containo.us` only.
  [/^ingressroutes\.traefik\./, peekIngressRoute],
  [/^middlewares\.traefik\./, peekMiddleware],
];

export function vendorPeek(
  crdName: string
): ((resource: CustomResourceDetailInfo, t: T) => VendorPeekBody) | null {
  return BY_CRD.find(([pattern]) => pattern.test(crdName))?.[1] ?? null;
}
