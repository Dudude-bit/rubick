/**
 * Sentences with two counts in them. A catalogue plural picks one form by
 * `n`, so the second count's noun has to be its own plural — "1 из 1 хостов"
 * and "4 alerts firing across 1 rule objects" were the second count wearing
 * the first one's form.
 */
import type { T } from "@/i18n/useT";

export const hostsNeedAttention = (n: number, total: number, t: T) =>
  t("count", "hostsNeedAttention", {
    n,
    of: t("count", "ofHosts", { n: total }),
  });

export const hostsBrokenOfTotal = (n: number, total: number, t: T) =>
  t("count", "hostsBrokenOfTotal", {
    n,
    of: t("count", "ofHosts", { n: total }),
  });

export const applicationsNeedAttention = (n: number, total: number, t: T) =>
  t("count", "applicationsNeedAttention", {
    n,
    of: t("count", "ofApplications", { n: total }),
  });

export const valuesCopiedWithBinary = (n: number, binary: number, t: T) =>
  t("count", "valuesCopiedWithBinary", {
    n,
    binary: t("count", "binaryValues", { n: binary }),
  });
