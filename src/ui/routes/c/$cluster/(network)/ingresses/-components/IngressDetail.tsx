import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Info, Lock, Route, Tag } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { DeleteAction } from "../../../-object/DeleteAction";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { countMark, viewGlyph } from "@/components/object/detail-tab";
import { ResourceRef } from "@/components/object/ResourceRef";
import {
  KeyValueList,
  KeyValueSection,
  type KeyValue,
} from "../../../-object/detail-kv";
import { recordToKeyValues, TONE_CLASS } from "@/components/object/key-values";
import { CertificateLine } from "../../../-object/CertificateFacts";
import { IssuanceSection } from "@/components/object/IssuanceChain";
import { TrafficChain } from "../../../-object/TrafficChain";
import { ChainWatches } from "../../../-object/ChainWatches";
import { IngressHealthView, TlsFactText } from "../../../-object/health-views";
import { connectionsTab } from "../../../-object/connections-tab";
import { useOneIngressHealth } from "@/hooks/useIngressHealth";
import { useResourceDetail } from "@/hooks";
import { Link } from "@tanstack/react-router";
import { useChainAnswer } from "@/hooks/useChainAnswer";
import { useIngressShare } from "./useIngressShare";
import { IngressAccess } from "./IngressAccess";
import { generateAccessUrls } from "./access-urls";
import { useProxyBehind } from "@/hooks/useServiceRoutes";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { expiryText } from "@/lib/certificates";
import { TLS_NOT_CHECKED_TONE } from "../../-components";
import { useIngressTlsFact } from "../../../-object/ingress-tls-fact";
import { deliveryOfKind } from "@/lib/delivery";
import {
  ingressAddressOf,
  ingressClassWords,
  INGRESS_ADDRESS_WORDS,
} from "@/lib/ingress-health";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { normalizeTauriError } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import type { IngressInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function IngressDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: ingress,
    isLoading,
    error,
    yaml: ingressYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
    deleteMutation,
  } = useResourceDetail<IngressInfo>({
    resourceKind: ResourceType.Ingress,
    fetchResource: async (name, ns) => {
      try {
        return await commands.getIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    deleteResource: async (name, ns) => {
      try {
        await commands.deleteIngress(name, ns);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    defaultTab: "overview",
  });

  const rules = ingress?.rules ?? [];
  const fallback = ingress?.defaultBackend ?? null;
  // Whether the default backend is some vendor's own proxy — a door, not a
  // dead end, and the sign on it comes from whichever vendor owns it.
  const behind = useProxyBehind(
    ingress && fallback?.backendService
      ? { namespace: ingress.namespace, name: fallback.backendService }
      : null
  );
  const tlsConfigs = ingress?.tlsConfigs ?? [];
  const loadBalancerIps = ingress?.loadBalancerIps ?? [];
  const {
    tls,
    fact: tlsFact,
    vendor,
    tlsOf,
    certificates,
    secretNames: tlsSecretNames,
    soonest,
    missing,
  } = useIngressTlsFact(ingress);
  const accessUrls = generateAccessUrls(
    rules,
    ingress?.tlsHosts ?? [],
    t("empty", "allHosts"),
    tlsOf
  );

  const chain = useChainAnswer(ResourceType.Ingress, name, namespace);
  const connections = chain.read;
  const issuance = useCertificateIssuance(
    ingress?.namespace ?? namespace,
    tlsSecretNames
  );

  // Which controller claims this Ingress. Core: IngressClass is a built-in
  // kind, and "none does" is the failure that is silent everywhere else.
  const { data: controller } = useQuery({
    queryKey: queryKeys.ingressClass(ingress?.className),
    queryFn: () => commands.resolveIngressClass(ingress?.className ?? null),
    enabled: !!ingress,
  });
  const address = ingressAddressOf({ loadBalancerIps }, controller);
  const health = useOneIngressHealth(ingress);

  const share = useIngressShare(ingress, controller, {
    tls: tlsFact,
    certificates,
  });

  const events = useObjectEvents(ResourceType.Ingress, name, namespace, {
    refresh: "overview",
  });

  const classWords = ingressClassWords(
    ingress?.className ?? null,
    controller,
    t
  );
  const facts: KeyValue[] = [
    {
      label: t("columns", "status"),
      value: ingress ? <IngressHealthView ingress={ingress} /> : null,
    },
    {
      // The class is a request; the controller is who answers it. Naming
      // only the request is how an Ingress nothing serves reads as fine.
      label: t("columns", "class"),
      value: classWords.text,
      mono: !!ingress?.className,
      tone: classWords.tone ?? undefined,
    },
    {
      label: t("columns", "loadBalancer"),
      // "Pending" only where a controller serves the class and can assign
      // one; beside "nothing serves this class" it promised an address that
      // will not come.
      value:
        address === "assigned" ? (
          <CopyableAddresses
            values={loadBalancerIps}
            label={t("columns", "ingressAddress")}
          />
        ) : (
          t("empty", INGRESS_ADDRESS_WORDS[address].key)
        ),
      tone:
        address === "assigned"
          ? undefined
          : (INGRESS_ADDRESS_WORDS[address].tone ?? undefined),
    },
    { label: t("columns", "rules"), value: rules.length, mono: true },
    { label: t("columns", "paths"), value: accessUrls.length, mono: true },
    {
      label: "TLS",
      value: <TlsFactText fact={tlsFact} />,
    },
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.Ingress, ingress);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection title="Ingress" items={facts} className="max-w-lg" />

          <TrafficChain
            query={connections}
            certificates={certificates}
            issuance={issuance}
            controller={controller}
          />
        </>
      ),
    },
    {
      id: "access",
      label: t("nav", "access"),
      glyph: viewGlyph(ExternalLink),
      content: (
        <IngressAccess
          ingress={ingress}
          urls={accessUrls}
          health={health}
          plainWhy={vendor?.plainWhy ?? null}
        />
      ),
    },
    connectionsTab(connections, t, deliveryQuery),
    {
      id: "rules",
      label: t("columns", "rules"),
      glyph: viewGlyph(Route),
      mark: countMark(rules.length),
      content: (
        <Section>
          <SectionHeader
            title={t("columns", "rules")}
            count={t("count", "hosts", { n: rules.length })}
          />
          {rules.length === 0 ? (
            fallback?.backendService ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-fg-mut">
                  {t("empty", "ingressDefaultBackendOnly")}{" "}
                  <ResourceRef
                    kind={ResourceType.Service}
                    name={fallback.backendService}
                    namespace={ingress?.namespace}
                    showKind={false}
                  />
                  <span className="font-mono text-fg-fnt">
                    :{fallback.backendPort}
                  </span>
                </p>
                {behind && (
                  <p className="max-w-[80ch] text-[11px] text-fg-fnt">
                    {t("count", "ingressProxyHosts", {
                      vendor: behind.vendor,
                      n: behind.hosts,
                    })}{" "}
                    <Link
                      {...behind.to}
                      className="text-info underline-offset-2 hover:underline"
                    >
                      {t("empty", "itsPage")}
                    </Link>
                    .
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-fg-fnt">
                {t("empty", "ingressNoRulesNoDefault")}
              </p>
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Backend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule, ruleIdx) => {
                  const isWildcard = rule.host === "*" || !rule.host;
                  const covered = tlsOf(rule.host);
                  return [
                    // The host is context for the paths under it, so it is
                    // said once above them instead of on every row.
                    <TableRow
                      key={`host-${ruleIdx}`}
                      data-quiet
                      className="border-0"
                    >
                      <TableCell
                        colSpan={3}
                        className="px-2.5 pb-1 pt-3 text-[11px] text-fg-fnt"
                      >
                        <span className="font-mono text-fg-mut">
                          {isWildcard ? t("empty", "allHosts") : rule.host}
                        </span>
                        {covered === false && (
                          <span className="text-warn">
                            {" "}
                            · {t("empty", "noTls")}
                          </span>
                        )}
                        {covered === null && (
                          <span> · {t("empty", "tlsNotChecked")}</span>
                        )}
                      </TableCell>
                    </TableRow>,
                    ...rule.paths.map((path) => (
                      <TableRow key={`${ruleIdx}-${path.path}`} data-quiet>
                        <TableCell className="font-mono text-fg">
                          {path.path}
                        </TableCell>
                        <TableCell className="text-fg-fnt">
                          {path.pathType}
                        </TableCell>
                        <TableCell>
                          {path.resourceBackend ? (
                            <span className="font-mono text-fg-mut">
                              {path.resourceBackend}
                            </span>
                          ) : path.backendService ? (
                            <>
                              <ResourceRef
                                kind={ResourceType.Service}
                                name={path.backendService}
                                namespace={ingress?.namespace}
                                showKind={false}
                              />
                              <span className="font-mono text-fg-fnt">
                                :{path.backendPort}
                              </span>
                            </>
                          ) : (
                            <span className="text-warn">
                              {t("empty", "noBackend")}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    )),
                  ];
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "tls",
      label: "TLS",
      glyph: viewGlyph(Lock),
      content: (
        <Section>
          <SectionHeader title="TLS" count={tlsConfigs.length || undefined} />
          {tlsConfigs.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              {t("empty", "noTlsConfigured")}
            </p>
          ) : (
            <KeyValueList
              items={tlsConfigs.map((config) => ({
                // The certificate lives in a Secret in this namespace, and
                // "which Secret holds the cert for this host" is the question
                // this tab exists to answer — so the label is the way to it.
                // `showKind` is off: the block is titled TLS and every row in
                // it is a Secret.
                label: config.secretName ? (
                  <ResourceRef
                    kind={ResourceType.Secret}
                    name={config.secretName}
                    namespace={ingress?.namespace}
                    showKind={false}
                  />
                ) : (
                  t("empty", "autoGenerated")
                ),
                value: (
                  <span className="flex flex-col gap-0.5">
                    <span className={cn(!config.isCatchAll && "font-mono")}>
                      {config.isCatchAll
                        ? t("empty", "catchAllAppliesToRest")
                        : config.hosts.join(", ") || t("empty", "noHosts")}
                    </span>
                    {config.secretName && (
                      <CertificateLine
                        read={certificates?.get(config.secretName)}
                        hosts={config.hosts}
                      />
                    )}
                  </span>
                ),
                tone: config.isCatchAll ? ("warn" as const) : undefined,
              }))}
            />
          )}
          {/* The four objects and the sentence that says what failed. Below
              the certificate facts, because those are core and read the
              same on a cluster with nothing installed on it. */}
          {tlsConfigs.map(
            (config) =>
              config.secretName && (
                <IssuanceSection
                  key={config.secretName}
                  issuance={issuance}
                  secretName={config.secretName}
                />
              )
          )}
        </Section>
      ),
    },
    {
      id: "metadata",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(ingress?.labels ?? {}).length}
            items={recordToKeyValues(ingress?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(ingress?.annotations ?? {}).length}
            items={recordToKeyValues(ingress?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    eventsTab(events, t, { kind: ResourceType.Ingress, name: name ?? "" }),
    yamlTab({
      title: t("action", "kindYaml", { kind: "Ingress" }),
      yaml: ingressYaml,
      resourceKind: ResourceType.Ingress,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <>
      {/* The header's verdict reads its backends from the Services list's
          answer, which a change under them makes stale as it does the chain. */}
      <ChainWatches
        services={chain.services}
        reads={[
          chain.key,
          queryKeys.serviceHealthInputs(ingress ? [ingress.namespace] : []),
        ]}
      />
      <ResourceDetailLayout
        freshness={freshness}
        resource={ingress}
        delivery={deliveryQuery}
        share={share}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.Ingress}
        title={ingress?.name || name || ""}
        namespace={ingress?.namespace || namespace}
        createdAt={ingress?.createdAt}
        badges={
          <>
            {ingress?.className && (
              <span className="font-mono text-[11px] text-fg-mut">
                {ingress.className}
              </span>
            )}
            <span
              className={cn(
                "text-[11px]",
                tls === "no"
                  ? "text-warn"
                  : tls === "unknown"
                    ? TLS_NOT_CHECKED_TONE
                    : missing
                      ? "text-err"
                      : soonest?.tone
                        ? TONE_CLASS[soonest.tone]
                        : "text-fg-fnt"
              )}
            >
              {tls === "no"
                ? t("empty", "noTls")
                : tls === "unknown"
                  ? t("empty", "tlsNotChecked")
                  : missing
                    ? t("empty", "certificateMissing")
                    : (soonest?.tone && expiryText(soonest, t)) || "TLS"}
            </span>
          </>
        }
        onBack={goBack}
        actions={
          <DeleteAction
            kind={ResourceType.Ingress}
            name={ingress?.name || name || ""}
            namespace={ingress?.namespace || namespace}
            detail={ingress}
            intercept={intercept("Delete")}
            mutation={deleteMutation}
          />
        }
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabs={tabs}
      />
    </>
  );
}
