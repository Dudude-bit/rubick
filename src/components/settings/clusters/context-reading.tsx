import type { ReactNode } from "react";

import type { ContextBindingInfo, ContextInfo } from "@/generated/types";

/**
 * What a context row is allowed to claim, read from the file and from PATH.
 *
 * Nothing here touches a network. Every sentence below is a restatement of
 * bytes already on this machine, which is why "cannot connect" is a
 * statement about a missing binary and never about an API server.
 *
 * The rule the whole module exists for: when the user entry is a shape
 * with no name here, the row says so. A confident wrong sentence on a
 * debugging screen costs more than the form this replaced.
 */

/** A cloud whose credentials this app can pin to a profile. */
export type ProfileVendor = "gcp" | "azure";

/**
 * Which vendor a credential plugin belongs to, by the name it is
 * installed under. `aws` is listed because the row still has something
 * true to say about it, not because a profile can be bound to it.
 */
const VENDOR_BY_BINARY: Record<string, ProfileVendor | "aws"> = {
  "gke-gcloud-auth-plugin": "gcp",
  gcloud: "gcp",
  kubelogin: "azure",
  az: "azure",
  aws: "aws",
  "aws-iam-authenticator": "aws",
  "aws-vault": "aws",
};

export const VENDOR_LABEL: Record<ProfileVendor | "aws", string> = {
  gcp: "GCP",
  azure: "Azure",
  aws: "AWS",
};

/**
 * The binary an exec block will actually run, verbatim.
 *
 * Kept whole rather than reduced to a basename because an absolute path
 * is what PATH lookup has to skip — `/opt/tools/kubelogin` and whatever
 * `kubelogin` resolves to are not the same file.
 */
export function execBinary(execCommand: string | null): string | null {
  return execCommand?.trim().split(/\s+/)[0] || null;
}

/** The name a reader knows the tool by, which is never its directory. */
export function binaryLabel(binary: string): string {
  return binary.slice(
    Math.max(binary.lastIndexOf("/"), binary.lastIndexOf("\\")) + 1
  );
}

export function vendorOf(binary: string | null): ProfileVendor | "aws" | null {
  return binary ? (VENDOR_BY_BINARY[binaryLabel(binary)] ?? null) : null;
}

const MONO = "font-mono text-fg-mid";

/**
 * How this context proves who it is, in one sentence.
 *
 * The exec row names the binary rather than the whole command line: an
 * AKS entry carries five flags and a client id, and none of that changes
 * what the reader does next. The full command stays reachable as the
 * element's title, and is indexed for search.
 */
export function describeAuth(context: ContextInfo): ReactNode {
  const auth = context.auth;
  switch (auth.kind) {
    case "exec": {
      const binary = execBinary(context.exec_command);
      return (
        <>
          Runs{" "}
          <span className={MONO} title={context.exec_command ?? undefined}>
            {binary ? binaryLabel(binary) : "a credential plugin"}
          </span>{" "}
          for a token.
        </>
      );
    }
    case "clientCertificate":
      return auth.source ? (
        <>
          Client certificate, from <span className={MONO}>{auth.source}</span> —
          nothing else needed.
        </>
      ) : (
        <>Client certificate, embedded in the file — nothing else needed.</>
      );
    case "token":
      return auth.source ? (
        <>
          A bearer token, read from <span className={MONO}>{auth.source}</span>.
        </>
      ) : (
        <>A bearer token, written in the file — nothing else needed.</>
      );
    case "basic":
      return auth.username ? (
        <>
          Username and password, as{" "}
          <span className={MONO}>{auth.username}</span>.
        </>
      ) : (
        <>Username and password, stored in the file.</>
      );
    case "authProvider":
      return (
        <>
          The <span className={MONO}>{auth.name}</span> auth provider,
          configured in the file.
        </>
      );
    case "unrecognised":
      return (
        <>
          The file does not say how this context authenticates — this app cannot
          tell.
        </>
      );
  }
}

export type ContextStatus =
  | "connected"
  | "ready"
  | "cannot connect"
  | "cannot tell";

export interface ContextReading {
  how: ReactNode;
  /** The binary that has to exist before this context can be used. */
  needs: string | null;
  /** Set only when PATH says the binary is missing. */
  missingBinary: string | null;
  /** The cloud this context's plugin belongs to, when it belongs to one. */
  vendor: ProfileVendor | "aws" | null;
  /** The profile in force, when one is bound. */
  bound: { vendor: ProfileVendor; profile: string } | null;
  status: ContextStatus;
  /** Everything the row prints, plus what it does not, for settings search. */
  searchText: string;
}

export function readContext(
  context: ContextInfo,
  {
    binaries,
    binding,
    connected,
  }: {
    /** Binary name to resolved path; `null` means "looked, not found". */
    binaries: Map<string, string | null>;
    binding: ContextBindingInfo | undefined;
    connected: boolean;
  }
): ContextReading {
  const needs =
    context.auth.kind === "exec" ? execBinary(context.exec_command) : null;
  // Absent from the map means "not looked up yet", which is not the same
  // claim as "not found" — an unfinished lookup must not turn a working
  // row red for the second it takes to answer.
  const missingBinary =
    needs != null && binaries.has(needs) && binaries.get(needs) == null
      ? needs
      : null;
  const vendor = vendorOf(needs);

  const bound =
    binding?.gcpProfile != null
      ? ({ vendor: "gcp", profile: binding.gcpProfile } as const)
      : binding?.azureProfile != null
        ? ({ vendor: "azure", profile: binding.azureProfile } as const)
        : null;

  const status: ContextStatus = connected
    ? "connected"
    : missingBinary
      ? "cannot connect"
      : context.auth.kind === "unrecognised"
        ? "cannot tell"
        : "ready";

  return {
    how: describeAuth(context),
    needs,
    missingBinary,
    vendor,
    bound,
    status,
    searchText: [
      context.name,
      context.cluster,
      context.server ?? "",
      context.exec_command ?? "",
      context.auth.kind,
      bound ? `${VENDOR_LABEL[bound.vendor]} profile ${bound.profile}` : "",
      missingBinary ? "not found missing path" : "",
      "context kubeconfig authentication",
    ].join(" "),
  };
}
