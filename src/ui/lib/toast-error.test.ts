import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ toast }));

import { usePrivacyStore } from "@/stores/privacyStore";
import { toastError, toastWriteError } from "./toast-error";

const SOURCES = import.meta.glob<string>(
  [
    "/src/ui/**/*.{ts,tsx}",
    "!/src/ui/**/*.test.{ts,tsx}",
    "!/src/ui/generated/**",
  ],
  { query: "?raw", import: "default", eager: true }
);

/**
 * Where the message is kept or compared rather than shown. Not a store: a
 * store's error is read by every screen that shows it, and one of them
 * forgetting `verbatim` is how the toast beside the cluster door and the
 * alert panel printed "Tauri command 'connectCluster' failed:".
 */
const KEEPS_THE_PREFIX = new Set([
  "/src/ui/lib/error-utils.ts",
  "/src/ui/lib/commands.ts",
  "/src/ui/routes/c/$cluster/(workloads)/pods/-components/PodTerminal.tsx",
]);

/**
 * Every spelling of a caught failure read by hand: the `instanceof` guard,
 * `String(error)` — which adds "Error: " in front of the prefix, so even
 * `verbatim` cannot take it off — a cast, a bare `.message`, and the
 * `.message` of what `reportError` hands back, which is the logged form.
 */
const BY_HAND = new RegExp(
  [
    String.raw`instanceof Error\s*\?\s*[\w.]+\.message`,
    String.raw`String\(\s*(?:e|err|error)\s*\)`,
    String.raw`as Error\)\.message`,
    String.raw`\b(?:err|error)\??\.message\b`,
    String.raw`\bnormalized\??\.message\b`,
  ].join("|"),
  "g"
);

/** Where that spelling is compared, logged or kept, and never shown. */
const NOT_SHOWN = new Map([
  ["/src/ui/lib/error-utils.ts", "the normaliser itself"],
  ["/src/ui/lib/read-deadline.ts", "searched for a marker"],
  ["/src/ui/lib/log-queue.ts", "kept for the retry"],
  ["/src/ui/lib/query-log.ts", "logged"],
  ["/src/ui/integrations/cloudnativepg/page.tsx", "compared with sentinels"],
  ["/src/ui/workers/diff.worker.ts", "a worker's own failure, not a command's"],
  ["/src/ui/stores/updaterStore.ts", "the updater plugin's, not a command's"],
  ["/src/ui/App.tsx", "a render error, not a command's"],
  [
    "/src/ui/components/ui/error-boundary.tsx",
    "a render error, not a command's",
  ],
  ["/src/ui/hooks/useIngressRouting.ts", "searched for a verdict"],
  ["/src/ui/hooks/useDeepLinks.ts", "logged"],
]);

describe("a failure shown to the reader", () => {
  beforeEach(() => toast.mockClear());

  /** "Tauri command 'deletePod' failed:" is our framing, not the server's words. */
  it("gives the server's words without the command in front", () => {
    toastError(
      "Could not delete",
      new Error(
        'Tauri command \'deletePod\' failed: pods "web" is forbidden: User "kirya" cannot delete resource "pods"'
      )
    );
    expect(toast).toHaveBeenCalledWith({
      title: "Could not delete",
      description:
        'pods "web" is forbidden: User "kirya" cannot delete resource "pods"',
      variant: "destructive",
    });
  });

  /**
   * Pinning a kubeconfig that would not parse toasted the backend's words
   * with the whole home path in them. Fails if an error toast skips the
   * Redact names and paths box every other screen follows.
   */
  it("hides the home in the server's words while Redact names and paths is on", () => {
    usePrivacyStore.setState({
      hidePaths: true,
      identity: {
        roots: [{ root: "/home/marco", standIn: "~" }],
        user: "marco",
      },
    });
    toastError(
      "Could not use that kubeconfig",
      "Failed to read kubeconfig from /home/marco/work/.kube/config: line 6"
    );
    usePrivacyStore.setState({ identity: null });
    expect(toast).toHaveBeenCalledWith({
      title: "Could not use that kubeconfig",
      description: "Failed to read kubeconfig from ~/work/.kube/config: line 6",
      variant: "destructive",
    });
  });

  /**
   * About eighty toasts and inline lines passed `normalizeTauriError` — or
   * `String(err)` — straight to the screen, prefix and all. It is for a
   * message that is thrown or matched; one that is shown goes through
   * `errorToShow`.
   */
  it("is not built from the prefixed message anywhere it is shown", () => {
    const shown = Object.entries(SOURCES).flatMap(([path, source]) =>
      KEEPS_THE_PREFIX.has(path)
        ? []
        : source
            .split("\n")
            .filter(
              (line) =>
                line.includes("normalizeTauriError(") &&
                !/throw\b/.test(line) &&
                !line.trimStart().startsWith("import")
            )
            .map((line) => `${path}: ${line.trim()}`)
    );
    expect(Object.keys(SOURCES).length).toBeGreaterThan(500);
    expect(shown).toEqual([]);
  });

  /**
   * The same message spelled by hand — `error instanceof Error ?
   * error.message : …` — slipped past the check above on five vendor pages
   * and in `errorWords`, the words of every toast built from a caught error.
   * Matching that one spelling let `String(error)` and a bare `.message`
   * put "Tauri command 'probeResolveHost' failed:" on a route trace, a
   * GatewayClass, the debug dialog and six more screens.
   */
  it("is not read off error.message by hand anywhere it is shown", () => {
    const shown = Object.entries(SOURCES).flatMap(([path, source]) =>
      NOT_SHOWN.has(path)
        ? []
        : source
            .split("\n")
            .flatMap((line, index) =>
              /^\s*(\*|\/\/|\/\*)/.test(line) || !line.match(BY_HAND)
                ? []
                : [`${path}:${index + 1}`]
            )
    );
    expect(shown).toEqual([]);
  });
});

