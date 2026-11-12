import { screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { ContextRow } from "@/components/settings/clusters/ContextRow";
import type { ContextInfo } from "@/generated/types";
import { translate, type Locale } from "@/i18n";
import { renderWithProviders } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { useLocaleStore } from "@/stores/localeStore";
import { StatusBar } from "@/routes/c/$cluster/-shell/StatusBar";

import { ClusterList } from "./ClusterList";

const PROD = "acme-prod-eu";

const context = {
  name: PROD,
  cluster: PROD,
  user: "dana",
  namespace: null,
  is_current: false,
  server: "https://10.255.255.1:6443",
  exec_command: null,
  auth: { kind: "token", source: null },
} as unknown as ContextInfo;

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => useLocaleStore.setState({ choice: null }));

/** The window after acme-prod-eu's connect timed out, with every surface that names it. */
function afterFailedConnect(locale: Locale) {
  useLocaleStore.setState({ choice: locale });
  const failure = { kind: "timeout" as const, error: "deadline has elapsed" };
  useClusterStore.setState({
    contexts: [context],
    currentContext: PROD,
    isConnected: false,
    isLoading: false,
    isAuthenticating: false,
    pendingContext: null,
    error: "deadline has elapsed",
    errorContext: PROD,
    live: [],
    failures: { [PROD]: failure },
  });
  renderWithProviders(
    <>
      <ClusterList
        contexts={[context]}
        total={1}
        filter=""
        onFilterChange={() => {}}
        query=""
        inputRef={{ current: null }}
        onSelect={() => {}}
      />
      <ContextRow
        context={context}
        binding={undefined}
        binaries={new Map()}
        connected={false}
        failure={failure}
        onBind={() => {}}
      />
      <StatusBar />
    </>
  );
}

describe("a failed connect", () => {
  /**
   * Live round 26: one failed connect read "failed" in the picker,
   * "connection failed, retry" in the status bar and "connect failed" in
   * Settings. Fails if any of them names the fact in words of its own.
   */
  it.each(["en", "ru"] as const)(
    "reads the same words in the picker, the status bar and Settings (%s)",
    (locale) => {
      afterFailedConnect(locale);
      const words = translate(locale, "cluster", "connectFailed");

      expect(screen.getByRole("option")).toHaveTextContent(words);
      expect(screen.getByTestId("context-status")).toHaveTextContent(words);
      const bar = screen.getByRole("contentinfo");
      expect(
        within(bar).getByRole("button", {
          name: translate(locale, "cluster", "connectFailedRetry", {
            failed: words,
          }),
        })
      ).toBeInTheDocument();
    }
  );
});
