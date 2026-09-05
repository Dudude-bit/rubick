import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { columns as persistentVolumeColumns } from "./PersistentVolumeList";
import { columns as persistentVolumeClaimColumns } from "./PersistentVolumeClaimList";
import { columns as storageClassColumns } from "./StorageClassList";
import { columns as namespaceColumns } from "./NamespaceList";
import { columns as nodeColumns } from "./NodeList";
import type { ColumnDef } from "@/components/ui/table-features";

/**
 * Every list shows an object's age the same way, and none of them shows a
 * word the backend picked.
 *
 * Three of these five used to render `accessorKey: "age"` — a finished
 * string Rust had composed, which said `Unknown` in English when the cluster
 * had stamped nothing, in a table where every neighbouring kind said it in
 * the reader's language. The shared column takes a timestamp and chooses the
 * word at render, where the language is known.
 */
const ageColumnOf = (cols: ColumnDef<never>[]) => {
  const found = cols.find((c) => c.id === "age");
  if (!found) throw new Error("this list has no age column");
  return found;
};

const lists: [string, ColumnDef<never>[]][] = [
  ["PersistentVolume", persistentVolumeColumns() as ColumnDef<never>[]],
  ["PersistentVolumeClaim", persistentVolumeClaimColumns as ColumnDef<never>[]],
  ["StorageClass", storageClassColumns() as ColumnDef<never>[]],
  ["Namespace", namespaceColumns("all", new Map()) as ColumnDef<never>[]],
  ["Node", nodeColumns(new Map()) as ColumnDef<never>[]],
];

describe("how a list says how old something is", () => {
  it.each(lists)("renders %s's age rather than printing it", (_kind, cols) => {
    const age = ageColumnOf(cols);
    // A cell renderer is the whole point: it reads a timestamp and picks the
    // word. An `accessorKey` here would mean the row already carried words.
    expect(typeof age.cell).toBe("function");
    expect("accessorKey" in age).toBe(false);
  });

  /**
   * Every list draws the age from a timestamp, and shows the same thing.
   *
   * Rendered rather than compared: an earlier version of this test asserted
   * `size` and `id` matched the shared column, which a hand-rolled column
   * mimicking two properties satisfies — I checked, by writing one. What only
   * the shared column can do is turn a `createdAt` into a duration on screen.
   */
  it.each(lists)("draws %s's age from the timestamp", (_kind, cols) => {
    const age = ageColumnOf(cols);
    const cell = age.cell;
    if (typeof cell !== "function")
      throw new Error("the age column draws nothing");

    render(
      <>
        {cell({
          row: {
            original: {
              createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
          },
        } as never)}
      </>
    );

    // "5m", in whatever the catalogue spells it — a column reading a
    // pre-formatted string off the row would render nothing here.
    expect(screen.getByText(/\d+\s*[a-zA-Zа-яА-Я]/)).toBeInTheDocument();
  });
});
