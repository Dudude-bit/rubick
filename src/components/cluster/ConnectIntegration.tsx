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
import { errorWords, sayWords } from "@/i18n/say";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import type { ServiceInfo } from "@/generated/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
          {t("settings", "oneAddressPerCluster", { vendor: vendorName, gives })}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3 py-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="integration-url" className="text-xs text-fg-mut">
            {t("columns", "address")}
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
            {/* One sentence in the catalogue, split here rather than there:
                a translator moves the example wherever their word order wants
                it, and the monospace still lands on it. */}
            {splitAround(t("settings", "addressIsFromHere"), "{example}").map(
              (part, i) =>
                i === 1 ? (
                  <span key="example" className="font-mono">
                    prometheus.monitoring
                  </span>
                ) : (
                  <span key={i}>{part}</span>
                )
            )}
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
                  // Carried, so waking this forward tomorrow rebuilds the
                  // same address — an API under /prometheus is not reachable
                  // at the port alone.
                  subpath: picked.subpath,
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
              {t("settings", "openTunnelOnSwitch")}
              <span className="mt-0.5 block text-[11px] text-fg-fnt">
                {splitAround(
                  t("settings", "forwardingTunnelNote"),
                  "{target}"
                ).map((part, i) =>
                  i === 1 ? (
                    <span key="target" className="font-mono">
                      {saved.namespace}/{saved.service}:{saved.remotePort}
                    </span>
                  ) : (
                    <React.Fragment key={i}>
                      {splitAround(part, "{local}").map((sub, j) =>
                        j === 1 ? (
                          <span key="local" className="font-mono">
                            localhost:{saved.localPort}
                          </span>
                        ) : (
                          <span key={j}>{sub}</span>
                        )
                      )}
                    </React.Fragment>
                  )
                )}
              </span>
            </span>
          </label>
        )}

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={bearer}
            onCheckedChange={(value) => setBearer(value === true)}
          />
          {t("settings", "sendBearerToken")}
        </label>

        {bearer && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="integration-token" className="text-xs text-fg-mut">
              {t("settings", "token")}
            </Label>
            <Input
              id="integration-token"
              type="password"
              value={token}
              autoComplete="off"
              placeholder={
                editor.saved?.hasToken
                  ? t("settings", "tokenUnchangedPlaceholder")
                  : t("settings", "tokenNewPlaceholder")
              }
              onChange={(event) => setToken(event.target.value)}
              className="font-mono text-xs"
            />
            {/* Where it goes, said plainly, because the reader is about to
             *  paste a credential and is owed the truth about the file. */}
            <p className="text-[11px] leading-snug text-fg-fnt">
              {t("settings", "credentialStorageNote")}
            </p>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-fg-mut">
          <Checkbox
            checked={insecure}
            onCheckedChange={(value) => setInsecure(value === true)}
          />
          {t("settings", "acceptUntrustedCert")}
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
/** Exported for its own test: the dialog around it needs a live cluster. */
export function InCluster({
  hint,
  vendorName,
  onPicked,
}: {
  hint: InClusterHint;
  vendorName: string;
  onPicked: (forwarded: Forwarded) => void;
}) {
  const t = useT();
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
      setFailed(errorWords(error, t));
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
      setFailed(errorWords(error, t));
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
        {looking
          ? t("settings", "lookingEllipsis")
          : t("settings", "findVendorInCluster", { vendor: vendorName })}
      </Button>

      {found !== null && found.length === 0 && (
        <p className="text-[11px] text-fg-fnt">
          {t("settings", "noServiceForVendor", { vendor: vendorName })}
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
              {busy === key
                ? t("settings", "forwardingEllipsis")
                : sayWords(candidate.because, t)}
            </span>
          </button>
        );
      })}

      <ByHand hint={hint} onPicked={onPicked} onFailed={setFailed} />

      {failed && <p className="text-[11px] text-err">{failed}</p>}
    </div>
  );
}

/**
 * Point at a Service this app did not recognise.
 *
 * The search above matches a Service by the vendor's own name and label,
 * which is right for the thing it names and useless for everything that
 * merely speaks its API — a VictoriaMetrics is called `vmsingle`, wears no
 * Prometheus label, listens on 8428 and answers the same queries (#71).
 *
 * So: any Service in the cluster, any of its ports, and the subpath the API
 * sits under. Namespace, Service and port are chosen from what the cluster
 * actually has rather than typed, because three of the four fields are facts
 * this app already holds and a typo in them is a connection that fails with
 * nothing to point at. Only the subpath is typed, because only the subpath is
 * something the cluster cannot tell us.
 */
