import type { T } from "@/i18n/useT";

export interface DownloadNotice {
  title: string;
  description: string;
  variant?: "destructive";
}

/**
 * What a log Download says, as one toast. The viewport shows one at a time,
 * so a failure toasted after the success replaced it and hid where the saved
 * files went.
 */
export function downloadNotice(
  saved: string[],
  refused: string[],
  t: T
): DownloadNotice | null {
  if (refused.length === 0) {
    if (saved.length === 0) return null;
    return {
      title: t("action", "logSaved", { n: saved.length }),
      description: saved.join("\n"),
    };
  }
  if (saved.length === 0) {
    return {
      title: t("action", "downloadFailed"),
      description: refused.join("\n"),
      variant: "destructive",
    };
  }
  return {
    title: t("action", "logsPartlySaved", {
      n: saved.length,
      total: saved.length + refused.length,
    }),
    description: [...saved, t("action", "notSaved"), ...refused].join("\n"),
    variant: "destructive",
  };
}
