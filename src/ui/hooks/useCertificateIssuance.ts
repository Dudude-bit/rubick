import { useQueries } from "@tanstack/react-query";

import { useCapability } from "@/integrations";
import type { IssuanceStory } from "@/generated/types";

export interface Issuance {
  /**
   * Whether anything in this cluster can answer the question at all.
   *
   * `false` is the state most readers are in and is not an error: the page
   * shows the expiry it read from the certificate itself and says nothing
   * about renewal.
   */
  available: boolean;
  /**
   * Secret name to its story. A `null` story means the capability answered
   * and nothing manages that Secret — a hand-made certificate, which is a
   * real answer and worth saying.
   */
  stories: Map<string, IssuanceStory | null>;
  /**
   * Set where the capability is there and did not answer. Saying so is the
   * difference between "your certificate is unmanaged" and "the app could
   * not tell", and the reader cannot infer which from silence.
   */
  error: Error | null;
}

/**
 * Why the certificates behind these Secrets look the way they do.
 *
 * Asks for a capability, not for cert-manager: this hook does not know what
 * answered, and neither does anything it hands the answer to.
 */
export function useCertificateIssuance(
  namespace: string | undefined,
  secretNames: string[]
): Issuance {
  const issuance = useCapability("certificate.issuance");
  const names = [...new Set(secretNames)].sort();

  const results = useQueries({
    queries: names.map((secretName) => ({
      queryKey: ["certificate-issuance", namespace, secretName],
      queryFn: () => issuance!({ namespace: namespace!, secretName }),
      enabled: !!issuance && !!namespace,
    })),
  });

  return {
    available: !!issuance,
    stories: new Map(
      names.flatMap((name, index) => {
        const result = results[index];
        return result?.isSuccess ? [[name, result.data] as const] : [];
      })
    ),
    error: (results.find((result) => result.error)?.error as Error) ?? null,
  };
}
