/**
 * Which of the cluster's nodes a name from Prometheus means.
 *
 * A node is `ip-10-0-1-4.eu-west-1.compute.internal` to Kubernetes and often
 * `ip-10-0-1-4` to a scrape target, so a name also means the node it is the
 * leading labels of, or the node that is its own. Never the first label
 * alone: nodes named by address (`10.0.1.5`) or by region and address
 * (`cn-hangzhou.10.0.1.5`) all share it, and compared that way every node of
 * such a cluster was one node. A short name two nodes begin with means
 * neither.
 */
export function nodeMatcher(
  nodes: readonly string[]
): (name: string) => string | null {
  const exact = new Map<string, string>();
  // Leading labels to the one node that begins with them; `null` for several.
  const begins = new Map<string, string | null>();
  const leads = (name: string): string[] => {
    const out: string[] = [];
    for (
      let dot = name.indexOf(".");
      dot !== -1;
      dot = name.indexOf(".", dot + 1)
    )
      out.push(name.slice(0, dot));
    return out;
  };
  for (const node of nodes) {
    const lower = node.toLowerCase();
    exact.set(lower, node);
    for (const lead of leads(lower))
      begins.set(lead, begins.has(lead) ? null : node);
  }
  return (name) => {
    const asked = name.split(":")[0].toLowerCase();
    const same = exact.get(asked);
    if (same !== undefined) return same;
    const longer = begins.get(asked);
    if (longer === null) return null;
    const close = [
      ...(longer === undefined ? [] : [longer]),
      ...leads(asked).flatMap((lead) => exact.get(lead) ?? []),
    ];
    return close.length === 1 ? close[0] : null;
  };
}
