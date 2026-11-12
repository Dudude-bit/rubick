/** One check a Pod Security level runs, and how the template passes it, as the admission plugin wrote both. */
export interface PodSecurityCheck {
  check: string;
  how: string | null;
}

/** One resource a ResourceQuota has no room for. */
export interface QuotaOver {
  resource: string;
  requested: string;
  used: string | null;
  limited: string | null;
}

/** One bound a LimitRange holds a Container or a Pod to; `asked` is null where the template set nothing. */
export interface RangeBound {
  bound: "minimum" | "maximum";
  resource: string;
  per: string;
  allowed: string;
  asked: string | null;
}

/**
 * Who refused a controller's pods and what they hold against the template,
 * read from the API server's answer. Every field is the cluster's own words;
 * `unknown` is an answer this does not recognise, quoted as it is.
 */
export type RefusalReason =
  | {
      by: "podSecurity";
      level: string;
      version: string;
      checks: readonly PodSecurityCheck[];
    }
  | { by: "quotaExceeded"; quota: string; over: readonly QuotaOver[] }
  | {
      by: "quotaUnset";
      quota: string;
      unset: readonly { resource: string; containers: readonly string[] }[];
    }
  | { by: "limitRange"; bounds: readonly RangeBound[] }
  | { by: "serviceAccount"; namespace: string; name: string }
  | { by: "policy"; policy: string; binding: string; said: string }
  | { by: "webhookDenied"; webhook: string; said: string }
  | {
      by: "webhookFailed";
      webhook: string;
      service: { name: string; namespace: string } | null;
      said: string;
    }
  | { by: "terminating"; namespace: string }
  | { by: "unknown" };

const POD_SECURITY = /violates PodSecurity "([^":]+):([^"]+)": ([\s\S]+)$/;
const QUOTA_EXCEEDED =
  /exceeded quota: ([^,]+), requested: ([^\s,]+(?:,[^\s,]+)*), used: ([^\s,]+(?:,[^\s,]+)*), limited: ([^\s,]+(?:,[^\s,]+)*)/;
const QUOTA_UNSET = /failed quota: ([^:]+): must specify ([\s\S]+)$/;
const RANGE_BOUND =
  /(minimum|maximum) (\S+) usage per (\S+) is (\S+?)(?:, but (?:request|limit) is ([^\s,\]]+)|\.\s+No (?:request|limit) is specified)/g;
const SERVICE_ACCOUNT =
  /error looking up service account ([^/\s]+)\/([^:\s]+): serviceaccount "[^"]*" not found/;
const POLICY =
  /ValidatingAdmissionPolicy '([^']+)' with binding '([^']+)' denied request: ([\s\S]*)$/;
const WEBHOOK_DENIED =
  /admission webhook "([^"]+)" denied the request(?::\s*([\s\S]*))?/;
const WEBHOOK_FAILED =
  /failed calling webhook "([^"]+)": (?:failed to call webhook: )?([\s\S]+)$/;
const WEBHOOK_SERVICE = /https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.svc[:/]/;
const TERMINATING =
  /unable to create new content in namespace (\S+) because it is being terminated/;

/** Splits `a (x, y), b` at the commas between items, not those inside parentheses or quotes. */
function topLevelItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === "," && text[at + 1] === " ") {
      items.push(text.slice(start, at));
      start = at + 2;
    }
  }
  items.push(text.slice(start));
  return items.map((item) => item.trim()).filter(Boolean);
}

function podSecurityCheck(item: string): PodSecurityCheck {
  const open = item.indexOf(" (");
  return open > 0 && item.endsWith(")")
    ? { check: item.slice(0, open), how: item.slice(open + 2, -1) }
    : { check: item, how: null };
}

/** `pods=1,requests.cpu=500m` as resource to quantity. */
function quantities(list: string): Map<string, string> {
  return new Map(
    list.split(",").flatMap((pair) => {
      const at = pair.indexOf("=");
      return at > 0 ? [[pair.slice(0, at), pair.slice(at + 1)] as const] : [];
    })
  );
}

function quotaUnset(list: string) {
  if (!list.includes(" for: "))
    return list
      .split(",")
      .map((resource) => ({ resource: resource.trim(), containers: [] }));
  return list.split("; ").map((entry) => {
    const [resource, containers = ""] = entry.split(" for: ");
    return {
      resource: resource.trim(),
      containers: containers.split(",").map((name) => name.trim()),
    };
  });
}

/** Who refused the pods, read from the API server's answer `said`. */
export function refusalReason(said: string): RefusalReason {
  const security = POD_SECURITY.exec(said);
  if (security)
    return {
      by: "podSecurity",
      level: security[1],
      version: security[2],
      checks: topLevelItems(security[3]).map(podSecurityCheck),
    };
  const exceeded = QUOTA_EXCEEDED.exec(said);
  if (exceeded) {
    const used = quantities(exceeded[3]);
    const limited = quantities(exceeded[4]);
    return {
      by: "quotaExceeded",
      quota: exceeded[1],
      over: [...quantities(exceeded[2])].map(([resource, requested]) => ({
        resource,
        requested,
        used: used.get(resource) ?? null,
        limited: limited.get(resource) ?? null,
      })),
    };
  }
  const unset = QUOTA_UNSET.exec(said);
  if (unset)
    return { by: "quotaUnset", quota: unset[1], unset: quotaUnset(unset[2]) };
  const bounds = [...said.matchAll(RANGE_BOUND)].map((match): RangeBound => ({
    bound: match[1] as RangeBound["bound"],
    resource: match[2],
    per: match[3],
    allowed: match[4],
    asked: match[5] ?? null,
  }));
  if (bounds.length > 0) return { by: "limitRange", bounds };
  const account = SERVICE_ACCOUNT.exec(said);
  if (account)
    return { by: "serviceAccount", namespace: account[1], name: account[2] };
  const policy = POLICY.exec(said);
  if (policy)
    return {
      by: "policy",
      policy: policy[1],
      binding: policy[2],
      said: policy[3],
    };
  const denied = WEBHOOK_DENIED.exec(said);
  if (denied)
    return { by: "webhookDenied", webhook: denied[1], said: denied[2] ?? "" };
  const failed = WEBHOOK_FAILED.exec(said);
  if (failed) {
    const service = WEBHOOK_SERVICE.exec(failed[2]);
    return {
      by: "webhookFailed",
      webhook: failed[1],
      service: service ? { name: service[1], namespace: service[2] } : null,
      said: failed[2],
    };
  }
  const terminating = TERMINATING.exec(said);
  if (terminating) return { by: "terminating", namespace: terminating[1] };
  return { by: "unknown" };
}

/** The level as its namespace label names it, with the version where one is pinned. */
export const securityLevel = (reason: { level: string; version: string }) =>
  reason.version === "latest"
    ? reason.level
    : `${reason.level}:${reason.version}`;
