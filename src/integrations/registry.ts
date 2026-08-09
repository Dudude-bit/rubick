/**
 * The seam.
 *
 * An extension contributes *powers*, not pages. Nobody opens a cert-manager
 * page — they are looking at an Ingress and want to know why its
 * certificate has not renewed. So an extension declares which capabilities
 * it can supply, and the surface asks for the capability rather than for
 * the extension by name. A lint rule keeps that honest: nothing outside
 * `src/integrations/` may import an extension folder.
 *
 * **A capability key is a contract, and the surface must have a real answer
 * for its absence.** `certificate.issuance` absent means the page shows the
 * expiry it read from `tls.crt` itself and says nothing about renewal,
 * which is a good answer. A capability with no good answer when absent does
 * not belong behind an extension at all.
 *
 * **And an extension may never take something away.** The core answer is
 * drawn first and stays drawn; the capability extends it. A page that is
 * worse when cert-manager is absent than it was before cert-manager existed
 * has failed at the only thing this seam is for.
 *
 * Deliberately absent, because there is one extension and an abstraction
 * for one implementation is over-engineering: lifecycle hooks, priorities,
 * dependency order, an event bus. What has to be right is the boundary.
 */

import type { IssuanceStory } from "@/generated/types";

/**
 * Every capability the app knows how to consume, and its contract.
 *
 * Plain async functions rather than components or hooks: the surface owns
 * how it fetches and how it draws, so the extension cannot smuggle a layout
 * decision across the seam, and a surface can call one inside its own
 * `useQuery` without any rules-of-hooks trouble.
 */
export interface Capabilities {
  /**
   * How the certificate in a TLS Secret came to be, and what is stopping it
   * being renewed. `null` where nothing manages that Secret — a hand-made
   * certificate is a real and common answer, not a failure.
   */
  "certificate.issuance": (input: {
    namespace: string;
    secretName: string;
  }) => Promise<IssuanceStory | null>;
}

export type CapabilityKey = keyof Capabilities;

export interface Integration {
  /** Matches the `id` the backend's detection reports. */
  id: string;
  name: string;
  /**
   * What the reader gets for having it, in the words of the thing they get
   * — never a list of the objects it reads. This is the whole job of the
   * Settings row.
   */
  gives: string;
  provides: Partial<Capabilities>;
}

/**
 * Declare an extension. Only a type-check today, and that is the point: the
 * registry is a list, not a framework.
 */
export function defineIntegration(integration: Integration): Integration {
  return integration;
}
