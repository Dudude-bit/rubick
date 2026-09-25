/**
 * A row whose title is a hostname is a row whose title somebody wants on the
 * clipboard — and the title normally sits *inside* the disclosure button,
 * where a second button is neither valid nor operable.
 */

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import type { PlacedSection } from "@/lib/report-parts";

import {
  FindingList,
  TroubleList,
  TroubleRow,
  VendorReadFailure,
  type Severity,
} from "./page-kit";

/** Reads whatever the screen has registered, on demand rather than on mount,
 * since the registration itself only lands after the first commit's effects. */
function ShareProbe() {
  const collect = useScreenSections();
  const [sections, setSections] = useState<PlacedSection[]>([]);
  return (
    <>
      <button onClick={() => setSections(collect ? collect() : [])}>
        collect
      </button>
      <ul>
        {sections.map((section) => (
          <li key={section.id}>
            {section.title} ({section.count})
          </li>
        ))}
      </ul>
    </>
  );
}

const row = (copy?: string) =>
  render(
    <MemoryRouter>
      <TroubleRow
        title="shop.example.com"
        copy={copy}
        meta="2 paths"
        state={{ text: "serving", tone: "ok" }}
      >
        <p>the detail</p>
      </TroubleRow>
    </MemoryRouter>
  );

describe("a row whose title can be copied", () => {
  /** The whole point: the name is its own control, not a decoration. */
  it("makes the title a button of its own", () => {
    row("shop.example.com");
    expect(
      screen.getByRole("button", { name: "Copy shop.example.com" })
    ).toBeInTheDocument();
  });

  /** A button inside a button is invalid and does not open. */
  it("does not nest it inside the disclosure", () => {
    row("shop.example.com");
    const copy = screen.getByRole("button", { name: "Copy shop.example.com" });
    expect(copy.closest("button[aria-expanded]")).toBeNull();
  });

  /** The row still opens — from the chevron and from the rest of the line. */
  it("still toggles", () => {
    row("shop.example.com");
    expect(screen.queryByText("the detail")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /shop\.example\.com — expand/ })
    );
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });

  /**
   * Every other page's rows are names of objects, not addresses. Leaving the
   * prop off has to keep the row exactly as it was — one button, one target.
   */
  it("leaves a row with nothing to copy alone", () => {
    row();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });
});

/**
 * The same constraint from the other side. On the pages whose rows *are*
 * objects — an Argo Application, a cert-manager Certificate — the title was
 * plain text with a comment explaining that an anchor cannot be nested in the
 * disclosure button. Which meant the row's own subject was the one thing on
 * the page a reader could not open.
 */