function ByHand({
  hint,
  onPicked,
  onFailed,
}: {
  hint: InClusterHint;
  onPicked: (forwarded: Forwarded) => void;
  onFailed: (message: string | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [services, setServices] = React.useState<ServiceInfo[] | null>(null);
  const [chosen, setChosen] = React.useState("");
  const [port, setPort] = React.useState("");
  const [subpath, setSubpath] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const service = services?.find(
    (candidate) => `${candidate.namespace}/${candidate.name}` === chosen
  );

  const reveal = async () => {
    setOpen(true);
    onFailed(null);
    if (services !== null) return;
    try {
      setServices(await commands.listServices(null));
    } catch (error) {
      onFailed(errorWords(error, t));
    }
  };

  const go = async () => {
    if (!service) return;
    setBusy(true);
    onFailed(null);
    try {
      onPicked(await forward(service, [Number(port)], undefined, subpath));
    } catch (error) {
      onFailed(errorWords(error, t));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void reveal()}
        className="self-start text-[11px] text-fg-fnt underline underline-offset-2 hover:text-fg"
      >
        {t("settings", "pointAtServiceYourself")}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded border border-hair p-2">
      <p className="text-[11px] text-fg-fnt">
        {t("settings", "pointAtServiceHint")}
      </p>

      <div className="flex flex-col gap-1">
        <Label htmlFor="integration-service" className="text-xs text-fg-mut">
          {t("settings", "serviceLabel")}
        </Label>
        <Select
          value={chosen}
          onValueChange={(value) => {
            setChosen(value);
            setPort("");
          }}
        >
          <SelectTrigger id="integration-service" className="h-7 text-xs">
            <SelectValue placeholder={t("settings", "chooseService")} />
          </SelectTrigger>
          <SelectContent>
            {(services ?? []).map((candidate) => (
              <SelectItem
                key={`${candidate.namespace}/${candidate.name}`}
                value={`${candidate.namespace}/${candidate.name}`}
              >
                {candidate.namespace}/{candidate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="integration-port" className="text-xs text-fg-mut">
          {t("settings", "portLabel")}
        </Label>
        <Select value={port} onValueChange={setPort} disabled={!service}>
          <SelectTrigger id="integration-port" className="h-7 text-xs">
            <SelectValue placeholder={t("settings", "choosePort")} />
          </SelectTrigger>
          <SelectContent>
            {(service?.ports ?? []).map((exposed) => (
              <SelectItem key={exposed.port} value={String(exposed.port)}>
                {exposed.port}
                {exposed.name ? ` · ${exposed.name}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        {/* The hint sits outside the label: inside it, the accessible name of
            the field becomes the whole paragraph. */}
        <label htmlFor="integration-subpath" className="text-xs text-fg-mut">
          {t("settings", "subpathLabel")}
        </label>
        <Input
          id="integration-subpath"
          value={subpath}
          onChange={(event) => setSubpath(event.target.value)}
          placeholder={hint.subpathExample ?? "/prometheus"}
          className="h-7 font-mono text-xs"
        />
        <span className="text-[11px] text-fg-fnt">
          {t("settings", "subpathHint")}
        </span>
      </div>

      <Button
        size="sm"
        onClick={() => void go()}
        disabled={!service || !port || busy}
        className="self-start text-xs"
      >
        {busy
          ? t("settings", "forwardingEllipsis")
          : t("settings", "forwardIt")}
      </Button>
    </div>
  );
}

function TestResult({ result }: { result: ProbeResult }) {
  const t = useT();
  if (result.ok) {
    return (
      <p className="text-[11px] text-ok" role="status">
        {t("settings", "probeAnswered", { ms: result.latencyMs })}
        {result.version ? ` · ${result.version}` : ""}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-err" role="status">
      {t("settings", "probeDidNotAnswer", {
        reason: sayWords(result.reason, t),
      })}
    </p>
  );
}

/**
 * A sentence kept whole in the catalogue, cut where it is rendered.
 *
 * The alternative is two half-sentences either side of a styled span, and a
 * language that puts the example first has nowhere to put it. One string with
 * a placeholder travels; the cut happens here.
 */
function splitAround(text: string, token: string): string[] {
  const at = text.indexOf(token);
  if (at < 0) return [text];
  return [text.slice(0, at), token, text.slice(at + token.length)];
}
