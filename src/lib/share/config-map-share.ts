import { KeyRound } from "lucide-react";

import type { BinaryValue } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import { formatBytes } from "@/lib/k8s-quantity";
import { ORDER, type PlacedSection } from "@/lib/report-parts";

function byteSize(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface ConfigMapDataQuery {
  values?: Record<string, string>;
  withheld?: Record<string, string>;
  binary?: Record<string, BinaryValue>;
}

/**
 * Key names and a byte count only: a ConfigMap key routinely holds a
 * password baked into an app.ini, so its value never reaches the file.
 */
export function configMapKeysSection(
  dataKeys: string[],
  query: { data: ConfigMapDataQuery | undefined; error: unknown },
  t: T
): PlacedSection {
  const unread = query.error
    ? t("share", "clDataUnread", { reason: errorToShow(query.error) })
    : query.data === undefined
      ? t("share", "stillReading")
      : null;
  return {
    id: "configmap-keys",
    order: ORDER.own,
    title: t("share", "clSectionKeys"),
    icon: iconSvg(KeyRound),
    count: dataKeys.length,
    unread,
    body: {
      type: "table",
      columns: [t("share", "clKeyColumn"), t("share", "clSizeColumn")],
      rows: dataKeys.map((key) => {
        const reason = query.data?.withheld?.[key];
        const binary = query.data?.binary?.[key];
        const value = query.data?.values?.[key];
        const size =
          reason !== undefined
            ? { text: reason, quiet: true }
            : binary !== undefined
              ? { text: formatBytes(binary.bytes) }
              : value !== undefined
                ? { text: formatBytes(byteSize(value)) }
                : { text: "–", quiet: true };
        return { cells: [{ text: key, mono: true }, size] };
      }),
      more: null,
    },
  };
}