describe("a row whose title is an object", () => {
  const objectRow = (crd?: string) =>
    render(
      <MemoryRouter>
        <TroubleRow
          title="shop"
          reference={{
            kind: "Application",
            name: "shop",
            namespace: "argocd",
            crd,
          }}
          meta="project prod"
          state={{ text: "degraded", tone: "err" }}
        >
          <p>the detail</p>
        </TroubleRow>
      </MemoryRouter>
    );

  it("makes the title a link to the object", () => {
    objectRow("applications.argoproj.io");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/customresourcedefinitions/applications.argoproj.io/instances/argocd/shop"
    );
  });

  it("does not nest it inside the disclosure", () => {
    objectRow("applications.argoproj.io");
    expect(
      screen.getByRole("link").closest("button[aria-expanded]")
    ).toBeNull();
  });

  it("still toggles from the chevron", () => {
    objectRow("applications.argoproj.io");
    expect(screen.queryByText("the detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /shop — expand/ }));
    expect(screen.getByText("the detail")).toBeInTheDocument();
  });

  /**
   * A custom resource with no CRD named cannot be addressed. The row has to
   * fall back to the plain title rather than to a link that renders nothing,
   * which would delete its own subject.
   */
  it("keeps a plain title for an object it cannot address", () => {
    objectRow(undefined);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("shop")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

interface Item {
  name: string;
  severity: Severity;
}

const severityOf = (item: Item) => item.severity;
const searchable = (item: Item) => [item.name];

function list(items: Item[], at = "/", upTo = 2, when: "err" | "any" = "err") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <TroubleList
        items={items}
        severityOf={severityOf}
        searchable={searchable}
        filter={{ label: "Filter", placeholder: "name" }}
        autoOpen={{ when, upTo }}
        summary={{
          brokenFirst: (n, total) => `${n} of ${total} broken`,
          nothingBroken: "nothing broken",
          allWell: (total) => `all ${total} well`,
        }}
        noMatch={(query) => `nothing matches ${query}`}
        keyOf={(item) => item.name}
        renderRow={(item, { openByDefault }) => (
          <p>
            {item.name}
            {openByDefault ? " open" : " closed"}
          </p>
        )}
      />
    </MemoryRouter>
  );
}

const items: Item[] = [
  { name: "shop", severity: "err" },
  { name: "promo", severity: "warn" },
  { name: "blog", severity: null },
];

describe("a list ordered by trouble", () => {
  /**
   * The routing map hands a page `?q=<host>`. Traefik read it and two other
   * pages kept their filter in local state, so the same click narrowed one
   * list and not the others.
   */
  it("takes its filter from the address", () => {
    list(items, "/?q=pro");
    expect(screen.getByText(/promo/)).toBeInTheDocument();
    expect(screen.queryByText(/shop/)).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("says so when the filter matches nothing", () => {
    list(items, "/?q=zzz");
    expect(screen.getByText("nothing matches zzz")).toBeInTheDocument();
  });

  /** Would open every broken row on a screen of two hundred. */
  it("opens the broken rows only while there are few of them", () => {
    list(items);
    expect(screen.getByText("shop open")).toBeInTheDocument();
    expect(screen.getByText("promo closed")).toBeInTheDocument();

    const many = Array.from({ length: 3 }, (_, i) => ({
      name: `down-${i}`,
      severity: "err" as const,
    }));
    list(many);
    expect(screen.getByText("down-0 closed")).toBeInTheDocument();
  });

  it("opens rows worth a look too where the page asks for it", () => {
    list(items, "/", 2, "any");
    expect(screen.getByText("promo open")).toBeInTheDocument();
    expect(screen.getByText("blog closed")).toBeInTheDocument();
  });

  it("puts the broken count first and the rest after it", () => {
    list(items);
    expect(
      screen.getByText("1 of 3 broken · 1 worth a look")
    ).toBeInTheDocument();
  });

  it("tells warnings apart from nothing to see", () => {
    list([{ name: "promo", severity: "warn" }]);
    expect(
      screen.getByText("nothing broken · 1 of 1 worth a look")
    ).toBeInTheDocument();
    list([{ name: "blog", severity: null }]);
    expect(screen.getByText("all 1 well")).toBeInTheDocument();
  });

  /**
   * A host whose backends were never read summed to "all well": the line
   * counted only what was found wrong, and nothing is found where nothing
   * is looked at.
   */
  it("does not call rows it could not check well", () => {
    list([
      { name: "blog", severity: "unknown" },
      { name: "shop", severity: null },
    ]);
    expect(screen.getByText("1 of 2 not checked")).toBeInTheDocument();
    expect(screen.queryByText(/well/)).not.toBeInTheDocument();
  });

  /** An unchecked row is not a finding to open for. */
  it("does not open a row it could not check", () => {
    list([{ name: "blog", severity: "unknown" }], "/", 2, "any");
    expect(screen.getByText("blog closed")).toBeInTheDocument();
  });
});

describe("a vendor page whose read failed", () => {
  const REFUSED =
    'Tauri command \'listCustomResources\' failed: kustomizations.kustomize.toolkit.fluxcd.io is forbidden: User "kirya" cannot list resource "kustomizations" in API group "kustomize.toolkit.fluxcd.io" at the cluster scope';

  /**
   * Fifteen pages drew the raw message under a red heading: the command's
   * name in front of the cluster's words, no way to try again, and no rule
   * to hand an administrator.
   */
  it("gives the cluster's words, a retry and the rule to ask for", () => {
    const retry = vi.fn();
    render(
      <VendorReadFailure
        title="Could not read what Flux is reconciling"
        body="Flux's own objects"
        error={new Error(REFUSED)}
        onRetry={retry}
      />
    );

    expect(
      screen.getByText("Could not read what Flux is reconciling")
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("Tauri command");
    expect(
      screen.getByRole("button", { name: "Copy the rule to ask for" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try the read again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("a row's findings", () => {
  const findings = ["clear", "broken", "expiring"];
  const worth = (finding: string) => finding !== "clear";
  const shown = (brief: boolean) =>
    render(
      <FindingList
        findings={findings}
        brief={brief}
        worthRepeating={worth}
        render={(finding) => <p>{finding}</p>}
      />
    );

  /** An open row owes the reader every finding, the plain one included. */
  it("lists every finding in an open row", () => {
    shown(false);
    for (const finding of findings) {
      expect(screen.getByText(finding)).toBeInTheDocument();
    }
    expect(screen.queryByText(/more/)).toBeNull();
  });

  /**
   * A closed row repeats only what its state word does not already say, and
   * counts the rest, so a reader knows opening it is worth the click.
   */
  it("gives a closed row its first telling finding and a count", () => {
    shown(true);
    expect(screen.getByText("broken")).toBeInTheDocument();
    expect(screen.queryByText("clear")).toBeNull();
    expect(screen.queryByText("expiring")).toBeNull();
    expect(screen.getByText(/1 more/)).toBeInTheDocument();
  });

  it("adds nothing to a closed row whose findings its state word covers", () => {
    const { container } = render(
      <FindingList
        findings={["clear"]}
        brief
        worthRepeating={worth}
        render={(finding) => <p>{finding}</p>}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * A vendor page drawn with `TroubleList` or `FindingList` gets a report of
 * itself for free, with no per-page wiring: delete the `useShareSection`
 * call inside either component and this fails.
 */
describe("a list ordered by trouble tells the screen's Share what it found", () => {
  it("registers a findings section from the rows the vendor calls trouble", () => {
    render(
      <MemoryRouter>
        <ScreenShareProvider>
          <TroubleList
            items={items}
            severityOf={severityOf}
            searchable={searchable}
            filter={{ label: "Filter", placeholder: "name" }}
            autoOpen={{ when: "err", upTo: 2 }}
            noMatch={(query) => `nothing matches ${query}`}
            keyOf={(item) => item.name}
            renderRow={(item) => <p>{item.name}</p>}
            share={{
              title: "Applications",
              toFinding: (item) =>
                item.severity === "err" || item.severity === "warn"
                  ? { title: item.name, detail: null, role: item.severity }
                  : null,
            }}
          />
          <ShareProbe />
        </ScreenShareProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("collect"));
    // Only shop (err) and promo (warn) are trouble; blog has none to report.
    expect(screen.getByText("Applications (2)")).toBeInTheDocument();
  });

  it("leaves the screen's Share empty once every row clears", () => {
    render(
      <MemoryRouter>
        <ScreenShareProvider>
          <TroubleList
            items={[{ name: "blog", severity: null }]}
            severityOf={severityOf}
            searchable={searchable}
            filter={{ label: "Filter", placeholder: "name" }}
            autoOpen={{ when: "err", upTo: 2 }}
            noMatch={(query) => `nothing matches ${query}`}
            keyOf={(item) => item.name}
            renderRow={(item) => <p>{item.name}</p>}
            share={{ title: "Applications", toFinding: () => null }}
          />
          <ShareProbe />
        </ScreenShareProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("collect"));
    expect(screen.queryByText(/Applications/)).not.toBeInTheDocument();
  });

  it("registers a row's own findings under the title the caller gives it", () => {
    render(
      <MemoryRouter>
        <ScreenShareProvider>
          <FindingList
            findings={["clear", "broken"]}
            render={(finding) => <p>{finding}</p>}
            share={{
              title: "Route findings",
              toFinding: (finding) =>
                finding === "clear"
                  ? null
                  : { title: finding, detail: null, role: "err" },
            }}
          />
          <ShareProbe />
        </ScreenShareProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("collect"));
    expect(screen.getByText("Route findings (1)")).toBeInTheDocument();
  });

  /** A Russian title slugged to "" and two such lists took one registry slot. */
  it("keeps two lists with titles in another script as two sections", () => {
    const broken = {
      toFinding: (finding: string) => ({
        title: finding,
        detail: null,
        role: "err" as const,
      }),
    };
    render(
      <MemoryRouter>
        <ScreenShareProvider>
          <FindingList
            findings={["a"]}
            render={(finding) => <p>{finding}</p>}
            share={{ ...broken, title: "Маршруты" }}
          />
          <FindingList
            findings={["b", "c"]}
            render={(finding) => <p>{finding}</p>}
            share={{ ...broken, title: "Издатели" }}
          />
          <ShareProbe />
        </ScreenShareProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("collect"));
    expect(screen.getByText("Маршруты (1)")).toBeInTheDocument();
    expect(screen.getByText("Издатели (2)")).toBeInTheDocument();
  });
});
