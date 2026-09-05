import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Terminal as TerminalIcon } from "lucide-react";
import { useGenericTerminalSession } from "@/hooks/useGenericTerminalSession";
import type { StatusRole } from "@/lib/status-role";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";
import { readCanvasTheme } from "./canvas-theme";

function useCanvasTheme() {
  const [canvas, setCanvas] = useState(readCanvasTheme);

  useEffect(() => {
    // The theme is a class on <html> written by an effect in App, which is an
    // ancestor — its effect runs *after* this one, so subscribing to the theme
    // store here would read the previous theme's colours. Watching the
    // attribute reads them once they exist, and covers the OS-level flip that
    // the "system" setting resolves to as well.
    const sync = () => setCanvas(readCanvasTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return canvas;
}

export interface TerminalMetadata {
  /** Main title to display (e.g., pod name, command) */
  title: string;
  /** Optional subtitle (e.g., container name, args) */
  subtitle?: string;
}

export interface TerminalProps {
  /** Session ID for this terminal */
  sessionId: string | null;
  /** Display metadata */
  metadata?: TerminalMetadata;
  /** Close handler */
  onClose?: () => void;
}

/**
 * Generic terminal component that works with any session type.
 * Completely decoupled from Kubernetes - just renders a terminal for a given session ID.
 */
export function Terminal({ sessionId, metadata, onClose }: TerminalProps) {
  const t = useT();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const { background, dark: isDark, ansi } = useCanvasTheme();

  const onOutput = useCallback((data: string) => {
    xtermRef.current?.write(data);
  }, []);

  const onSessionClose = useCallback(
    (closureStatus?: string | null) => {
      if (xtermRef.current && closureStatus) {
        xtermRef.current.writeln(
          `\r\n\x1b[33m${t("empty", "terminalSessionEnded", {
            status: closureStatus,
          })}\x1b[0m`
        );
      }
    },
    [t]
  );

  const { status, error, send, resize, disconnect } = useGenericTerminalSession(
    {
      sessionId,
      onOutput,
      onClose: onSessionClose,
    }
  );

  // The sixteen slots come from `--ansi-0..15` in `index.css`, the same
  // table the log viewer paints a run with. They were sixteen hex literals
  // here under a comment calling them terminal semantics — which left the
  // same program's output one colour in Logs and another in Exec, and left
  // this pane with the invisibility the palette exists to fix: black on the
  // dark canvas, white on the light one. xterm wants a colour string, so
  // they are resolved the way the background already is.
  const terminalTheme = useMemo(() => {
    const chrome = isDark
      ? {
          background,
          foreground: "#e4e4e7",
          cursor: "#3b82f6",
          selectionBackground: "#3b82f680",
        }
      : {
          background,
          foreground: "#18181b",
          cursor: "#2563eb",
          selectionBackground: "#3b82f640",
        };
    if (ansi.length !== 16) return chrome;
    const [
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack,
      brightRed,
      brightGreen,
      brightYellow,
      brightBlue,
      brightMagenta,
      brightCyan,
      brightWhite,
    ] = ansi;
    return {
      ...chrome,
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack,
      brightRed,
      brightGreen,
      brightYellow,
      brightBlue,
      brightMagenta,
      brightCyan,
      brightWhite,
    };
  }, [isDark, background, ansi]);

  // Store callbacks in refs to avoid dependency issues
  const sendRef = useRef(send);
  const resizeRef = useRef(resize);
  const disconnectRef = useRef(disconnect);

  useEffect(() => {
    sendRef.current = send;
    resizeRef.current = resize;
    disconnectRef.current = disconnect;
  }, [send, resize, disconnect]);

  // Initialize xterm once on mount
  useEffect(() => {
    if (!terminalRef.current || initializedRef.current) return;
    initializedRef.current = true;

    // Initialize xterm
    const xterm = new XTerm({
      cursorBlink: true,
      fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: terminalTheme,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);
    xterm.open(terminalRef.current);

    // Fit terminal to container
    setTimeout(() => fitAddon.fit(), 0);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    xterm.onData((data) => {
      sendRef.current(data);
    });

    const handleResize = () => {
      fitAddon.fit();
      resizeRef.current(xterm.cols, xterm.rows);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalRef.current);

    return () => {
      initializedRef.current = false;
      resizeObserver.disconnect();
      xterm.dispose();
      // DON'T call disconnect here - session lifecycle is managed by parent component
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update theme dynamically without reconnecting
  useEffect(() => {
    if (xtermRef.current?.options.theme) {
      xtermRef.current.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  /**
   * The session state in the app's one status vocabulary.
   *
   * A filled green chip saying `Connected` was the last one left in the
   * app — every other status is mono text and a role glyph, and the chip
   * was shouting a fact that is true almost all the time. The role is
   * given rather than derived: `statusRole` reads Kubernetes words, and
   * "Connected" is not one of them.
   */
  const [statusCode, statusLabelKey, statusRoleOverride]: [
    string,
    keyof typeof en.action,
    StatusRole,
  ] = (() => {
    switch (status) {
      case "connecting":
        return ["Connecting", "connecting", "pending"];
      case "connected":
        return ["Connected", "connected", "ok"];
      case "closed":
        return ["Ended", "ended", "neutral"];
      case "error":
        return ["Error", "error", "err"];
      default:
        return ["Idle", "idle", "neutral"];
    }
  })();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-fg-fnt" />
          {metadata?.title && (
            <span className="truncate font-mono font-medium text-fg">
              {metadata.title}
            </span>
          )}
          {metadata?.subtitle && (
            <>
              <span className="text-fg-fnt">/</span>
              <span className="truncate font-mono text-fg-mid">
                {metadata.subtitle}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={statusCode} roleOverride={statusRoleOverride}>
            {t("action", statusLabelKey)}
          </StatusBadge>
          {error && status !== "connected" && (
            <span className="max-w-[240px] truncate text-xs text-fg-mut">
              {error}
            </span>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={t("action", "closeTerminal")}
            >
              ×
            </Button>
          )}
        </div>
      </div>
      {/* xterm sizes itself to whole rows and columns, so the remainder of
       *  this box shows through; without the canvas colour on it the terminal
       *  sits inside a black frame. */}
      <div
        ref={terminalRef}
        className="min-h-0 flex-1 overflow-hidden bg-canvas"
      />
    </div>
  );
}