/** A command that changes the cluster, as a screen calls it. */
const WRITE = new RegExp(
  String.raw`\bcommands\.(?:` +
    [
      "delete(?!AzureProfile|GcpProfile|ContextBinding|PortForwardConfig)[A-Z]\\w*",
      "scale[A-Z]\\w*",
      "restart[A-Z]\\w*",
      "rollbackWorkload",
      "cordonNode",
      "uncordonNode",
      "patchCustomResource\\w*",
      "triggerCronjob",
      "setAutoscalerBounds",
      "setConfigmapKey",
      "updateDeploymentImage",
    ].join("|") +
    String.raw`)\(`
);

/** Where the failure of a write is worded, and in how many places there. */
const WORDS_A_WRITE = new Map([
  ["/src/ui/hooks/useResource.ts", 1],
  ["/src/ui/hooks/useResourceDetail.ts", 1],
  ["/src/ui/routes/c/$cluster/-list/ResourceList.tsx", 1],
  ["/src/ui/routes/c/$cluster/-object/useObjectActions.tsx", 1],
  ["/src/ui/routes/c/$cluster/-object/-components/CustomResourceDetail.tsx", 1],
  ["/src/ui/routes/c/$cluster/-debug/DebugPodDialog.tsx", 1],
  ["/src/ui/routes/c/$cluster/-debug/DebugNodeDialog.tsx", 1],
  [
    "/src/ui/routes/c/$cluster/(cluster)/nodes/-components/useNodeActions.tsx",
    2,
  ],
  [
    "/src/ui/routes/c/$cluster/(cluster)/customresourcedefinitions/-components/Crds.tsx",
    1,
  ],
  [
    "/src/ui/routes/c/$cluster/(cluster)/customresourcedefinitions/-components/CrdDetail.tsx",
    1,
  ],
  ["/src/ui/routes/c/$cluster/(workloads)/pods/-components/PodDetail.tsx", 2],
  [
    "/src/ui/routes/c/$cluster/(workloads)/cronjobs/-components/CronJobDetail.tsx",
    1,
  ],
  [
    "/src/ui/routes/c/$cluster/(config)/configmaps/-components/ConfigMapDetail.tsx",
    1,
  ],
  ["/src/ui/integrations/cloudnativepg/page.tsx", 1],
  ["/src/ui/integrations/scylla/page.tsx", 1],
]);

/** What a screen hands a write to, to have its failure worded there. */
const HANDS_IT_ON =
  /\b(?:useResourceMutation|useResourceDetail|createResourceListPage|createWorkloadListPage|ResourceList)\b/;

/** Writes whose failure the caller of the file words. */
const WORDED_BY_ITS_CALLER = new Map([
  ["/src/ui/routes/c/$cluster/-peek/peek-actions.ts", "useObjectActions"],
  ["/src/ui/integrations/cloudnativepg/actions.ts", "its page"],
  ["/src/ui/integrations/scylla/actions.ts", "its page"],
]);

describe("a write nobody answered", () => {
  beforeEach(() => toast.mockClear());

  /** What the wrapper every command goes through throws for a backend error. */
  const thrown = (code: string, said: string) =>
    new Error(
      `Tauri command 'scaleDeployment' failed: Kubernetes API error: ${said}`,
      {
        cause: { code, message: `Kubernetes API error: ${said}`, said },
      }
    );

  /**
   * Scale, restart, delete, rollback and cordon called a deadline, a 502 and
   * a dropped connection "failed", and the reader did it again over a write
   * that had landed. Fails if either code is drawn as a failure, or the
   * cluster's own words are left out.
   */
  it("is not called failed: the cluster may have done it", () => {
    for (const code of ["NO_ANSWER", "READ_DEADLINE"]) {
      toast.mockClear();
      toastWriteError("Could not scale api", thrown(code, "502 Bad Gateway"));
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith({
        title: "The cluster did not answer",
        description:
          "No answer came back (502 Bad Gateway). The cluster may have done it all the same: check before doing it again.",
      });
    }
  });

  /** The cost of the one above: the server's own no is still a failure. */
  it("leaves a refusal and a conflict a failure, under the screen's own title", () => {
    for (const code of ["PERMISSION_DENIED", "KUBE_API_ERROR", "NOT_FOUND"]) {
      toast.mockClear();
      toastWriteError(
        "Could not scale api",
        thrown(code, "the server said no")
      );
      expect(toast).toHaveBeenCalledWith({
        title: "Could not scale api",
        description: "the server said no",
        variant: "destructive",
      });
    }
  });

  /**
   * The third answer is one line at each place a write's failure is worded.
   * Fails when one of them goes back to calling every error a failure, and
   * when a screen sends a write and words its failure somewhere not listed.
   */
  it("is said wherever a write's failure is worded", () => {
    const said = (source: string) =>
      source.match(/\btoast(?:edUnanswered|WriteError)\(/g)?.length ?? 0;
    for (const [path, places] of WORDS_A_WRITE)
      expect(said(SOURCES[path] ?? ""), path).toBe(places);

    const sending = Object.entries(SOURCES).filter(([, source]) =>
      WRITE.test(source)
    );
    expect(sending.length).toBeGreaterThan(40);
    const strays = sending
      .filter(
        ([path, source]) =>
          !WORDS_A_WRITE.has(path) &&
          !WORDED_BY_ITS_CALLER.has(path) &&
          !HANDS_IT_ON.test(source)
      )
      .map(([path]) => path);
    expect(strays).toEqual([]);
  });
});
