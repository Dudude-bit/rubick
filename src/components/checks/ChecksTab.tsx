import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Section, SectionHeader } from "@/components/ui/section";
import { commands } from "@/lib/commands";
import {
  DEFAULT_CHECK_IMAGE,
  parseHostPort,
  verdictOf,
  type Verdict,
} from "@/lib/checks";
import { offeredContainers } from "@/lib/container-sequence";
import { normalizeTauriError } from "@/lib/error-utils";
import type { Check, CheckOutcome, PodInfo } from "@/generated/types";
import { useT, type T } from "@/i18n/useT";

type Kind = "dns" | "tcp";

interface Run {
  kind: Kind;
  check: Check;
  outcome: CheckOutcome;
}

/**
 * Two questions a person asks about a pod that is not doing what it should,
 * asked from the pod's own network and never from this machine's: does the
 * name resolve, does the port answer.
 *
 * Where the image has a tool for it the exec goes into the pod's own
 * container. Where it has none, the same exec goes into a throwaway copy of
 * the pod that shares its namespace, labels, DNS policy and service account,
 * and the answer says so: a copy is not the pod, and it is deleted the moment
 * the answer is in.
 */
export function ChecksTab({ pod }: { pod: PodInfo }) {
  const t = useT();
  const containers = offeredContainers(pod);
  const [container, setContainer] = useState(
    () =>
      containers.find((c) => c.state.type === "running")?.name ??
      containers[0]?.name ??
      ""
  );
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [image, setImage] = useState(DEFAULT_CHECK_IMAGE);
  const [runs, setRuns] = useState<Run[]>([]);

  const run = useMutation({
    mutationFn: async ({
      kind,
      check,
      copy,
    }: {
      kind: Kind;
      check: Check;
      copy: boolean;
    }) => {
      const outcome = await commands.runPodCheck(
        pod.name,
        pod.namespace,
        container,
        check,
        copy ? { image } : null
      );
      return { kind, check, outcome };
    },
    onSuccess: (done) => setRuns((previous) => [done, ...previous].slice(0, 8)),
  });

  const hostPort = parseHostPort(address);
  const busy = run.isPending;

  return (
    <div className="flex flex-col gap-[22px]">
      <Section>
        <SectionHeader
          title={t("checks", "title")}
          description={t("checks", "lede")}
          actions={
            containers.length > 1 ? (
              <Select value={container} onValueChange={setContainer}>
                <SelectTrigger
                  aria-label={t("checks", "fromContainer")}
                  className="h-7 w-44 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {containers.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null
          }
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            run.mutate({
              kind: "dns",
              check: { kind: "dns", name: name.trim() },
              copy: false,
            });
          }}
        >
          <label className="w-24 text-xs text-fg-mut" htmlFor="check-dns">
            {t("checks", "dns")}
          </label>
          <Input
            id="check-dns"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="postgres.shop.svc.cluster.local"
            className="h-7 max-w-md font-mono text-xs"
          />
          <Button size="sm" type="submit" disabled={busy || !name.trim()}>
            <Play aria-hidden="true" className="mr-1.5 h-3 w-3" />
            {t("checks", "run")}
          </Button>
        </form>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!hostPort) return;
            run.mutate({
              kind: "tcp",
              check: { kind: "tcp", host: hostPort.host, port: hostPort.port },
              copy: false,
            });
          }}
        >
          <label className="w-24 text-xs text-fg-mut" htmlFor="check-tcp">
            {t("checks", "tcp")}
          </label>
          <Input
            id="check-tcp"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="postgres:5432"
            className="h-7 max-w-md font-mono text-xs"
          />
          <Button size="sm" type="submit" disabled={busy || !hostPort}>
            <Play aria-hidden="true" className="mr-1.5 h-3 w-3" />
            {t("checks", "run")}
          </Button>
        </form>
        {busy ? (
          <p className="text-xs text-fg-fnt" role="status">
            {t("checks", "running")}
          </p>
        ) : null}
        {run.error ? (
          <p className="text-xs text-err" role="alert">
            {t("checks", "failed", { error: normalizeTauriError(run.error) })}
          </p>
        ) : null}
      </Section>

      {runs.length > 0 ? (
        <Section>
          <SectionHeader title={t("checks", "answers")} />
          <ul className="flex flex-col gap-2" data-testid="check-answers">
            {runs.map((done, index) => (
              <Answer
                key={index}
                run={done}
                image={image}
                onImage={setImage}
                busy={busy}
                onCopy={() =>
                  run.mutate({ kind: done.kind, check: done.check, copy: true })
                }
              />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function subjectOf(check: Check): string {
  return check.kind === "dns" ? check.name : `${check.host}:${check.port}`;
}

function Answer({
  run,
  image,
  onImage,
  busy,
  onCopy,
}: {
  run: Run;
  image: string;
  onImage: (image: string) => void;
  busy: boolean;
  onCopy: () => void;
}) {
  const t = useT();
  const verdict = verdictOf(run.kind, run.outcome);
  const subject = subjectOf(run.check);
  const tone =
    verdict.says === "resolved" || verdict.says === "connected"
      ? "text-ok"
      : verdict.says === "noTool"
        ? "text-fg-mut"
        : "text-warn";

  return (
    <li className="rounded border border-hair px-3 py-2 text-xs">
      <p className={`font-medium ${tone}`}>{sentence(verdict, subject, t)}</p>
      <p className="mt-0.5 text-[11px] text-fg-fnt">
        {run.outcome.ranIn === "copy" && run.outcome.copy
          ? t("checks", "ranInCopy", {
              image: run.outcome.copy.image,
              pod: run.outcome.copy.pod,
              deleted: run.outcome.copy.deleted
                ? t("checks", "copyDeleted")
                : t("checks", "copyNotDeleted"),
            })
          : t("checks", "ranInContainer")}
        {run.outcome.answeredWith
          ? ` · ${t("checks", "answeredWith", { tool: run.outcome.answeredWith })}`
          : null}
        {` · ${run.outcome.elapsedMs} ms`}
      </p>
      {verdict.says === "noTool" ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            aria-label={t("checks", "copyImage")}
            value={image}
            onChange={(event) => onImage(event.target.value)}
            className="h-7 w-56 font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={onCopy} disabled={busy}>
            {t("checks", "runFromCopy")}
          </Button>
          <span className="text-[11px] text-fg-fnt">
            {t("checks", "copyNote")}
          </span>
        </div>
      ) : null}
      {run.outcome.stdout || run.outcome.stderr ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-fg-fnt">
            {t("checks", "whatItSaid")}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-fg-mut">
            {run.outcome.stdout}
            {run.outcome.stderr ? `\n${run.outcome.stderr}` : ""}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

function sentence(verdict: Verdict, subject: string, t: T): string {
  switch (verdict.says) {
    case "resolved":
      return t("checks", "resolved", {
        name: subject,
        addresses: verdict.addresses.join(", "),
      });
    case "notResolved":
      return t("checks", "notResolved", { name: subject });
    case "connected":
      return t("checks", "connected", { address: subject });
    case "refused":
      return t("checks", "refused", { address: subject });
    case "noTool":
      return t("checks", "noTool", { tried: verdict.tried.join(", ") });
  }
}
