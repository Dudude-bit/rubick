function ipv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function ipv6(text: string): bigint | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (half: string): string[] | null => {
    if (half === "") return [];
    const groups = half.split(":");
    const last = groups.at(-1) ?? "";
    if (last.includes(".")) {
      const tail = ipv4(last);
      if (tail === null) return null;
      groups.splice(
        -1,
        1,
        (tail >> 16n).toString(16),
        (tail & 0xffffn).toString(16)
      );
    }
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
      ? groups
      : null;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n
  );
}

function address(text: string): { bits: number; value: bigint } | null {
  if (text.includes(":")) {
    const value = ipv6(text);
    return value === null ? null : { bits: 128, value };
  }
  const value = ipv4(text);
  return value === null ? null : { bits: 32, value };
}

/**
 * Whether `ip` falls inside `cidr`, as a NetworkPolicy `ipBlock` reads it;
 * `null` where either cannot be parsed. Another family is never inside.
 */
export function inCidr(ip: string, cidr: string): boolean | null {
  const [base, length] = cidr.split("/");
  const at = address(ip);
  const block = address(base);
  if (!at || !block || length === undefined || !/^\d{1,3}$/.test(length))
    return null;
  const prefix = Number(length);
  if (prefix > block.bits) return null;
  if (at.bits !== block.bits) return false;
  const shift = BigInt(block.bits - prefix);
  return at.value >> shift === block.value >> shift;
}

/** How much of `network` a CIDR holds; `null` where either cannot be parsed. */
export function cidrOverlap(
  network: string,
  cidr: string
): "within" | "outside" | "partly" | null {
  const [base, length] = network.split("/");
  const [start, prefix] = cidr.split("/");
  if (!/^\d{1,3}$/.test(length ?? "") || !/^\d{1,3}$/.test(prefix ?? ""))
    return null;
  if (Number(prefix) <= Number(length)) {
    const held = inCidr(base, cidr);
    return held === null ? null : held ? "within" : "outside";
  }
  const touches = inCidr(start, network);
  return touches === null ? null : touches ? "partly" : "outside";
}
