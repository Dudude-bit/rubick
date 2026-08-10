import { useQuery } from "@tanstack/react-query";
import { Table2, Tag, Trash2 } from "lucide-react";

import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { connectionsTab } from "@/components/resources/connections-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import { CertificateSection } from "@/components/resources/CertificateFacts";
import { DataSection } from "@/components/resources/data-rows";
import { IssuanceSection } from "@/components/resources/IssuanceChain";
import { KeyValueSection } from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useCertificateIssuance } from "@/hooks/useCertificateIssuance";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { SecretInfo } from "@/generated/types";

export function SecretDetail() {
  const {
    name,
    namespace,
    resource: secret,
    isLoading,
    error,
    yaml: secretYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<SecretInfo>({
    resourceKind: ResourceType.Secret,
    fetchResource: (name, ns) => commands.getSecret(name, ns),
    deleteResource: (name, ns) => commands.deleteSecret(name, ns),
    defaultTab: "data",
  });

  const connections = useConnections(ResourceType.Secret, name, namespace);

  const { data: secretData, isLoading: isDataLoading } = useQuery({
    queryKey: ["secret-data", name, namespace],
    queryFn: () => commands.getSecretData(name!, namespace ?? null),
    enabled: !!name && !!namespace,
  });

  const isTls = secret?.type === "kubernetes.io/tls";
  const tlsSecretName = isTls && name ? [name] : [];
  const certificates = useTlsCertificates(namespace, tlsSecretName);
  const issuance = useCertificateIssuance(namespace, tlsSecretName);

  const deliveryQuery = deliveryOfKind(ResourceType.Secret, secret);
  const intercept = useDeliveryIntercept(deliveryQuery);

  if (!secret && !isLoading && !error) {
    return null;
  }

  const dataKeys = secret?.dataKeys ?? [];
  const labels = secret?.labels ?? {};
  const annotations = secret?.annotations ?? {};
  // The prefix is the same on every built-in type and only pushes the part
  // that differs off the end of the badge.
  const secretType = (secret?.type ?? "Opaque").replace("kubernetes.io/", "");

  const tabs = [
    {
      id: "data",
      label: "Data",
      glyph: viewGlyph(Table2),
      mark: countMark(dataKeys.length),
      content: (
        <DataSection
          data={secretData?.values ?? {}}
          withheld={secretData?.withheld}
          binary={secretData?.binary}
          keys={dataKeys}
          sensitive
          isLoading={isDataLoading}
          emptyMessage="This Secret holds no keys"
        />
      ),
    },
    connectionsTab(connections, deliveryQuery),
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(labels).length}
            items={recordToKeyValues(labels)}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(annotations).length}
            items={recordToKeyValues(annotations)}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    yamlTab({
      title: "Secret YAML",
      yaml: secretYaml,
      resourceKind: ResourceType.Secret,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={secret}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Secret}
      title={secret?.name || name || ""}
      namespace={secret?.namespace || namespace}
      createdAt={secret?.createdAt}
      statusBadge={
        secret && (
          // The type is a classification, not a health state: it gets the
          // neutral role rather than borrowing a status colour.
          <StatusBadge status={secretType} roleOverride="neutral" />
        )
      }
      badges={
        <span className="text-[11px] text-fg-fnt">
          {dataKeys.length} {dataKeys.length === 1 ? "key" : "keys"}
        </span>
      }
      onBack={goBack}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label="Delete"
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {/* Above the tabs, because on a TLS Secret the certificate is what
          the page is about and the keys under it are how it is stored. */}
      {isTls && name && (
        <>
          <CertificateSection read={certificates.data?.get(name)} />
          {/* Core first and whole; the extension adds why, or nothing. */}
          <IssuanceSection issuance={issuance} secretName={name} />
        </>
      )}
    </ResourceDetailLayout>
  );
}
