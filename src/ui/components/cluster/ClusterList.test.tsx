/**
 * Finding one cluster in a kubeconfig that has hundreds.
 *
 * The list was the whole screen and had no way to narrow it, so the only way
 * to reach a cluster whose name you already knew was to scroll. What follows
 * pins the filter box's contract: what it matches, which of the two empty
 * answers it gives, and the keyboard path in and out of it — including the
 * ones that only work because the box sits *outside* the listbox.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { useClusterFilter } from "@/hooks/useClusterFilter";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { useClusterRecencyStore } from "@/stores/clusterRecencyStore";
import { useLocaleStore } from "@/stores/localeStore";
import { useClusterStore } from "@/stores/clusterStore";
import type { ContextInfo } from "@/generated/types";

import { ClusterList } from "./ClusterList";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

// Radix's ContextMenu, which wraps every row, asks the DOM three things
// jsdom does not implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const context = (name: string): ContextInfo =>
  ({
    name,
    cluster: name,
    user: `${name}-user`,
    namespace: null,
    is_current: false,
    server: `https://${name}.example:6443`,
    exec_command: null,
    auth: { kind: "token", source: null },
  }) as unknown as ContextInfo;

const ARN = "arn:aws:eks:us-east-1:1234:cluster/a7f3c91";
const NAMES = ["prod-eus2-mki", "prod-euw1-mki", "dev-euw1-mki", ARN];

const onSelect = vi.fn();

beforeEach(() => {
  onSelect.mockReset();
  localStorage.clear();
  useClusterStore.setState({ contexts: NAMES.map(context) });
  useClusterRecencyStore.setState({ lastUsed: {} });
  useClusterIdentityStore.setState({ marks: {} });
});

/**
 * The same wiring the front door has: the hook owns the needle, the list
 * renders it. Testing `ClusterList` with a hand-held `filter` prop would
 * prove nothing about the composition that actually ships.
 */
function Harness({ autoFocus = true }: { autoFocus?: boolean }) {
  const cluster = useClusterFilter();
  return (
    <ClusterList
      contexts={cluster.shown}
      total={cluster.total}
      filter={cluster.filter}
      onFilterChange={cluster.setFilter}
      query={cluster.query}
      inputRef={cluster.inputRef}
      onSelect={onSelect}
      autoFocus={autoFocus}
    />
  );
}

const box = () =>
  screen.getByRole("textbox", { name: t("action", "filterClusters") });

const rows = () => screen.queryAllByRole("option");
const rowNames = () => rows().map((row) => row.textContent);

const press = async (init: KeyboardEventInit) => {
  let event: KeyboardEvent;
  await act(async () => {
    event = new KeyboardEvent("keydown", { ...init, cancelable: true });
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event!;
};

describe("narrowing the cluster list", () => {
  /** The feature: three letters and the other three hundred rows go away. */
  it("shows only the contexts that contain what was typed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(rows()).toHaveLength(4);

    await user.type(box(), "euw1");

    expect(rowNames()).toHaveLength(2);
    expect(rowNames().join(" ")).toContain("prod-euw1-mki");
    expect(rowNames().join(" ")).toContain("dev-euw1-mki");
  });

  /**
   * A renamed cluster shows its alias as the name on the row, so filtering on
   * the context name alone would hide it from the only word its owner uses.
   *
   * The alias must not appear anywhere in the context name, or the name rung
   * answers first and the alias lookup is never reached: this test passed
   * with `aliasOf` deleted from the hook while the fixture was
   * `…:cluster/billing` renamed to `billing`.
   */
  it("finds a cluster by the name its user renamed it to", async () => {
    const user = userEvent.setup();
    useClusterIdentityStore.setState({
      marks: { [ARN]: { alias: "payments" } },
    });
    render(<Harness />);

    await user.type(box(), "payments");

    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("payments");
  });

  /** Typing does not disturb the row the caret was parked on before it. */
  it("keeps the caret in the box while a keystroke empties the list", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(box());
    await user.type(box(), "zzz");
    expect(box()).toHaveFocus();

    // And again on the way back, which is the keystroke that refills it.
    await user.type(box(), "{Backspace}{Backspace}{Backspace}prod");
    expect(box()).toHaveFocus();
    expect(rows()).toHaveLength(2);
  });
});

describe("the two ways a cluster list can be empty", () => {
  /**
   * The pair. An assertion that the list is empty is satisfied by either
   * state, so each test names the sentence it wants *and* denies the other —
   * otherwise "your filter matched nothing" would pass against a kubeconfig
   * that was never read.
   */
  it("says nothing matches the query without claiming the kubeconfig is empty", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(box(), "zzz");

    expect(rows()).toHaveLength(0);
    expect(
      screen.getByText(t("empty", "nothingMatchesQuery", { query: "zzz" }))
    ).toBeInTheDocument();
    expect(
      screen.queryByText(t("empty", "noContextsInKubeconfig"))
    ).not.toBeInTheDocument();
  });

  it("says the kubeconfig lists no contexts when there are none to filter", () => {
    useClusterStore.setState({ contexts: [] });
    render(<Harness />);

    expect(rows()).toHaveLength(0);
    expect(
      screen.getByText(t("empty", "noContextsInKubeconfig"))
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing matches/)).not.toBeInTheDocument();
  });

  /** A dead end needs a way out that is not "select all and delete". */
  it("puts every cluster back when the filter is cleared from the empty state", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(box(), "zzz");

    await user.click(
      screen.getByRole("button", { name: t("action", "clearSearch") })
    );

    expect(rows()).toHaveLength(4);
    expect(box()).toHaveFocus();
  });
});

