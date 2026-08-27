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

import { useCallback, useMemo, useState } from "react";
import { commands } from "@/lib/commands";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { Spinner } from "@/components/ui/spinner";
import { ActionWarnings } from "@/components/resources/action-warnings";
import { DeliveryMarks } from "@/components/resources/delivery";
import { DetailAction } from "@/components/resources/detail-blocks";
import { useConnections } from "@/hooks/useConnections";
import { useDelivery } from "@/hooks/useDelivery";
import { deliveryApplyIntercept, deliveryOfManifest } from "@/lib/delivery";
import { applyWarnings, changesReplicaCount } from "@/lib/governance";
import { useClusterStore } from "@/stores/clusterStore";
import { useYamlEditorStore, type ResourceKey } from "@/stores/yamlEditorStore";
import { AlertTriangle, Play, FileCheck, FileJson } from "lucide-react";
import { errorToShow } from "@/lib/error-utils";

import { YamlEditor } from "./YamlEditor";
import { YamlEditorToolbar } from "./YamlEditorToolbar";
import { YamlDiffViewer } from "./YamlDiffViewer";
import { YamlResultDisplay } from "./YamlResultDisplay";
import { useT } from "@/i18n/useT";

// Action Props
interface YamlEditorActionProps {
  title: string;
  resourceKey: ResourceKey;
  fetchYaml: () => Promise<string>;
  menuLabel?: string;
  readOnly?: boolean;
}

/** Open it, and say why if it will not open. Shared by both affordances. */
function useOpenEditor({
  title,
  resourceKey,
  fetchYaml,
  readOnly = false,
}: YamlEditorActionProps) {
  const t = useT();
  const { toast } = useToast();
  const openEditor = useYamlEditorStore((state) => state.openEditor);

  return async () => {
    try {
      await openEditor({ title, resourceKey, fetchYaml, readOnly });
    } catch (error) {
      toast({
        title: t("empty", "couldNotReadManifest"),
        description: errorToShow(error),
        variant: "destructive",
      });
    }
  };
}

const editorLabel = (
  t: ReturnType<typeof useT>,
  { menuLabel, readOnly }: YamlEditorActionProps
) => menuLabel ?? t("action", readOnly ? "viewYaml" : "editYaml");

// Button-based action for use in headers/toolbars
export function YamlEditorAction(props: YamlEditorActionProps) {
  const t = useT();
  const open = useOpenEditor(props);
  return (
    <DetailAction
      label={editorLabel(t, props)}
      icon={FileJson}
      onClick={open}
    />
  );
}

// DropdownMenuItem-based action for use in action menus
export function YamlEditorMenuAction(props: YamlEditorActionProps) {
  const t = useT();
  const open = useOpenEditor(props);
  return (
    <DropdownMenuItem onClick={open}>
      <FileJson className="mr-2 h-4 w-4" />
      {editorLabel(t, props)}
    </DropdownMenuItem>
  );
}

// Main Dialog Component
export function YamlEditorDialog() {
  const t = useT();
  const { toast } = useToast();
  const currentNamespace = useClusterStore((state) => state.currentNamespace);

  const {
    open,
    title,
    resourceKey,
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

  // The autoscaler owns `spec.replicas` and nothing else, so it is asked
  // about only when that field is what moved — see `applyWarnings`. Asked
  // while the editor is open rather than when the confirmation appears, so
  // the sentence is already there when the reader gets to it; the query key
  // is the detail page's, so a page that has read its connections pays
  // nothing.
  const replicasMoved =
    !readOnly &&
    hasChanges &&
    changesReplicaCount(originalContent, editedContent);
  const governance = useConnections(
    resourceKey?.kind ?? "",
    resourceKey?.name,
    resourceKey?.namespace ?? null,
    open && replicasMoved
  );

  const warnings = applyWarnings(governance.data, intercept, replicasMoved, t);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(editedContent);
    toast({
      title: t("action", "copied"),
      description: t("action", "yamlCopiedToClipboard"),
    });
  }, [editedContent, toast, t]);

  const handleValidate = useCallback(async () => {
    setIsValidating(true);
    setValidationResult(null);

    try {
      const result = await commands.validateManifest(
        editedContent,
        resourceKey?.namespace || currentNamespace || null
      );
      setValidationResult(result);

      if (result.success) {
        toast({
          title: t("action", "validationPassed"),
          description: t("action", "manifestIsValid"),
        });
      }
    } catch (error) {
      setValidationResult({
        success: false,
        stdout: "",
        stderr: errorToShow(error),
        exit_code: 1,
      });
    } finally {
      setIsValidating(false);
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
    setShowApplyConfirm(false);
    setIsApplying(true);
    setApplyResult(null);

    try {
      const result = await commands.applyManifest(
        editedContent,
        resourceKey?.namespace || currentNamespace || null
      );
      setApplyResult(result);

      if (result.success) {
        addHistoryEntry(editedContent, "Applied");

        toast({
          title: t("action", "applySucceeded"),
          description: result.stdout || t("action", "manifestApplied"),
        });
      } else {
        toast({
          title: t("action", "applyFailed"),
          description: result.stderr || t("action", "failedToApplyManifest"),
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMessage = errorToShow(error);
      const errorResult = {
        success: false,
        stdout: "",
        stderr: errorMessage,
        exit_code: 1,
      };
      setApplyResult(errorResult);
      toast({
        title: t("action", "applyFailed"),
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
    }
  }, [
    editedContent,
    resourceKey,
    currentNamespace,
    setIsApplying,
    setApplyResult,
    addHistoryEntry,
    toast,
    t,
  ]);

  const handleFormat = useCallback(() => {
    formatYaml();
    toast({
      title: t("action", "formatted"),
      description: t("action", "yamlFormatted"),
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
                  disabled={isLoading || isValidating || isApplying}
                >
                  {isValidating ? (
                    <Spinner size="sm" className="mr-2" />
                  ) : (
                    <FileCheck className="mr-2 h-4 w-4" />
                  )}
                  {t("action", "validate")}
                </Button>

                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setShowApplyConfirm(true)}
                  disabled={isLoading || isValidating || isApplying}
                >
                  {isApplying ? (
                    <Spinner size="sm" className="mr-2" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  {t("action", "apply")}
                </Button>
              </div>
            )}
          </div>

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
              <YamlResultDisplay result={applyResult || validationResult!} />
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

          {hasChanges && (
            // The diff is arbitrarily wide and this dialog is a grid, whose
            // items default to `min-width: auto` — without this the longest
            // line of the manifest sets the column width and everything above
            // it, warning included, is dragged off the right of the screen.
            <div className="min-w-0 py-4">
              <p className="mb-2 text-xs text-fg-mut">
                {t("action", "changesToBeApplied")}
              </p>
              <ScrollArea className="h-[200px] w-full overflow-hidden rounded-md border">
                <YamlDiffViewer
                  original={originalContent}
                  modified={editedContent}
                  height="200px"
                />
              </ScrollArea>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowApplyConfirm(false)}
            >
              {t("action", "cancel")}
            </Button>
            <Button onClick={handleApply}>
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
    </>
  );
}
