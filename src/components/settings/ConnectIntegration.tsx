/**
 * The form behind Connect and Edit.
 *
 * Generic on purpose: it is driven entirely by what the vendor declared, and
 * it names no vendor. The reader sees "Prometheus" because the pane passed
 * the row's own name down as a string — the same rule the whole seam runs
 * on, where naming a vendor in copy was never the problem and naming one in
 * an `import` is.
 *
 * The token field is write-only and says so. It cannot be pre-filled because
 * the credential never crosses out of the backend, and pretending otherwise
 * with a row of dots the reader could not read back would be a control that
 * lies about what it holds.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { candidates, forward, useConnectionEditor } from "@/integrations";
import { useClusterStore } from "@/stores/clusterStore";
import {
  useClusterForwardStore,
  useForwardPreference,
} from "@/stores/clusterForwardStore";
import type {
  Candidate,
  ConnectionDraft,
  Forwarded,
  InClusterHint,
  ProbeResult,
} from "@/integrations";
import { useT } from "@/i18n/useT";

export function ConnectIntegration({
  vendorId,
  vendorName,
  gives,
  open,
  onOpenChange,
}: {
  vendorId: string;
  vendorName: string;
  gives: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const editor = useConnectionEditor(vendorId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open, and keyed on what is saved: closing
         *  really does discard, a second Edit does not show the first one's
         *  abandoned typing, and an address that arrives late re-seeds the
         *  fields rather than being written over the reader's cursor. */}
        {open && (
          <ConnectForm
            key={`${editor.saved?.url ?? ""}|${editor.saved?.authType ?? ""}`}
            editor={editor}
            vendorId={vendorId}
            vendorName={vendorName}
            gives={gives}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm({
  editor,
  vendorId,
  vendorName,
  gives,
  onDone,
}: {
  editor: ReturnType<typeof useConnectionEditor>;
  vendorId: string;
  vendorName: string;
  gives: string;
  onDone: () => void;
}) {
  const t = useT();
  const context = useClusterStore((state) => state.currentContext);
  const remember = useClusterForwardStore((state) => state.remember);
  const setAutoStart = useClusterForwardStore((state) => state.setAutoStart);
  const saved = useForwardPreference(context, vendorId);
  const [url, setUrl] = React.useState(editor.saved?.url ?? "");
  const [token, setToken] = React.useState("");
  const [bearer, setBearer] = React.useState(
    editor.saved?.authType === "bearer"
  );
  const [insecure, setInsecure] = React.useState(
    editor.saved?.insecureTls ?? false
  );
  const [tested, setTested] = React.useState<ProbeResult | null>(null);
  const [testing, setTesting] = React.useState(false);

  const draft = (): ConnectionDraft => ({
    url: url.trim(),
    authType: bearer ? "bearer" : "none",
    token,
    insecureTls: insecure,
  });

  const test = async () => {
    setTesting(true);
    try {
      setTested(await editor.test(draft()));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    await editor.save(draft());
    onDone();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{vendorName}</DialogTitle>
        <DialogDescription>
          One address per cluster, because a {vendorName} is per cluster —
          staging&rsquo;s is not production&rsquo;s. Gives {gives}.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3 py-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="integration-url" className="text-xs text-fg-mut">
            Address
          </Label>
          <Input
            id="integration-url"
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder={editor.connect?.urlPlaceholder}
            onChange={(event) => setUrl(event.target.value)}
            className="font-mono text-xs"
          />
          {/* The question every failed connection here turns out to be. The
              request is made by this app, on this machine — so a Service name
              that works from inside the cluster resolves to nothing here, and
              that is the commonest way to get this field wrong. */}
          <p className="text-[11px] text-fg-fnt">
            Asked from this machine, not from inside the cluster — so a
            cluster-internal name like{" "}
            <span className="font-mono">prometheus.monitoring</span> will not
            resolve. Give an address that reaches it from here, or let the app
            forward a port to it.
          </p>
        </div>

        {editor.connect?.inCluster && (
          <InCluster
            hint={editor.connect.inCluster}
            vendorName={vendorName}
            onPicked={(picked) => {
              setUrl(picked.url);
              setTested(null);
              if (context) {
                remember(context, vendorId, {
                  namespace: picked.namespace,
                  service: picked.service,
                  remotePort: picked.remotePort,
                  localPort: picked.localPort,
                  // Off until asked for: a forward is a socket on this
                  // machine and a connection into the cluster, and neither is
                  // started on somebody's behalf because they pressed a
                  // button once.
                  autoStart: false,
                });
              }
            }}
          />
        )}

        {saved && (
          <label className="flex items-start gap-2 text-xs text-fg-mut">
            <Checkbox
              checked={saved.autoStart}
              onCheckedChange={(value) =>
                context && setAutoStart(context, vendorId, value === true)
              }
              className="mt-0.5"
            />
            <span>
              Open the tunnel when I switch to this cluster
              <span className="mt-0.5 block text-[11px] text-fg-fnt">
                Forwarding{" "}
                <span className="font-mono">
                  {saved.namespace}/{saved.service}:{saved.remotePort}
                </span>{" "}
                to{" "}
                <span className="font-mono">localhost:{saved.localPort}</span>.
                Left off, the row stays in the sidebar and pressing it opens the
                tunnel — kept per cluster, on this machine only.
              </span>
            </span>
          </label>
        )}

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={bearer}
            onCheckedChange={(value) => setBearer(value === true)}
          />
          Send a bearer token
        </label>

        {bearer && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="integration-token" className="text-xs text-fg-mut">
              Token
            </Label>
            <Input
              id="integration-token"
              type="password"
              value={token}
              autoComplete="off"
              placeholder={
                editor.saved?.hasToken
                  ? "unchanged — type to replace it"
                  : "pasted here, kept out of this window afterwards"
              }
              onChange={(event) => setToken(event.target.value)}
              className="font-mono text-xs"
            />
            {/* Where it goes, said plainly, because the reader is about to
             *  paste a credential and is owed the truth about the file. */}
            <p className="text-[11px] leading-snug text-fg-fnt">
              Stored in this app&rsquo;s config file in plain text, beside the
              registry passwords it already keeps there, and sent only from the
              backend — it is never handed back to this window.
            </p>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={insecure}
            onCheckedChange={(value) => setInsecure(value === true)}
          />
          Accept a certificate this machine does not trust
        </label>

        {tested && <TestResult result={tested} />}
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        <div>
          {editor.saved && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await editor.forget();
                onDone();
              }}
              className="text-err hover:text-err"
            >
              {t("action", "disconnect")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={test}
            disabled={testing || url.trim() === ""}
          >
            {testing ? t("action", "testing") : t("action", "test")}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={editor.isSaving || url.trim() === ""}
          >
            {t("action", "save")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** Its own words, never a paraphrase — the two failures go two places. */
/**
 * Find this vendor's Service in the cluster and forward a port to it.
 *
 * The offer exists because the reader is naming a server either way, and a
 * Service names one the app can already reach — where the address they would
 * otherwise type, the in-cluster name, is the one thing that cannot work from
 * here.
 *
 * Candidates are listed rather than chosen. Two Prometheuses is an ordinary
 * cluster — the operator's and the one somebody's chart brought — and picking
 * for the reader would be this app guessing which of their monitoring stacks
 * they meant.
 */
function InCluster({
  hint,
  vendorName,
  onPicked,
}: {
  hint: InClusterHint;
  vendorName: string;
  onPicked: (forwarded: Forwarded) => void;
}) {
  const [looking, setLooking] = React.useState(false);
  const [found, setFound] = React.useState<Candidate[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  const look = async () => {
    setLooking(true);
    setFailed(null);
    try {
      setFound(await candidates(hint));
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setLooking(false);
    }
  };

  const pick = async (candidate: Candidate) => {
    const key = `${candidate.service.namespace}/${candidate.service.name}`;
    setBusy(key);
    setFailed(null);
    try {
      onPicked(await forward(candidate.service, hint.ports));
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="outline"
        size="sm"
        onClick={look}
        disabled={looking}
        className="self-start text-xs"
      >
        {looking ? "Looking…" : `Find ${vendorName} in this cluster`}
      </Button>

      {found !== null && found.length === 0 && (
        <p className="text-[11px] text-fg-fnt">
          No Service in this cluster is labelled or named for {vendorName}. If
          it is here under another name, forward it yourself and give the
          address above.
        </p>
      )}

      {found?.map((candidate) => {
        const key = `${candidate.service.namespace}/${candidate.service.name}`;
        return (
          <button
            key={key}
            type="button"
            disabled={busy !== null}
            onClick={() => pick(candidate)}
            className="flex items-baseline justify-between gap-3 rounded border border-hair px-2 py-1.5 text-left text-xs hover:bg-hover disabled:opacity-60"
          >
            <span className="min-w-0 truncate font-mono text-fg">
              {candidate.service.namespace}/{candidate.service.name}
              <span className="ml-1.5 text-fg-fnt">:{candidate.port}</span>
            </span>
            <span className="flex-none text-[11px] text-fg-fnt">
              {busy === key ? "forwarding…" : candidate.because}
            </span>
          </button>
        );
      })}

      {failed && <p className="text-[11px] text-err">{failed}</p>}
    </div>
  );
}

function TestResult({ result }: { result: ProbeResult }) {
  if (result.ok) {
    return (
      <p className="text-[11px] text-ok" role="status">
        Answered in {result.latencyMs}ms
        {result.version ? ` · ${result.version}` : ""}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-err" role="status">
      Did not answer — {result.reason}
    </p>
  );
}
