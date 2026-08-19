import { useState, useCallback } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Server, Clock, Loader2 } from "lucide-react";
import type {
  DebugConfig,
  DebugOperation,
  DebugResult,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import { useToast } from "@/components/ui/use-toast";
import { DEBUG_IMAGES } from "./constants";
import { useDebugOperation } from "@/hooks";
import { Progress } from "@/components/ui/progress";
import { useT } from "@/i18n/useT";

export interface DebugNodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeName: string;
  onDebugStart: (result: DebugResult) => void;
}

export function DebugNodeDialog({
  open,
  onOpenChange,
  nodeName,
  onDebugStart,
}: DebugNodeDialogProps) {
  const t = useT();
  const { toast } = useToast();
  const [selectedImage, setSelectedImage] = useState("busybox:latest");
  const [customImage, setCustomImage] = useState("");
  const [namespace, setNamespace] = useState("default");

  const image = selectedImage === "custom" ? customImage : selectedImage;
  const isImageValid = image.trim().length > 0;

  // Timeout dialog state
  const [showTimeoutDialog, setShowTimeoutDialog] = useState(false);
  const [timeoutOperation, setTimeoutOperation] =
    useState<DebugOperation | null>(null);

  const handleReady = useCallback(
    (result: DebugResult) => {
      toast({
        title: t("action", "debugPodReady"),
        description: t("action", "debugPodReadyDetail", {
          pod: result.podName,
          node: nodeName,
        }),
      });
      onDebugStart(result);
      onOpenChange(false);
    },
    [toast, nodeName, onDebugStart, onOpenChange, t]
  );

  const handleError = useCallback(
    (error: string) => {
      toast({
        title: t("action", "debugFailed"),
        description: error,
        variant: "destructive",
      });
    },
    [toast, t]
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
    startNodeDebug,
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
      targetContainer: null,
      command: null,
      shareProcesses: false,
      timeoutSeconds: 120,
    };

    await startNodeDebug(nodeName, namespace, config);
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

  // Render timeout dialog
  if (showTimeoutDialog && timeoutOperation) {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warn" />
              {t("action", "debugPodNotReady")}
            </DialogTitle>
            <DialogDescription>
              {t("action", "theDebugPod")}{" "}
              <span className="font-medium">{timeoutOperation.podName}</span>{" "}
              {t("action", "onNode")}{" "}
              <span className="font-medium">{nodeName}</span>{" "}
              {t("action", "didNotBecomeReady")}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {statusReason && (
              <div className="rounded-md border border-hair p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-3.5 w-3.5 text-fg-fnt" />
                  <span className="text-fg-mut">
                    {t("action", "lastStatus")}:
                  </span>
                  <span className="font-medium">{statusReason}</span>
                </div>
              </div>
            )}
          </div>

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
              <Loader2 className="h-5 w-5 animate-spin" />
              {state === "creating"
                ? t("action", "creatingDebugPod")
                : t("action", "waitingForPod")}
            </DialogTitle>
            <DialogDescription>
              {t("action", "debugPodPrefix")} {t("action", "onNode")}{" "}
              <span className="font-medium">{nodeName}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Status */}
            <div className="rounded-md border border-hair p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-fg-mut">{t("columns", "status")}</span>
                <span className="font-medium">
                  {statusReason || t("action", "initializing")}
                </span>
              </div>
            </div>

            {/* Progress */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-fg-mut">{t("action", "elapsed")}</span>
                <span className="font-medium">
                  {elapsedSeconds}s / {timeoutSeconds}s
                </span>
              </div>
              <Progress value={progressPercent} className="h-2" />
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
            <Server className="h-5 w-5" />
            {t("action", "debugNode")}
          </DialogTitle>
          <DialogDescription>
            {t("action", "createPrivilegedDebugPodOnNode")}{" "}
            <span className="font-medium">{nodeName}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Node Info */}
          <div className="rounded-md border border-hair p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg-mut">{t("action", "targetNode")}</span>
              <span className="font-medium">{nodeName}</span>
            </div>
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
                    {img.label}
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

          {/* Namespace for debug pod */}
          <div className="space-y-2">
            <Label htmlFor="namespace">
              {t("action", "debugPodNamespace")}
            </Label>
            <Input
              id="namespace"
              placeholder="default"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
            />
            <p className="text-xs text-fg-mut">
              {t("action", "debugPodNamespaceHint")}
            </p>
          </div>

          {/* Warning about privileged access */}
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t("action", "debugNodeWarningPre")}{" "}
              <strong>{t("action", "privilegedPod")}</strong>{" "}
              {t("action", "debugNodeWarningPost")}{" "}
              <code className="rounded bg-hover px-1">/host</code>.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button
            onClick={handleDebug}
            disabled={!isImageValid}
            variant="destructive"
          >
            {t("action", "startDebug")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
