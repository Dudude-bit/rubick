import { Link, useRouter, useRouterState } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { clusterLink, clusterOf } from "@/lib/links";

/**
 * An address the route tree does not have. Only that: an object that is not
 * in the cluster and one that could not be read are the pages' own answers,
 * and neither ever lands here.
 */
export function NotFoundPage() {
  const t = useT();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const cluster = clusterOf(pathname);
  return (
    <EmptyPage
      title={t("empty", "addressMissing")}
      body={t("empty", "addressMissingBody", { path: pathname })}
    >
      {router.history.canGoBack() && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.history.back()}
        >
          {t("action", "back")}
        </Button>
      )}
      <Button variant="outline" size="sm" asChild>
        {cluster ? (
          <Link {...clusterLink(cluster)}>{t("empty", "toOverview")}</Link>
        ) : (
          <Link to="/">{t("empty", "toClusters")}</Link>
        )}
      </Button>
    </EmptyPage>
  );
}

export function EmptyPage({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full justify-center px-6 py-12">
      <div className="w-full max-w-[420px]">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
        <p className="mt-[3px] text-xs text-fg-mut">{body}</p>
        {children && <div className="mt-4 flex gap-2">{children}</div>}
      </div>
    </div>
  );
}
