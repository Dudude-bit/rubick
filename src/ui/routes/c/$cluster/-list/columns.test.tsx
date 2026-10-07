import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";

import { columns as persistentVolumeColumns } from "../(storage)/persistentvolumes/-components/PersistentVolumeList";
import { columns as persistentVolumeClaimColumns } from "../(storage)/persistentvolumeclaims/-components/PersistentVolumeClaimList";
import { columns as storageClassColumns } from "../(storage)/storageclasses/-components/StorageClassList";
import { columns as namespaceColumns } from "../(cluster)/namespaces/-components/NamespaceList";
import { columns as nodeColumns } from "../(cluster)/nodes/-components/NodeList";
import { DataTable } from "@/components/ui/data-table";
import { createAgeColumn, createDataKeysColumn } from "./columns";
import { PortsDisplay } from "../(network)/-components/PortsDisplay";
import { renderWithProviders, renderWithRouter } from "@/test/render";
import type { ColumnDef } from "@/components/ui/table-features";
import { useLocaleStore } from "@/stores/localeStore";

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
  ["Namespace", namespaceColumns as ColumnDef<never>[]],
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

describe("the keys a ConfigMap or Secret holds, past the first few", () => {
  /**
   * The overflow was "+2 more" in English on a Russian list, beside key
   * names that are the cluster's own words and stay as written.
   */
  it("counts the rest in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      const cell = createDataKeysColumn<{ dataKeys?: string[] }>().cell;
      if (typeof cell !== "function") throw new Error("no keys cell");
      const { container } = render(
        <>
          {cell({
            row: { original: { dataKeys: ["a", "b", "c", "d", "e"] } },
          } as never)}
        </>
      );
      expect(container.textContent).toContain("ещё 2");
      expect(container.textContent).not.toMatch(/more/);
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});

describe("list markers on a Russian screen", () => {
  /** A Service's third port was "+1 more" in English on a Russian list. */
  it("counts a Service's ports past the first two in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      const port = (n: number) => ({
        name: `p${n}`,
        port: n,
        targetPort: String(n),
        nodePort: null,
        protocol: "TCP",
      });
      const { container } = renderWithProviders(
        <PortsDisplay ports={[port(53), port(54), port(9153)]} />
      );
      expect(container.textContent).toContain("ещё 1");
      expect(container.textContent).not.toMatch(/more/);
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });

  /** The default StorageClass was marked "default" in English beside a Russian header. */
  it("marks the default StorageClass in the reader's language", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      const name = storageClassColumns().find(
        (c) => "accessorKey" in c && c.accessorKey === "name"
      );
      const cell = name?.cell;
      if (typeof cell !== "function") throw new Error("no name cell");
      const { container } = await renderWithRouter(
        <>
          {cell({
            row: { original: { name: "local-path", isDefault: true } },
          } as never)}
        </>
      );
      expect(container.textContent).toContain("класс по умолчанию");
      expect(container.textContent).not.toMatch(/default/);
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});

describe("sorting a list by age", () => {
  interface Aged {
    name: string;
    createdAt: string | null;
  }
  const minutesAgo = (n: number) =>
    new Date(Date.now() - n * 60_000).toISOString();
  const rows: Aged[] = [
    { name: "old", createdAt: minutesAgo(2880) },
    { name: "unstamped", createdAt: null },
    { name: "new", createdAt: minutesAgo(5) },
  ];
  const columns: ColumnDef<Aged>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => row.original.name,
    },
    createAgeColumn<Aged>(),
  ];
  const order = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0].textContent);

  /**
   * Dana looked for the youngest pod and the Age header did nothing. Fails if
   * the header stops sorting, if the first press is not youngest first, if
   * the second does not reverse it, or if an object with no stamp is ever
   * sorted in among the others.
   */
  it("sorts youngest first, then oldest first, and keeps an unstamped object last", async () => {
    await renderWithRouter(<DataTable<Aged> columns={columns} data={rows} />);
    expect(order()).toEqual(["old", "unstamped", "new"]);

    await userEvent.click(screen.getByRole("button", { name: /Age/ }));
    expect(order()).toEqual(["new", "old", "unstamped"]);

    await userEvent.click(screen.getByRole("button", { name: /Age/ }));
    expect(order()).toEqual(["old", "new", "unstamped"]);
  });
});
