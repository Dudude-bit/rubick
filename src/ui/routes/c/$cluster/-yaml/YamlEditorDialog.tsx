/**
 * The editor, and the one interception the app was still missing.
 *
 * Applying an edited manifest is the most powerful write here — it replaces
 * the whole object, not one field — and it was the last control that stayed
 * silent when a delivery controller was going to undo it. That silence stopped
 * being neutral the moment Scale, Restart and Delete started speaking: a
 * reader who has been told twice that the app warns about this reasonably
 * reads the third dialog's quiet as "and this one is safe".
 *
 * Three rules, taken from the controls that already do it:
 *
 * - **It does not block, it tells.** Applying over a delivered object during
 *   an incident is legitimate; doing it believing it will stick is not.
 * - **The ordinary case is untouched.** An object nothing delivers gets the
 *   confirmation it has always had, with the same word on the button.
 * - **No new dialog.** The warning lands inside the confirmation that was
 *   already there, in the same component every other warning is drawn with.
 */

import { useCallback, useMemo, useState, useDeferredValue } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { Applied, ApplyOutcome, DryRunDocument } from "@/generated/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TextSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { Spinner } from "@/components/ui/spinner";
import { ActionWarnings } from "../-object/action-warnings";
import { DeliveryMarks } from "../-delivery/delivery";
import { useConnections } from "@/hooks/useConnections";
import { useDelivery } from "../-delivery/useDelivery";
import { deliveryApplyIntercept } from "@/lib/delivery";
import { applyWarnings } from "@/lib/governance";
import {
  changesReplicaCount,
  deliveryOfManifest,
  liveReplicaMove,
  withheldKeysIn,
} from "./manifest-reads";
import { useClusterStore } from "@/stores/clusterStore";
import {
  editorSession,
  useYamlEditorStore,
  type ResultShown,
} from "@/stores/yamlEditorStore";
import { useAsk } from "../-object/useAsk";
import { askableKind } from "@/lib/tell-me-when";
import { AlertTriangle, Play, FileCheck } from "lucide-react";
import { errorToShow } from "@/lib/error-utils";

import { YamlEditor } from "./YamlEditor";
import { YamlEditorToolbar } from "./YamlEditorToolbar";
import { guardedOf, noteDenied, useEditDenied } from "@/lib/access";
import { ReasonTip } from "@/components/object/detail-blocks";
import { cn } from "@/lib/utils";
import { YamlDiffViewer } from "./YamlDiffViewer";
import { YamlResultDisplay } from "./YamlResultDisplay";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { useT, type T } from "@/i18n/useT";

const APPLY_LINE: Record<
  ApplyOutcome["says"],
  | "applyDocApplied"
  | "applyDocRefused"
  | "applyDocUnanswered"
  | "applyDocNotSent"
> = {
  applied: "applyDocApplied",
  refused: "applyDocRefused",
  unanswered: "applyDocUnanswered",
  notSent: "applyDocNotSent",
};

/**
 * An apply's answer as the result block draws it: a line per document, the
 * ones that went in apart from the rest. An apply stops at the first document
 * that did not go in, so that document's answer is the verdict.
 */
function applyShown(applied: Applied, t: T): ResultShown {
  const lines = (stored: boolean) =>
    applied.documents
      .filter((doc) => (doc.outcome.says === "applied") === stored)
      .map((doc) =>
        t("action", APPLY_LINE[doc.outcome.says], {
          id: doc.id,
          said: "said" in doc.outcome ? doc.outcome.said : "",
        })
      )
      .join("\n");
  const some = (says: ApplyOutcome["says"]) =>
    applied.documents.some((doc) => doc.outcome.says === says);
  return {
    verdict: some("unanswered")
      ? "unanswered"
      : applied.documents.every((doc) => doc.outcome.says === "applied")
        ? "ok"
        : "failed",
    stdout: lines(true),
    stderr: lines(false),
  };
}