describe("reaching the filter box", () => {
  /**
   * The point of the shortcut. Both modifiers, because the handler matches
   * either and a Linux reader has no Command key.
   */
  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("puts the caret in the filter box on %s+F", async (_name, modifier) => {
    render(<Harness />);
    expect(box()).not.toHaveFocus();

    const event = await press({ key: "f", ...modifier });

    expect(box()).toHaveFocus();
    // Unclaimed, WebView2 opens its own find bar over the window.
    expect(event.defaultPrevented).toBe(true);
  });

  /** So a second press, or a paste, replaces the needle instead of growing it. */
  it("selects what is already in the box so the next keystroke replaces it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(box(), "prod");

    await press({ key: "f", metaKey: true });

    const input = box() as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
  });

  /**
   * A window listener fires under a Radix modal too. With the command palette
   * open over the front door, focus belongs to its trap, and pulling it out
   * from underneath is a fight the palette wins on the next render.
   */
  it("leaves the shortcut alone while something modal has the keyboard", async () => {
    render(
      <>
        <div role="dialog">
          <input aria-label="palette" />
        </div>
        <Harness />
      </>
    );
    const palette = screen.getByLabelText("palette");
    palette.focus();

    await press({ key: "f", metaKey: true });

    expect(palette).toHaveFocus();
    expect(box()).not.toHaveFocus();
  });

  /** A pane inside a page is not the screen, so it must not claim a shortcut. */
  it("does not claim the shortcut in a list that was told not to take focus", async () => {
    render(<Harness autoFocus={false} />);

    const event = await press({ key: "f", metaKey: true });

    expect(box()).not.toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the keyboard, once the caret is in the box", () => {
  /**
   * The regression the DOM shape prevents. The listbox `preventDefault`s Home
   * and End to jump between rows; with the input nested inside it, neither key
   * would reach the caret. Move the box back in and this fails.
   */
  it("leaves Home and End to the caret rather than jumping between rows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(box(), "prod");

    await user.keyboard("{Home}");
    expect(box()).toHaveFocus();
    expect((box() as HTMLInputElement).selectionStart).toBe(0);

    await user.keyboard("{End}");
    expect(box()).toHaveFocus();
    expect((box() as HTMLInputElement).selectionStart).toBe(4);
  });

  it("walks from the filter box into the list and back out again", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(box());

    await user.keyboard("{ArrowDown}");
    expect(rows()[0]).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(box()).toHaveFocus();
  });

  /**
   * Picking the wrong cluster is the expensive mistake on this screen, so the
   * first Enter only moves onto the row — where the alias, the real context
   * name and the provider are all legible — and the second one commits.
   */
  it("lands on the matching row on Enter rather than connecting to it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(box(), "dev");

    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(rows()[0]).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("dev-euw1-mki");
  });

  it("clears the filter on Escape and keeps the box focused", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(box(), "prod");
    expect(rows()).toHaveLength(2);

    await user.keyboard("{Escape}");

    expect((box() as HTMLInputElement).value).toBe("");
    expect(rows()).toHaveLength(4);
    expect(box()).toHaveFocus();
  });

  /** Unchanged by the box: one keystroke still connects to the top cluster. */
  it("still lands on the first cluster when the screen opens", () => {
    render(<Harness />);
    expect(rows()[0]).toHaveFocus();
  });
});

describe("the recency groups, under a filter", () => {
  /**
   * Both captions exist to tell two groups apart. Filtering down to one group
   * leaves nothing to distinguish, so the headings have to go with it —
   * "Recent" over the whole list would be a claim about the rows below it.
   */
  it("drops the captions when the filter leaves only one group", async () => {
    const user = userEvent.setup();
    useClusterRecencyStore.setState({ lastUsed: { "prod-eus2-mki": 1_000 } });
    render(<Harness />);

    expect(screen.getByText(t("cluster", "recent"))).toBeInTheDocument();
    expect(screen.getByText(t("cluster", "allContexts"))).toBeInTheDocument();

    // `prod-eus2-mki` is the only recent one, and the only match.
    await user.type(box(), "eus2");

    expect(rows()).toHaveLength(1);
    expect(screen.queryByText(t("cluster", "recent"))).not.toBeInTheDocument();
    expect(
      screen.queryByText(t("cluster", "allContexts"))
    ).not.toBeInTheDocument();
  });
});

describe("the recent clusters, in Russian", () => {
  /** The row said "last used 58m ago" on a Russian screen: the words were a
   *  template literal the catalogue never saw. */
  it("says when a cluster was last used in the reader's language", () => {
    useLocaleStore.setState({ choice: "ru" });
    useClusterRecencyStore.setState({ lastUsed: { "prod-eus2-mki": 1_000 } });
    render(<Harness />);

    expect(screen.getByText(/открывался .* назад/)).toBeInTheDocument();
    expect(screen.queryByText(/last used/)).not.toBeInTheDocument();
    useLocaleStore.setState({ choice: "en" });
  });
});
