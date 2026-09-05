import { useState, useMemo, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Bug, Copy, Info, AlertTriangle, Clock, Loader2 } from "lucide-react";
import type {
  DebugConfig,
  DebugOperation,
  DebugResult,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import { useToast } from "@/components/ui/use-toast";
import { cn, isK8sVersionAtLeast } from "@/lib/utils";
import { DEBUG_IMAGES } from "./constants";
import { useDebugOperation } from "@/hooks";
import { useT } from "@/i18n/useT";

/** Debug mode - frontend only, backend has separate commands for each mode */
type DebugMode = "ephemeralContainer" | "copyPod";

export interface DebugPodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  podName: string;
  namespace: string;
  containers: string[];
  /** Kubernetes version (e.g., "v1.28.0") for feature detection */
  kubernetesVersion?: string;
  onDebugStart: (result: DebugResult) => void;
}

export function DebugPodDialog({
  open,
  onOpenChange,
  podName,
  namespace,
  containers,
  kubernetesVersion,
  onDebugStart,
}: DebugPodDialogProps) {
  const t = useT();
  const { toast } = useToast();

  // Ephemeral containers require K8s 1.25+
  const supportsEphemeralContainers = useMemo(
    () => isK8sVersionAtLeast(kubernetesVersion, 1, 25),
    [kubernetesVersion]
  );

  const [mode, setMode] = useState<DebugMode>(
    supportsEphemeralContainers ? "ephemeralContainer" : "copyPod"
  );
  const [selectedImage, setSelectedImage] = useState("busybox:latest");
  const [customImage, setCustomImage] = useState("");
  const [targetContainer, setTargetContainer] = useState<string>(
    containers[0] || ""
  );
  const [shareProcesses, setShareProcesses] = useState(true);

  const image = selectedImage === "custom" ? customImage : selectedImage;
  const isImageValid = image.trim().length > 0;

  const [showTimeoutDialog, setShowTimeoutDialog] = useState(false);
  const [timeoutOperation, setTimeoutOperation] =
    useState<DebugOperation | null>(null);

  const handleReady = useCallback(
    (result: DebugResult) => {
      toast({
        title: t("action", "debugContainerReady"),
        description: t("action", "debugContainerReadyDetail", {
          container: result.containerName,
          pod: result.podName,
        }),
      });
      onDebugStart(result);
      onOpenChange(false);
    },
    [t, toast, onDebugStart, onOpenChange]
  );

  const handleError = useCallback(
    (error: string) => {
      toast({
        title: t("action", "debugFailed"),
        description: error,
        variant: "destructive",
      });
    },
    [t, toast]
  );

  const handleTimeout = useCallback((operation: DebugOperation) => {
    setTimeoutOperation(operation);
    setShowTimeoutDialog(true);
  }, []);

  const {
    state,
    operation,
    statusReason,
    elapsedSeconds,
    startEphemeral,
    startCopyPod,
    cancel,
    continueWaiting,
  } = useDebugOperation({
    onReady: handleReady,
    onError: handleError,
    onTimeout: handleTimeout,
  });

  const isPolling = state === "creating" || state === "polling";
  const timeoutSeconds = operation?.timeoutSeconds ?? 120;
  const progressPercent = Math.min(
    (elapsedSeconds / timeoutSeconds) * 100,
    100
  );

  const handleDebug = async () => {
    if (!isImageValid) {
      toast({
        title: t("action", "invalidImage"),
        description: t("action", "invalidImageDetail"),
        variant: "destructive",
      });
      return;
    }

    const config: DebugConfig = {
      image,
      targetContainer: mode === "ephemeralContainer" ? targetContainer : null,
      command: null,
      shareProcesses: mode === "copyPod" ? shareProcesses : false,
      timeoutSeconds: 120,
    };

    if (mode === "ephemeralContainer") {
      await startEphemeral(podName, namespace, config);
    } else {
      await startCopyPod(podName, namespace, config);
    }
  };

  const handleCancel = async () => {
    await cancel();
  };

  const handleDialogOpenChange = (newOpen: boolean) => {
    if (!newOpen && isPolling) {
      // Don't close during polling - user must explicitly cancel
      return;
    }
    onOpenChange(newOpen);
  };

  // Timeout dialog handlers
  const handleKeepWaiting = () => {
    setShowTimeoutDialog(false);
    setTimeoutOperation(null);
    continueWaiting();
  };

  const handleDeletePod = async () => {
    if (timeoutOperation) {
      try {
        await commands.deleteDebugPod(
          timeoutOperation.podName,
          timeoutOperation.namespace
        );
        toast({
          title: t("action", "debugPodDeleted"),
          description: t("action", "podDeletedDetail", {
            pod: timeoutOperation.podName,
          }),
        });
      } catch (err) {
        toast({
          title: t("action", "failedToDeletePod"),
          description: String(err),
          variant: "destructive",
        });
      }
    }
    setShowTimeoutDialog(false);
    setTimeoutOperation(null);
    onOpenChange(false);
  };

  const handleLeave = () => {
    setShowTimeoutDialog(false);
    setTimeoutOperation(null);
    onOpenChange(false);
  };

  if (showTimeoutDialog && timeoutOperation) {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warn" />
              {t("action", "containerNotReady")}
            </DialogTitle>
            <DialogDescription>
              {t("action", "debugContainerInPod")}{" "}
              <span className="font-mono text-fg">
                {timeoutOperation.podName}
              </span>{" "}
              {t("action", "didNotBecomeReady")}
            </DialogDescription>
          </DialogHeader>

          {statusReason && (
            <div className="flex items-center gap-2 border-t border-hair pt-2 text-xs">
              <Clock className="h-3.5 w-3.5 flex-none text-fg-fnt" />
              <span className="text-fg-mut">{t("action", "lastStatus")}</span>
              <span className="ml-auto font-mono text-fg">{statusReason}</span>
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={handleLeave}>
              {t("action", "leave")}
            </Button>
            <Button variant="destructive" onClick={handleDeletePod}>
              {t("action", "deletePod")}
            </Button>
            <Button onClick={handleKeepWaiting}>
              {t("action", "keepWaiting")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Render polling UI
  if (isPolling) {
    return (
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-fg-fnt" />
              {state === "creating"
                ? t("action", "creatingDebugContainer")
                : t("action", "waitingForContainer")}
            </DialogTitle>
            <DialogDescription>
              {t("action", "debugContainerForPod")}{" "}
              <span className="font-mono text-fg">{podName}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 border-t border-hair pt-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-fg-mut">{t("columns", "status")}</span>
              <span className="font-mono text-fg">
                {statusReason || t("action", "initializing")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-fg-mut">{t("action", "elapsed")}</span>
              <span className="font-mono text-fg">
                {elapsedSeconds}s <span className="text-fg-fnt">/</span>{" "}
                {timeoutSeconds}s
              </span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-sm bg-sel">
              <div
                className="h-full bg-info"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              {t("action", "cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Render main configuration dialog
  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="h-4 w-4 text-fg-fnt" />
            {t("action", "debugPodTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("action", "debugPodPrefix")}{" "}
            <span className="font-mono text-fg">{podName}</span>{" "}
            {t("action", "inNamespace")}{" "}
            <span className="font-mono text-fg">{namespace}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Debug Mode Selection */}
          <div className="space-y-3">
            <Label>{t("action", "debugMode")}</Label>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as DebugMode)}
              className="grid gap-2"
            >
              <div
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-1.5",
                  supportsEphemeralContainers
                    ? "cursor-pointer hover:bg-hover"
                    : "cursor-not-allowed opacity-50"
                )}
              >
                <RadioGroupItem
                  value="ephemeralContainer"
                  id="ephemeral"
                  disabled={!supportsEphemeralContainers}
                />
                <Label
                  htmlFor="ephemeral"
                  className={cn(
                    "flex-1",
                    supportsEphemeralContainers
                      ? "cursor-pointer"
                      : "cursor-not-allowed"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Bug className="h-3.5 w-3.5 text-fg-fnt" />
                    <span className="font-medium text-fg">
                      {t("action", "ephemeralContainerMode")}
                    </span>
                    {!supportsEphemeralContainers && (
                      <span className="text-[11px] text-fg-fnt">
                        (K8s 1.25+)
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-fg-mut">
                    {t("action", "ephemeralModeHint")}
                  </p>
                </Label>
              </div>
              <div className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
                <RadioGroupItem value="copyPod" id="copy" />
                <Label htmlFor="copy" className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Copy className="h-3.5 w-3.5 text-fg-fnt" />
                    <span className="font-medium text-fg">
                      {t("action", "copyPodMode")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-fg-mut">
                    {t("action", "copyPodModeHint")}
                  </p>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Debug Image Selection */}
          <div className="space-y-2">
            <Label htmlFor="debug-image">{t("action", "debugImage")}</Label>
            <Select value={selectedImage} onValueChange={setSelectedImage}>
              <SelectTrigger>
                <SelectValue placeholder={t("action", "selectDebugImage")} />
              </SelectTrigger>
              <SelectContent>
                {DEBUG_IMAGES.map((img) => (
                  <SelectItem key={img.value} value={img.value}>
                    {t("action", img.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedImage === "custom" && (
              <Input
                placeholder={t("action", "customImagePlaceholder")}
                value={customImage}
                onChange={(e) => setCustomImage(e.target.value)}
              />
            )}
          </div>

          {/* Target Container (for ephemeral mode) */}
          {mode === "ephemeralContainer" && containers.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="target-container">
                {t("action", "targetContainer")}
              </Label>
              <Select
                value={targetContainer}
                onValueChange={setTargetContainer}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("action", "selectTargetContainer")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {containers.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-fg-mut">
                {t("action", "targetContainerHint")}
              </p>
            </div>
          )}

          {/* Share Process Namespace (for copy mode) */}
          {mode === "copyPod" && (
            <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
              <div className="space-y-0.5">
                <Label htmlFor="share-processes">
                  {t("action", "shareProcessNamespace")}
                </Label>
                <p className="text-[11px] text-fg-mut">
                  {t("action", "shareProcessNamespaceHint")}
                </p>
              </div>
              <Switch
                id="share-processes"
                checked={shareProcesses}
                onCheckedChange={setShareProcesses}
              />
            </div>
          )}

          {/* Info about ephemeral containers support */}
          {!supportsEphemeralContainers && (
            <p className="flex items-start gap-2 border-t border-hair pt-2 text-[11px] text-fg-mut">
              <Info className="mt-px h-3.5 w-3.5 flex-none text-fg-fnt" />
              {t("action", "ephemeralUnsupported", {
                version: kubernetesVersion || t("action", "unknownVersion"),
              })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button onClick={handleDebug} disabled={!isImageValid}>
            {t("action", "startDebug")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
