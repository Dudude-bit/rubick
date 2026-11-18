/**
 * A record keyed by names a cluster or a kubeconfig chose: contexts,
 * namespaces, nodes, columns a resource prints.
 *
 * `__proto__` and `constructor` are names someone can give a context, and a
 * plain object answers them from its prototype: `record[name] = value` sets
 * the prototype or drops the entry, and `record[name]` hands back `Object`
 * as if it were one. At run time this is a plain object, so what is
 * persisted keeps the shape every release before reads. The type has no
 * index, so the compiler refuses `record[name]`; the functions here only
 * read own entries and only make own entries.
 */
declare const byName: unique symbol;

export type Named<T> = { readonly [byName]?: T };

type Plain<T> = Record<string, T>;

/** A record of `from`'s own entries: an object as it was read or stored, or entries. */
export function named<T>(
  from: Readonly<Plain<T>> | Iterable<readonly [string, T]> = []
): Named<T> {
  const entries =
    Symbol.iterator in from
      ? (from as Iterable<readonly [string, T]>)
      : Object.entries(from as Plain<T>);
  return Object.fromEntries(entries) as Named<T>;
}

/** The entry under `name`; never a property every object has. */
export function entryOf<T>(record: Named<T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? (record as Plain<T>)[name] : undefined;
}

/** Every entry, `__proto__` among them where one was made. */
export function entriesOf<T>(record: Named<T>): [string, T][] {
  return Object.entries(record as Plain<T>);
}

/** `record` with `name` set to `value`, as an own entry whatever the name. */
export function withEntry<T>(
  record: Named<T>,
  name: string,
  value: T
): Named<T> {
  return { ...(record as Plain<T>), [name]: value } as Named<T>;
}

/** `record` without `name`. */
export function withoutEntry<T>(record: Named<T>, name: string): Named<T> {
  return named(entriesOf(record).filter(([held]) => held !== name));
}
