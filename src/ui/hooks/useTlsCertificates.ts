import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import type { TlsCertificate } from "@/generated/types";

/**
 * What one read of certificates says, by Secret name.
 *
 * A read that failed — the first, or a re-read over an answer already had —
 * leaves every Secret it asked for unread. react-query keeps the last good
 * answer beside the error, and an expiry nobody could read again is not one
 * to state; a Secret with no entry at all is one nothing is said about.
 */
export function certificatesOf(
  data: Map<string, TlsCertificate> | undefined,
  error: unknown,
  names: readonly string[]
): Map<string, TlsCertificate> | undefined {
  if (!error) return data;
  const said = errorToShow(error);
  return new Map(
    names.map((secretName) => [
      secretName,
      {
        secretName,
        certificate: null,
        problem: { says: "secretUnreadable", said },
      },
    ])
  );
}

/**
 * The certificates behind a set of TLS Secrets, by Secret name; `undefined`
 * until the first read has answered.
 *
 * Core: `tls.crt` states its own validity, and it does so on a cluster with
 * nothing installed on it. Only the certificate is read — the private key
 * beside it never leaves the backend.
 */
export function useTlsCertificates(
  namespace: string | undefined,
  secretNames: string[]
): Map<string, TlsCertificate> | undefined {
  // The names come off an Ingress spec in document order, and re-sorting
  // them here would make the query key flap as the Ingress is edited.
  const names = [...new Set(secretNames)].sort();
  const read = useQuery({
    queryKey: queryKeys.tlsCertificates(namespace, names),
    queryFn: async (): Promise<Map<string, TlsCertificate>> => {
      const read = await commands.getTlsCertificates(namespace!, names);
      return new Map(read.map((entry) => [entry.secretName, entry]));
    },
    enabled: !!namespace && names.length > 0,
  });
  return certificatesOf(read.data, read.error, names);
}
