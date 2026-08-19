import { useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Terminal } from "./Terminal";
import { commands } from "@/lib/commands";
import { useT } from "@/i18n/useT";

export interface AuthTerminalProps {
  open: boolean;
  onClose: () => void;
  authSessionId: string;
  terminalSessionId: string;
  context: string;
  command: string;
}

/**
 * AuthTerminal - Modal dialog with terminal for interactive authentication
 * Used when kubectl exec auth requires terminal input (e.g., password prompts)
 */
export function AuthTerminal({
  open,
  onClose,
  authSessionId,
  terminalSessionId,
  context,
  command,
}: AuthTerminalProps) {
  const t = useT();
  const handleClose = useCallback(() => {
    // Cancel the auth session when user closes the dialog
    commands.cancelAuthSession(authSessionId).catch((e) => {
      console.error("Failed to cancel auth session:", e);
    });
    onClose();
  }, [authSessionId, onClose]);

  const handleTerminalClose = useCallback(() => {
    // Terminal session ended (process exited)
    // The backend will send AuthFlowCompleted or AuthFlowCancelled event
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-4xl h-[600px] flex flex-col p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>{t("action", "authenticationRequired")}</DialogTitle>
          <DialogDescription>
            {t("action", "contextLabel")}{" "}
            <span className="font-mono">{context}</span>
            {command && (
              <>
                <br />
                {t("action", "commandLabel")}{" "}
                <span className="font-mono text-xs">{command}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 px-6 pb-6 overflow-hidden">
          <Terminal
            sessionId={terminalSessionId}
            metadata={{
              title: t("action", "authentication"),
              subtitle: context,
            }}
            onClose={handleTerminalClose}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
