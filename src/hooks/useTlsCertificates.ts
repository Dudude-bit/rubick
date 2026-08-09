import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import type { TlsCertificate } from "@/generated/types";

/**
 * The certificates behind a set of TLS Secrets, by Secret name.
 *
 * Core: `tls.crt` states its own validity, and it does so on a cluster with
 * nothing installed on it. Only the certificate is read — the private key
 * beside it never leaves the backend.
 */
export function useTlsCertificates(
  namespace: string | undefined,
  secretNames: string[]
) {
  // The names come off an Ingress spec in document order, and re-sorting
  // them here would make the query key flap as the Ingress is edited.
  const names = [...new Set(secretNames)].sort();
  return useQuery({
    queryKey: ["tls-certificates", namespace, names.join(",")],
    queryFn: async (): Promise<Map<string, TlsCertificate>> => {
      const read = await commands.getTlsCertificates(namespace!, names);
      return new Map(read.map((entry) => [entry.secretName, entry]));
    },
    enabled: !!namespace && names.length > 0,
  });
}
