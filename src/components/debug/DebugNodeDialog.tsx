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
        title: "Debug pod ready",
        description: `Debug pod "${result.podName}" created on node "${nodeName}"`,
      });
      onDebugStart(result);
      onOpenChange(false);
    },
    [toast, nodeName, onDebugStart, onOpenChange]
  );

  const handleError = useCallback(
    (error: string) => {
      toast({
        title: "Debug failed",
        description: error,
        variant: "destructive",
      });
    },
    [toast]
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
        title: "Invalid image",
        description: "Please select or enter a valid debug image",
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
          title: "Debug pod deleted",
          description: `Pod "${timeoutOperation.podName}" has been deleted`,
        });
      } catch (err) {
        toast({
          title: "Failed to delete pod",
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
              Debug Pod Not Ready
            </DialogTitle>
            <DialogDescription>
              The debug pod{" "}
              <span className="font-medium">{timeoutOperation.podName}</span> on
              node <span className="font-medium">{nodeName}</span> did not
              become ready within the timeout period.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {statusReason && (
              <div className="rounded-md border border-hair p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-3.5 w-3.5 text-fg-fnt" />
                  <span className="text-fg-mut">Last status:</span>
                  <span className="font-medium">{statusReason}</span>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={handleLeave}>
              Leave
            </Button>
            <Button variant="destructive" onClick={handleDeletePod}>
              Delete Pod
            </Button>
            <Button onClick={handleKeepWaiting}>Keep Waiting</Button>
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
                ? "Creating debug pod..."
                : "Waiting for pod..."}
            </DialogTitle>
            <DialogDescription>
              Debug pod on node <span className="font-medium">{nodeName}</span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Status */}
            <div className="rounded-md border border-hair p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-fg-mut">Status</span>
                <span className="font-medium">
                  {statusReason || "Initializing..."}
                </span>
              </div>
            </div>

            {/* Progress */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-fg-mut">Elapsed</span>
                <span className="font-medium">
                  {elapsedSeconds}s / {timeoutSeconds}s
                </span>
              </div>
              <Progress value={progressPercent} className="h-2" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              Cancel
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
            Debug Node
          </DialogTitle>
          <DialogDescription>
            Create a privileged debug pod on node{" "}
            <span className="font-medium">{nodeName}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Node Info */}
          <div className="rounded-md border border-hair p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-fg-mut">Target Node</span>
              <span className="font-medium">{nodeName}</span>
            </div>
          </div>

          {/* Debug Image Selection */}
          <div className="space-y-2">
            <Label htmlFor="debug-image">Debug Image</Label>
            <Select value={selectedImage} onValueChange={setSelectedImage}>
              <SelectTrigger>
                <SelectValue placeholder="Select debug image" />
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
                placeholder="Enter custom image (e.g., myregistry/debug:latest)"
                value={customImage}
                onChange={(e) => setCustomImage(e.target.value)}
              />
            )}
          </div>

          {/* Namespace for debug pod */}
          <div className="space-y-2">
            <Label htmlFor="namespace">Debug Pod Namespace</Label>
            <Input
              id="namespace"
              placeholder="default"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
            />
            <p className="text-xs text-fg-mut">
              Namespace where the debug pod will be created
            </p>
          </div>

          {/* Warning about privileged access */}
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This will create a <strong>privileged pod</strong> with full
              access to the host. The host filesystem will be mounted at{" "}
              <code className="rounded bg-hover px-1">/host</code>.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleDebug}
            disabled={!isImageValid}
            variant="destructive"
          >
            Start Debug
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
