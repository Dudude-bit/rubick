import { useCallback, useState } from "react";
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
import { useClusterStore } from "@/stores/clusterStore";
import { useYamlEditorStore, type ResourceKey } from "@/stores/yamlEditorStore";
import { AlertTriangle, Play, FileCheck, FileJson } from "lucide-react";
import { normalizeTauriError } from "@/lib/error-utils";

import { YamlEditor } from "./YamlEditor";
import { YamlEditorToolbar } from "./YamlEditorToolbar";
import { YamlDiffViewer } from "./YamlDiffViewer";
import { YamlResultDisplay } from "./YamlResultDisplay";

// Action Props
interface YamlEditorActionProps {
  title: string;
  resourceKey: ResourceKey;
  fetchYaml: () => Promise<string>;
  menuLabel?: string;
  readOnly?: boolean;
}

// Button-based action for use in headers/toolbars
export function YamlEditorAction({
  title,
  resourceKey,
  fetchYaml,
  menuLabel,
  readOnly = false,
}: YamlEditorActionProps) {
  const { toast } = useToast();
  const openEditor = useYamlEditorStore((state) => state.openEditor);

  const handleOpen = async () => {
    try {
      await openEditor({ title, resourceKey, fetchYaml, readOnly });
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to load YAML: ${error}`,
        variant: "destructive",
      });
    }
  };

  const label = menuLabel ?? (readOnly ? "View YAML" : "Edit YAML");

  return (
    <Button variant="outline" size="sm" onClick={handleOpen}>
      <FileJson className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

// DropdownMenuItem-based action for use in action menus
export function YamlEditorMenuAction({
  title,
  resourceKey,
  fetchYaml,
  menuLabel,
  readOnly = false,
}: YamlEditorActionProps) {
  const { toast } = useToast();
  const openEditor = useYamlEditorStore((state) => state.openEditor);

  const handleOpen = async () => {
    try {
      await openEditor({ title, resourceKey, fetchYaml, readOnly });
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to load YAML: ${error}`,
        variant: "destructive",
      });
    }
  };

  const label = menuLabel ?? (readOnly ? "View YAML" : "Edit YAML");

  return (
    <DropdownMenuItem onClick={handleOpen}>
      <FileJson className="mr-2 h-4 w-4" />
      {label}
    </DropdownMenuItem>
  );
}

// Main Dialog Component
export function YamlEditorDialog() {
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

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(editedContent);
    toast({
      title: "Copied",
      description: "YAML copied to clipboard.",
    });
  }, [editedContent, toast]);

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
          title: "Validation Passed",
          description: "Manifest is valid and can be applied.",
        });
      }
    } catch (error) {
      setValidationResult({
        success: false,
        stdout: "",
        stderr: normalizeTauriError(error),
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
          title: "Applied Successfully",
          description: result.stdout || "Manifest applied to cluster.",
        });
      } else {
        toast({
          title: "Apply Failed",
          description: result.stderr || "Failed to apply manifest.",
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMessage = normalizeTauriError(error);
      const errorResult = {
        success: false,
        stdout: "",
        stderr: errorMessage,
        exit_code: 1,
      };
      setApplyResult(errorResult);
      toast({
        title: "Apply Failed",
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
  ]);

  const handleFormat = useCallback(() => {
    formatYaml();
    toast({
      title: "Formatted",
      description: "YAML has been formatted.",
    });
  }, [formatYaml, toast]);

  const handleRestoreHistory = useCallback(
    (timestamp: number) => {
      restoreFromHistory(timestamp);
      toast({
        title: "Restored",
        description: "Content restored from history.",
      });
    },
    [restoreFromHistory, toast]
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
                  Unsaved Changes
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {readOnly
                ? "View the YAML manifest"
                : "Edit the YAML manifest and apply changes to the cluster"}
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
                  Validate
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
                  Apply
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
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Confirmation Dialog */}
      <Dialog open={showApplyConfirm} onOpenChange={setShowApplyConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply Changes?</DialogTitle>
            <DialogDescription>
              This will apply the manifest to your Kubernetes cluster. Make sure
              you have reviewed the changes.
            </DialogDescription>
          </DialogHeader>

          {hasChanges && (
            <div className="py-4">
              <p className="mb-2 text-xs text-fg-mut">Changes to be applied:</p>
              <ScrollArea className="h-[200px] rounded-md border">
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
              Cancel
            </Button>
            <Button onClick={handleApply}>
              <Play className="mr-2 h-4 w-4" />
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
