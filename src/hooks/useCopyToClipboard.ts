import { useCallback } from "react";
import { useToast } from "@/components/ui/use-toast";
import { useT } from "@/i18n/useT";
import { toastError } from "@/lib/toast-error";

/**
 * Hook for copying text to clipboard with toast notification
 *
 * @returns A callback function that copies text to clipboard and shows a toast notification
 * @example
 * ```tsx
 * const copyToClipboard = useCopyToClipboard();
 * copyToClipboard("Hello World", "Text copied!");
 * ```
 */
export function useCopyToClipboard() {
  const { toast } = useToast();
  const t = useT();

  return useCallback(
    async (text: string, successMessage = t("action", "copiedToClipboard")) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("action", "copied"),
          description: successMessage,
        });
      } catch (error) {
        toastError(t("action", "copyFailed"), error);
      }
    },
    [toast, t]
  );
}
