/**
 * AKS add-ons: which pods can become which Azure identity.
 *
 * The page exists because the vendor record was describing a retired product.
 * aad-pod-identity was deprecated in October 2022, archived in September
 * 2023, and its managed AKS add-on left support in September 2025 — so on any
 * cluster built since, its three CRDs are absent, this app found nothing, and
 * said so, while the cluster's identities were sitting in ordinary metadata
 * the app never read.
 *
 * So the page draws the mechanism the cluster is *on*, and names the other
 * one only where it is still installed. The unit is the identity, and under
 * it the pods that can assume it — which is the sentence the reader wants and
 * which neither a ServiceAccount page nor a pod page can say, because half of
 * it is an annotation over here and half is a label over there.
 */

import { useMemo, useState } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import { plural } from "../kit";
import {
  Cell,
  Chain,
  Column,
  FilterBox,
  Finding,
  TroubleRow,
  type Tone,
} from "../page-kit";
import { useAksPicture } from "./data";
import {
  AZURE_IDENTITY_BINDING_CRD,
  AZURE_IDENTITY_CRD,
  bindingIdentity,
  bindingSummary,
  danglingBindings,
} from "./model";
import type { FederatedAccount } from "./workload-identity";

export default function AksAddonsPage() {
  const picture = useAksPicture();
  const [filter, setFilter] = useState("");

  const accounts = useMemo(
    () => picture.data?.workload.accounts ?? [],
    [picture.data]
  );
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return accounts;
    return accounts.filter(
      (account) =>
        account.name.toLowerCase().includes(needle) ||
        account.namespace.toLowerCase().includes(needle) ||
        account.clientId.toLowerCase().includes(needle) ||
        account.pods.some((pod) => pod.name.toLowerCase().includes(needle))
    );
  }, [accounts, filter]);

  const orphans = picture.data?.workload.findings ?? [];
  const legacy = picture.data?.legacyInstalled ?? false;
  const dangling = picture.data
    ? danglingBindings(picture.data.bindings, picture.data.identities)
    : [];

  if (picture.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not read this cluster&rsquo;s identities
        </h2>
        <p className="text-[11px] text-fg-fnt">{picture.error.message}</p>
      </Section>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="AKS add-ons"
        count={
          picture.isPending ? undefined : plural(accounts.length, "identity")
        }
        description="Which pods can become which Azure identity — and, where a cluster is still on it, what the retired pod-identity add-on was told."
      />

      {orphans.map((finding, index) => (
        <Finding
          key={index}
          tone="err"
          title={
            <>
              <span className="font-mono">{finding.pod.name}</span> asks for an
              identity its ServiceAccount does not name
            </>
          }
        >
          It carries{" "}
          <span className="font-mono">azure.workload.identity/use: true</span>,
          so the webhook projects a token for it — but{" "}
          <span className="font-mono">{finding.account}</span> in{" "}
          <span className="font-mono">{finding.pod.namespace}</span> has no{" "}
          <span className="font-mono">azure.workload.identity/client-id</span>{" "}
          annotation, so the token is for no identity at all. Every call it
          makes to Azure comes back 401 and nothing in Kubernetes says why.
        </Finding>
      ))}

      <Section>
        <div className="mb-3">
          <FilterBox
            value={filter}
            onChange={setFilter}
            placeholder="Filter by identity, client id or pod…"
            label="Filter identities"
          />
        </div>

        {picture.isPending ? (
          <p className="text-xs text-fg-fnt">Reading the identities…</p>
        ) : accounts.length === 0 ? (
          <p className="max-w-[72ch] text-[11.5px] text-fg-mut">
            No pod in this cluster carries{" "}
            <span className="font-mono">azure.workload.identity/use: true</span>
            , so nothing here is federating to Azure through Workload ID.
            {legacy
              ? " The retired pod-identity add-on is still installed, and what it holds is below."
              : " The retired pod-identity add-on is not installed either — its three kinds are not served by this API server."}
          </p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-fnt">
            Nothing matches <span className="font-mono">{filter}</span>.
          </p>
        ) : (
          <div className="flex flex-col">
            {shown.map((account, index) => (
              <AccountRow
                key={`${account.namespace}/${account.name}`}
                account={account}
                last={index === shown.length - 1}
              />
            ))}
          </div>
        )}
      </Section>

      {legacy && (
        <Section>
          <SectionHeader
            title="Pod identity, which is retired"
            count={picture.data?.bindings.length || undefined}
            description="aad-pod-identity was deprecated in October 2022, archived in September 2023, and its AKS add-on left support in September 2025. What is here still works until it does not; Workload ID above is where it goes."
          />
          {dangling.length > 0 && (
            <Finding
              tone="err"
              title={
                dangling.length === 1
                  ? `No AzureIdentity named ${bindingIdentity(dangling[0])}`
                  : `${plural(dangling.length, "binding")} name an identity that does not exist`
              }
            >
              The binding is accepted, no{" "}
              <span className="font-mono">AzureAssignedIdentity</span> is ever
              created, the pods run perfectly, and every call they make to Azure
              comes back 403 with nothing in Kubernetes to say why.
            </Finding>
          )}
          <div className="mt-2 flex flex-col gap-1.5">
            {picture.data?.bindings.map((binding) => (
              <Chain key={`${binding.namespace}/${binding.name}`}>
                <Column label="Binding">
                  <Cell under={binding.namespace ?? undefined}>
                    <ResourceRef
                      kind="AzureIdentityBinding"
                      name={binding.name}
                      namespace={binding.namespace}
                      crd={AZURE_IDENTITY_BINDING_CRD}
                      showKind={false}
                    />
                  </Cell>
                </Column>
                <Column label="Says">
                  <Cell
                    bad={dangling.includes(binding)}
                    title={bindingSummary(binding)}
                  >
                    {bindingSummary(binding)}
                  </Cell>
                </Column>
                <Column label="Identity">
                  <Cell bad={dangling.includes(binding)}>
                    {bindingIdentity(binding) ? (
                      <ResourceRef
                        kind="AzureIdentity"
                        name={bindingIdentity(binding)!}
                        namespace={binding.namespace}
                        crd={AZURE_IDENTITY_CRD}
                        showKind={false}
                      />
                    ) : (
                      "names none"
                    )}
                  </Cell>
                </Column>
              </Chain>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function accountState(account: FederatedAccount): {
  text: string;
  tone: Tone;
} {
  if (account.pods.length === 0) {
    return { text: "no pod uses it", tone: "warn" };
  }
  return { text: plural(account.pods.length, "pod"), tone: "ok" };
}

function AccountRow({
  account,
  last,
}: {
  account: FederatedAccount;
  last: boolean;
}) {
  return (
    <TroubleRow
      title={<span className="font-mono">{account.name}</span>}
      meta={
        <>
          {account.namespace}
          {account.tenantId && ` · tenant ${account.tenantId}`}
        </>
      }
      state={accountState(account)}
      last={last}
    >
      <Chain>
        <Column label="ServiceAccount">
          <Cell under={account.namespace}>
            <span className="font-mono">{account.name}</span>
          </Cell>
        </Column>
        <Column label="Client id">
          <Cell title={account.clientId}>
            <span className="font-mono">{account.clientId}</span>
          </Cell>
        </Column>
        <Column label="Assumed by">
          {account.pods.length === 0 ? (
            <Cell warn>
              <span className="text-fg-fnt">no pod carries the label</span>
            </Cell>
          ) : (
            account.pods.map((pod) => (
              <Cell key={`${pod.namespace}/${pod.name}`} under={pod.namespace}>
                <ResourceRef
                  kind={ResourceType.Pod}
                  name={pod.name}
                  namespace={pod.namespace}
                  showKind={false}
                />
              </Cell>
            ))
          )}
        </Column>
      </Chain>
    </TroubleRow>
  );
}
