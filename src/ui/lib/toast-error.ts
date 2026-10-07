import { toast } from "@/components/ui/use-toast";
import { errorToShow } from "@/lib/error-utils";
import { shownPath } from "@/lib/hide-paths";

/** A failure on screen: our title, then the server's words without our framing. */
export function toastError(title: string, error: unknown) {
  return toast({
    title,
    description: shownPath(errorToShow(error)),
    variant: "destructive",
  });
}
