import { toast } from "@/components/ui/use-toast";
import { translate } from "@/i18n";
import { errorToShow, isUnanswered } from "@/lib/error-utils";
import { shownPath } from "@/lib/hide-paths";
import { writeToastsHeld } from "@/lib/write-hold";
import { currentLocale } from "@/stores/localeStore";
import { recordWriteFailure } from "@/stores/writeLogStore";

/** A failure on screen: our title, then the server's words without our framing. */
export function toastError(title: string, error: unknown) {
  return toast({
    title,
    description: shownPath(errorToShow(error)),
    variant: "destructive",
  });
}

/**
 * The third answer of a write, said where it is the one that came: nobody
 * answered. Not a failure, so not drawn as one, and `true` so the caller
 * does not go on to call it one.
 */
export function toastedUnanswered(error: unknown, title?: string): boolean {
  if (!isUnanswered(error)) return false;
  const locale = currentLocale();
  recordWriteFailure(
    title ?? translate(locale, "action", "writeUnanswered"),
    error
  );
  if (writeToastsHeld()) return true;
  toast({
    title: translate(locale, "action", "writeUnanswered"),
    description: translate(locale, "action", "writeUnansweredDetail", {
      said: shownPath(errorToShow(error)),
    }),
  });
  return true;
}

/** A write's failure on screen, or that nobody answered it. */
export function toastWriteError(title: string, error: unknown) {
  if (toastedUnanswered(error, title)) return;
  recordWriteFailure(title, error);
  toastError(title, error);
}
