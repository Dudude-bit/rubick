import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HelmReleaseDetail } from "@/generated/types";
import { WITHHELD_MARKER } from "@/lib/withheld";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { HelmDetail } from "./HelmDetail";

const web: HelmReleaseDetail = {
  name: "web",
  namespace: "team-a",
  revision: 3,
  status: "deployed",
  chart: "nginx",
  chartVersion: "1.0.0",
  appVersion: "1.0.0",
  firstDeployed: "2026-09-01T10:00:00Z",
  lastDeployed: "2026-09-05T10:00:00Z",
  description: null,
  values: {},
  manifest: "",
  notes: null,
  withheld: { values: [], manifest: [], notes: false },
};

/** How the cluster answers for the release and its history, per test. */
const history = vi.hoisted(() => ({
  answer: (): Promise<unknown> => Promise.resolve([]),
}));
const detail = vi.hoisted(() => ({ answer: null as unknown }));

vi.mock("../../../-yaml", () => ({
  YamlEditor: ({ value }: { value: string }) => (
    <pre data-testid="yaml-editor">{value}</pre>
  ),
  YamlEditorAction: () => null,
}));

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
  detail.answer = web;
  history.answer = () => Promise.resolve([]);
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_helm_release_detail") return detail.answer;
    if (command === "get_helm_history") return history.answer();
    if (command.startsWith("list_")) return [];
    return undefined;
  });
});

const open = (tab = "history") =>
  renderWithRouter(<HelmDetail />, {
    at: `/c/prod/helm/native/team-a/web?tab=${tab}`,
    route: "/c/$cluster/helm/$source/$namespace/$name",
  });

/** The release as the backend hands it over with a private key withheld. */
const keyed: HelmReleaseDetail = {
  ...web,
  values: { password: "hunter2", privateKey: WITHHELD_MARKER },
  manifest: [
    "---",
    "# Source: keys/templates/secret.yaml",
    "apiVersion: v1",
    "kind: Secret",
    "metadata: {name: web-key}",
    "stringData:",
    `  tls.key: '${WITHHELD_MARKER}'`,
    "---",
    "# Source: keys/templates/broken.yaml",
    `'${WITHHELD_MARKER}'`,
    "",
  ].join("\n"),
  notes: WITHHELD_MARKER,
  withheld: {
    values: ["privateKey"],
    manifest: [
      {
        position: 1,
        source: "keys/templates/secret.yaml",
        kind: "Secret",
        name: "web-key",
        what: { says: "keys", keys: ["tls.key"] },
      },
      {
        position: 2,
        source: "keys/templates/broken.yaml",
        kind: null,
        name: null,
        what: { says: "unread" },
      },
    ],
    notes: true,
  },
};

describe("a Helm release with a private key in it", () => {
  beforeEach(() => {
    detail.answer = keyed;
  });

  /**
   * The Values tab drew the key in full, and with it withheld would draw the
   * app's placeholder as a value of the release. Fails if the tab does not
   * say the app put it there and where, or says so of a release with none.
   */
  it("says on the Values tab where the app withheld a key", async () => {
    const { unmount } = await open("values");

    expect(await screen.findByRole("note")).toHaveTextContent(
      /^Withheld: privateKey\. The release is untouched/
    );
    expect(screen.getByTestId("yaml-editor")).toHaveTextContent("hunter2");
    unmount();

    detail.answer = web;
    await open("values");
    await screen.findByTestId("yaml-editor");
    expect(screen.queryByRole("note")).toBeNull();
  });

  /**
   * Fails if the Manifest tab draws the placeholder with no word that it is
   * the app's, or does not name the document it stands in.
   */
  it("says on the Manifest tab which document held it, and which was withheld whole", async () => {
    await open("manifest");

    const [keys, whole] = await screen.findAllByRole("note");
    expect(keys).toHaveTextContent(
      /^Withheld in Secret web-key \(keys\/templates\/secret\.yaml\): tls\.key\./
    );
    expect(whole).toHaveTextContent(
      /^Withheld whole: document 2 \(keys\/templates\/broken\.yaml\)\./
    );
  });

  /**
   * Notes that print a key arrive as the placeholder. Drawn, it read as the
   * chart's own note. Fails if the placeholder is drawn, or the tab does not
   * say the notes were withheld.
   */
  it("says the notes were withheld instead of drawing the placeholder", async () => {
    await open("notes");

    expect(await screen.findByRole("note")).toHaveTextContent(
      /^Withheld: these notes hold a private key/
    );
    expect(screen.queryByText(WITHHELD_MARKER)).toBeNull();
  });

  /**
   * A document withheld whole is an object the Resources tab cannot list.
   * Fails if the tab counts what it lists as the whole release, or does not
   * say which document is missing.
   */
  it("says on the Resources tab which document it could not list, and counts a floor", async () => {
    await open("resources");

    expect(await screen.findByRole("note")).toHaveTextContent(
      /^Not listed: document 2 \(keys\/templates\/broken\.yaml\)\./
    );
    expect(screen.getByRole("tab", { name: /Resources/ })).toHaveTextContent(
      "1+"
    );
  });
});

describe("a Helm release's History tab", () => {
  /**
   * A history read that failed read "History 0" over "No history: Helm
   * keeps none for this release". Fails if the tab or its body states none
   * for a history nobody could read.
   */
  it("says the history could not be read, on the tab and in it", async () => {
    history.answer = () =>
      Promise.reject({ code: "PERMISSION_DENIED", message: "forbidden" });
    await open();

    expect(
      await screen.findByText("Could not read this release's history.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/No history/)).toBeNull();
    expect(
      screen.getByRole("tab", { name: /History/ }).textContent
    ).not.toMatch(/\d/);
  });

  /** Fails if a history still on its way is counted as none. */
  it("wears no number while the history is still being read", async () => {
    history.answer = () => new Promise(() => {});
    await open();

    expect(
      await screen.findByRole("tab", { name: /History/ })
    ).not.toHaveTextContent(/\d/);
  });
});
