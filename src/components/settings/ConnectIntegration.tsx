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
import { useConnectionEditor } from "@/integrations";
import type { ConnectionDraft, ProbeResult } from "@/integrations";

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
  vendorName,
  gives,
  onDone,
}: {
  editor: ReturnType<typeof useConnectionEditor>;
  vendorName: string;
  gives: string;
  onDone: () => void;
}) {
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
        </div>

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
              Disconnect
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
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={editor.isSaving || url.trim() === ""}
          >
            Save
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** Its own words, never a paraphrase — the two failures go two places. */
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