export function YamlEditorDialog() {
  const asking = useAsk();
  const t = useT();
  const { toast } = useToast();
  const currentNamespace = useClusterStore((state) => state.currentNamespace);

  const {
    open,
    title,
    resourceKey,
    openedOn,
    originalContent,
    editedContent,
    isLoading,
    isValidating,
    isApplying,
    showDiff,
    readOnly,
    validationResult,
    applyResult,
    closeEditor,
    setEditedContent,
    setShowDiff,
    setValidationResult,
    setApplyResult,
    setIsValidating,
    setIsApplying,
    addHistoryEntry,
    restoreFromHistory,
    getResourceHistory,
    resetToOriginal,
    formatYaml,
  } = useYamlEditorStore();

  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  // Counts the openings of the confirmation: each one asks the server anew.
  const [asked, setAsked] = useState(0);
  // Applying an edited manifest replaces the whole object — the most powerful
  // write here — so on a critical cluster it takes the same typed-name gate,
  // and the field is bound to the notice so neither can appear without the other.
  const gate = useCriticalGate(showApplyConfirm);
  const editDenied = useEditDenied(readOnly ? null : resourceKey);
  // The manifest belongs to the cluster it was read from, and every command
  // below goes to the window's: with the window moved on, nothing is sent.
  const cluster = useClusterStore((state) => state.currentContext);
  const elsewhere =
    open && openedOn !== cluster
      ? t("action", "yamlFromAnotherCluster", { cluster: openedOn ?? "" })
      : undefined;
  if (elsewhere && showApplyConfirm) setShowApplyConfirm(false);
  // A private key reads here as a placeholder, and a ConfigMap would store
  // the placeholder as the key: said while editing, not after confirming.
  const withheld = useMemo(
    () => withheldKeysIn(editedContent),
    [editedContent]
  );
  const carriesWithheld =
    !readOnly && withheld.length > 0
      ? t("action", "yamlCarriesWithheld", { keys: withheld.join(", ") })
      : undefined;
  const applyDenied = elsewhere ?? carriesWithheld ?? editDenied;

  const history = getResourceHistory();
  const hasChanges = originalContent !== editedContent;

  // Asked of the document the server gave, not of the buffer: who owns this
  // object is not something the reader can change by deleting a label from
  // the text. Nothing is fetched at all until a manifest is loaded, and
  // nothing on a cluster with no delivery controller ever.
  const delivery = useMemo(
    () => deliveryOfManifest(originalContent),
    [originalContent]
  );
  const { deliveries } = useDelivery(delivery);
  const intercept = deliveryApplyIntercept(deliveries, t);

  // What the server would store against what it holds now. Asked only once
  // the confirmation is open, of the buffer as it is at that moment; the
  // editor's own diff stands in while the answer is on its way, and says so.
  // `asked` is in the key because "now" is: an answer kept from an earlier
  // opening describes the object as it was then, under the same buffer.
  // Asked of an untouched buffer too: it is as old as the moment it was
  // read, and applying it undoes whatever moved on the cluster since.
  const dryRun = useQuery({
    queryKey: [
      "dry-run",
      resourceKey?.kind ?? "",
      resourceKey?.namespace ?? "",
      resourceKey?.name ?? "",
      editedContent,
      asked,
    ],
    queryFn: () =>
      commands.dryRunManifest(
        editedContent,
        resourceKey?.namespace || currentNamespace || null
      ),
    enabled: showApplyConfirm,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  // The autoscaler owns `spec.replicas` and nothing else, so it is asked
  // about only when that field is what moved — see `applyWarnings`. A typed
  // count is known while the editor is open, so the sentence is already
  // there when the reader gets to the confirmation; the query key is the
  // detail page's, so a page that has read its connections pays nothing.
  // Two whole-document parses per keystroke on a long manifest, and the
  // answer is only needed by the time the confirmation opens: deferred, so
  // typing is never behind them, and memoised on what was actually parsed.
  const settledContent = useDeferredValue(editedContent);
  const typedReplicas = useMemo(
    () =>
      !readOnly &&
      originalContent !== settledContent &&
      changesReplicaCount(originalContent, settledContent),
    [readOnly, originalContent, settledContent]
  );
  // A count that moved on the cluster after the manifest was read is in no
  // buffer: only the dry run's current object shows it.
  const documents = dryRun.data?.documents;
  const unanswered = dryRun.isError;
  const liveMove = useMemo(
    () =>
      showApplyConfirm && (documents || unanswered)
        ? liveReplicaMove(originalContent, editedContent, documents ?? null)
        : null,
    [showApplyConfirm, documents, unanswered, originalContent, editedContent]
  );
  const replicasMoved =
    typedReplicas || (liveMove === "unknown" ? null : liveMove !== null);
  const governance = useConnections(
    resourceKey?.kind ?? "",
    resourceKey?.name,
    resourceKey?.namespace ?? null,
    open && replicasMoved !== false
  );

  const warnings = applyWarnings(governance, intercept, replicasMoved, t);

  const refused =
    dryRun.data?.documents.find((doc) => doc.outcome.says === "refused") ??
    null;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(editedContent);
    toast({
      title: t("action", "copied"),
      description: t("action", "yamlCopiedToClipboard"),
    });
  }, [editedContent, toast, t]);

  const handleValidate = useCallback(async () => {
    const session = editorSession();
    const mine = () => session === editorSession();
    setIsValidating(true);
    setValidationResult(null);

    try {
      const result = await commands.validateManifest(
        editedContent,
        resourceKey?.namespace || currentNamespace || null
      );
      if (!mine()) return;
      setValidationResult(result);

      if (result.success) {
        toast({
          title: t("action", "validationPassed"),
          description: t("action", "manifestIsValid"),
        });
      }
    } catch (error) {
      if (!mine()) return;
      setValidationResult({
        success: false,
        stdout: "",
        stderr: errorToShow(error),
        exit_code: 1,
      });
    } finally {
      if (mine()) setIsValidating(false);
    }
  }, [
    editedContent,
    resourceKey,
    currentNamespace,
    setIsValidating,
    setValidationResult,
    toast,
    t,
  ]);

  const handleApply = useCallback(async () => {
    // The answer can outlast the editor: closed, or opened on another object
    // since, it is told in the toast and filed under the object it was
    // applied to, and the editor on screen is left alone.
    const session = editorSession();
    const mine = () => session === editorSession();
    setShowApplyConfirm(false);
    setIsApplying(true);
    setApplyResult(null);

    try {
      const applied = await commands.applyManifest(
        editedContent,
        resourceKey?.namespace || currentNamespace || null
      );
      const shown = applyShown(applied, t);
      if (mine()) setApplyResult(shown);
      const lines = [shown.stdout, shown.stderr].filter(Boolean).join("\n");

      if (shown.verdict === "ok") {
        addHistoryEntry(editedContent, "Applied", { resourceKey, openedOn });
        const askable = resourceKey ? askableKind(resourceKey.kind) : null;
        if (askable && resourceKey && askable !== "Pod" && askable !== "Job") {
          asking.ask(
            {
              kind: askable,
              namespace: resourceKey.namespace ?? currentNamespace ?? null,
              name: resourceKey.name,
            },
            { action: "apply", replicas: null, generationBefore: null }
          );
        }

        toast({ title: t("action", "applySucceeded"), description: lines });
      } else {
        const refusal = applied.documents.find(
          (doc) => doc.outcome.says === "refused"
        )?.outcome;
        if (resourceKey && refusal?.says === "refused")
          noteDenied(
            "patch",
            guardedOf(
              resourceKey.kind,
              resourceKey.namespace ?? null,
              resourceKey.name
            ),
            { code: refusal.code, message: refusal.said, said: refusal.said }
          );
        // Nobody answering is not a refusal: admission can outlast the wait
        // and the server may have stored it. "Apply failed" there is a
        // verdict on something nobody saw, and invites a second apply.
        const unanswered = shown.verdict === "unanswered";
        toast({
          title: unanswered
            ? t("action", "applyUnanswered")
            : t("action", "applyFailed"),
          description: lines,
          variant: unanswered ? "default" : "destructive",
        });
      }
    } catch (error) {
      // The command itself failed: nothing was sent, or the session is over.
      const errorMessage = errorToShow(error);
      if (mine())
        setApplyResult({ verdict: "failed", stdout: "", stderr: errorMessage });
      toast({
        title: t("action", "applyFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      if (mine()) setIsApplying(false);
    }
  }, [
    asking,
    editedContent,
    resourceKey,
    openedOn,
    currentNamespace,
    setIsApplying,
    setApplyResult,
    addHistoryEntry,
    toast,
    t,
  ]);

  const handleFormat = useCallback(() => {
    void formatYaml().then((formatted) => {
      if (!formatted) return;
      toast({
        title: t("action", "formatted"),
        description: t("action", "yamlFormatted"),
      });
    });
  }, [formatYaml, toast, t]);

  const handleRestoreHistory = useCallback(
    (timestamp: number) => {
      restoreFromHistory(timestamp);
      toast({
        title: t("action", "restored"),
        description: t("action", "contentRestoredFromHistory"),
      });
    },
    [restoreFromHistory, toast, t]
  );

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && closeEditor()}>
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {title}
              {hasChanges && !readOnly && (
                <Badge variant="outline" className="ml-2">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  {t("action", "unsavedChanges")}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                {readOnly
                  ? t("action", "viewYamlManifest")
                  : t("action", "editYamlManifestHint")}
              </span>
              {/* The same quiet mark the page header carries, because the
                  editor is a modal that covers that header: "where does this
                  come from" is asked while editing, and answering it here is
                  what lets the confirmation say only what happens next. */}
              <DeliveryMarks deliveries={deliveries} />
            </DialogDescription>
          </DialogHeader>

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-2 py-2 border-b">
            <YamlEditorToolbar
              showFormat={!readOnly}
              showCopy={true}
              showReset={!readOnly}
              showDiff={true}
              showHistory={!readOnly}
              disabled={isLoading}
              hasChanges={hasChanges}
              isDiffMode={showDiff}
              history={history}
              onFormat={handleFormat}
              onCopy={handleCopy}
              onReset={resetToOriginal}
              onToggleDiff={() => setShowDiff(!showDiff)}
              onRestoreHistory={handleRestoreHistory}
            />

            {!readOnly && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleValidate}
                  disabled={
                    !!elsewhere || isLoading || isValidating || isApplying
                  }
                >
                  {isValidating ? (
                    <Spinner size="sm" className="mr-2" />
                  ) : (
                    <FileCheck className="mr-2 h-4 w-4" />
                  )}
                  {t("action", "validate")}
                </Button>

                <ReasonTip reason={applyDenied}>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      if (applyDenied) return;
                      setAsked((n) => n + 1);
                      setShowApplyConfirm(true);
                    }}
                    disabled={
                      !applyDenied && (isLoading || isValidating || isApplying)
                    }
                    aria-disabled={applyDenied ? true : undefined}
                    className={cn(applyDenied && "cursor-default opacity-40")}
                  >
                    {isApplying ? (
                      <Spinner size="sm" className="mr-2" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    {t("action", "apply")}
                  </Button>
                </ReasonTip>
              </div>
            )}
          </div>

          {carriesWithheld && (
            <p role="status" className="py-2 text-xs text-warn">
              {carriesWithheld}
            </p>
          )}

          {/* Main Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {isLoading ? (
              <div className="h-full rounded-md border p-4">
                <TextSkeleton lines={18} />
              </div>
            ) : showDiff ? (
              <YamlDiffViewer
                original={originalContent}
                modified={editedContent}
                height="100%"
              />
            ) : (
              <div className="h-full rounded-md border overflow-hidden">
                <YamlEditor
                  value={editedContent}
                  onChange={readOnly ? undefined : setEditedContent}
                  readOnly={readOnly}
                  height="100%"
                  className="h-full"
                />
              </div>
            )}
          </div>

          {/* Results */}
          {(validationResult || applyResult) && (
            <div className="mt-2">
              <YamlResultDisplay
                result={
                  applyResult ?? {
                    verdict: validationResult!.success ? "ok" : "failed",
                    stdout: validationResult!.stdout,
                    stderr: validationResult!.stderr,
                  }
                }
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeEditor}>
              {t("action", "close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Confirmation Dialog */}
      <Dialog open={showApplyConfirm} onOpenChange={setShowApplyConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {intercept?.title ?? t("action", "applyChangesQuestion")}
            </DialogTitle>
            {gate.notice}
            <DialogDescription>
              {t("action", "applyManifestConfirm")}
            </DialogDescription>
          </DialogHeader>

          {/* The consequence, in full, and never the provenance again. The
              mark beside the editor's title already said who applies this,
              and this dialog is a modal over that modal — so at the instant
              of the decision the mark is behind a scrim and unreadable, and
              the only thing safe to leave out is the second naming of the
              owner, which the lead sentence carries anyway. */}
          <ActionWarnings warnings={warnings} headingFor="warnUndoApply" />
          {liveMove !== null && liveMove !== "unknown" && liveMove.drifted && (
            <p
              className="min-w-0 wrap-break-word text-xs text-warn"
              data-testid="replicas-moved"
            >
              {t("action", "replicasMovedUnderEditor", {
                now: liveMove.from,
                set: liveMove.to,
              })}
            </p>
          )}

          {dryRun.data ? (
            <div className="min-w-0 py-4" data-testid="dry-run">
              <p className="mb-2 text-xs text-fg-mut">
                {t("action", "dryRunFromServer")}
              </p>
              <div className="flex flex-col gap-3">
                {dryRun.data.documents.map((doc) => (
                  <DryRunSection
                    key={doc.id}
                    doc={doc}
                    edited={editedContent}
                  />
                ))}
              </div>
            </div>
          ) : (
            // The diff is arbitrarily wide and this dialog is a grid, whose
            // items default to `min-width: auto` — without this the longest
            // line of the manifest sets the column width and everything above
            // it, warning included, is dragged off the right of the screen.
            <div className="min-w-0 py-4">
              {hasChanges && (
                <>
                  <p className="mb-2 text-xs text-fg-mut">
                    {t("action", "changesToBeApplied")}
                  </p>
                  <ScrollArea className="mb-2 h-[200px] w-full overflow-hidden rounded-md border">
                    <YamlDiffViewer
                      original={originalContent}
                      modified={editedContent}
                      height="200px"
                    />
                  </ScrollArea>
                </>
              )}
              <p
                className="text-[11px] text-fg-fnt"
                role="status"
                data-testid="dry-run-standing"
              >
                {dryRun.isError
                  ? t(
                      "action",
                      hasChanges ? "dryRunFailed" : "dryRunFailedNoDiff",
                      { error: errorToShow(dryRun.error) }
                    )
                  : t("action", "dryRunAsking")}
              </p>
            </div>
          )}

          {gate.input}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowApplyConfirm(false)}
            >
              {t("action", "cancel")}
            </Button>
            <Button
              onClick={handleApply}
              disabled={gate.blocked || refused !== null}
            >
              <Play className="mr-2 h-4 w-4" />
              {/* The intercept decides its own word where it has one — a
                  disowned label confirms with a plain "Apply", because there
                  is no consequence to override. Otherwise the rule is the
                  Scale dialog's: a warning changes the word, not the outcome. */}
              {intercept?.confirmLabel ??
                (warnings.length > 0
                  ? t("action", "applyAnyway")
                  : t("action", "apply"))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {asking.dialog}
    </>
  );
}

/**
 * One document of the dry run: what the server said it would do, and the
 * object it would store against the one it holds.
 *
 * "Would be created" and "could not read what is there" both arrive with no
 * current object, and each gets its own sentence; a refusal shows the
 * server's own words and nothing to diff, because there is nothing to diff.
 */
function DryRunSection({
  doc,
  edited,
}: {
  doc: DryRunDocument;
  /** The buffer, for the one case where the server said nothing. */
  edited: string;
}) {
  const t = useT();
  const outcome = doc.outcome;
  const tone =
    outcome.says === "refused"
      ? "text-err"
      : outcome.says === "liveUnread" || outcome.says === "unanswered"
        ? "text-warn"
        : outcome.says === "unchanged"
          ? "text-fg-fnt"
          : "text-fg";
  return (
    <section className="min-w-0" data-testid="dry-run-document">
      <p className={`text-xs ${tone}`}>
        <span className="font-mono">{doc.id}</span>{" "}
        {outcome.says === "created"
          ? t("action", "dryRunCreated")
          : outcome.says === "configured"
            ? t("action", "dryRunConfigured")
            : outcome.says === "unchanged"
              ? t("action", "dryRunUnchanged")
              : outcome.says === "liveUnread"
                ? t("action", "dryRunLiveUnread")
                : outcome.says === "unanswered"
                  ? t("action", "dryRunUnanswered")
                  : t("action", "dryRunRefused")}
      </p>
      {outcome.says === "refused" ||
      outcome.says === "liveUnread" ||
      outcome.says === "unanswered" ? (
        <p className="mt-1 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
          {outcome.said}
        </p>
      ) : null}
      {/* The sentence for an unanswered document promises the editor's own
          diff, and `would` is null there, so the block below drew nothing
          at all and the promise was empty. This is that diff. */}
      {outcome.says === "unanswered" && doc.live !== null ? (
        <ScrollArea className="mt-2 h-[200px] w-full overflow-hidden rounded-md border">
          <YamlDiffViewer
            original={doc.live}
            modified={edited}
            height="200px"
          />
        </ScrollArea>
      ) : null}
      {/* No diff where there is nothing honest to diff against. `live` is
          null both for an object that is not there and for one the read
          failed on, and against "" the whole document draws green — "this
          would all be created" — about an object that may well exist and
          be about to be overwritten. The sentence above says which case it
          is; a diff cannot. */}
      {doc.would !== null &&
      outcome.says !== "unchanged" &&
      outcome.says !== "liveUnread" ? (
        <ScrollArea className="mt-2 h-[200px] w-full overflow-hidden rounded-md border">
          <YamlDiffViewer
            original={doc.live ?? ""}
            modified={doc.would}
            height="200px"
          />
        </ScrollArea>
      ) : null}
    </section>
  );
}
