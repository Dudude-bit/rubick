/**
 * What an object carries in place of a private key. The backend writes it
 * and refuses to send it back; `src/contracts/withheld-value.json` holds the
 * two to one text and one answer.
 */
export const WITHHELD_MARKER = "<withheld: the app never shows a private key>";

const KEY_MAPS = ["data", "binaryData", "stringData"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where one object holds the placeholder: a key of a key map by its name,
 * any other string by its path, as `spec.containers[0].env[1].value`.
 */
export function withheldKeysOf(object: Record<string, unknown>): string[] {
  const held: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (value.trim() === WITHHELD_MARKER) held.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((item, at) => walk(item, `${path}[${at}]`));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value))
        walk(item, path ? `${path}.${key}` : key);
    }
  };
  for (const [field, value] of Object.entries(object)) {
    const map = KEY_MAPS.some((name) => name === field) && isRecord(value);
    if (!map) walk(value, field);
    else
      for (const [key, item] of Object.entries(value))
        walk(item, typeof item === "string" ? key : `${field}.${key}`);
  }
  return held;
}

/**
 * The keys blanked inside an annotation's value, where that value is a whole
 * object written as JSON: `kubectl apply` keeps the manifest it sent in one,
 * and the backend blanks the private keys in that record as it does in the
 * object. The placeholder there is the app's, not what the cluster holds.
 */
export function withheldCopyIn(value: string): string[] {
  if (!value.includes(WITHHELD_MARKER)) return [];
  let object: unknown;
  try {
    object = JSON.parse(value);
  } catch {
    return [];
  }
  if (!isRecord(object)) return [];
  const metadata = isRecord(object.metadata) ? object.metadata : {};
  const nested = isRecord(metadata.annotations) ? metadata.annotations : {};
  return [
    ...withheldKeysOf(object),
    ...Object.values(nested).flatMap((inner) =>
      typeof inner === "string" ? withheldCopyIn(inner) : []
    ),
  ];
}
