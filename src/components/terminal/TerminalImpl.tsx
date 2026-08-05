import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ComponentProps } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useThemeStore } from "@/stores/themeStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Terminal as TerminalIcon } from "lucide-react";
import { useGenericTerminalSession } from "@/hooks/useGenericTerminalSession";

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
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const { theme } = useThemeStore();

  const onOutput = useCallback((data: string) => {
    xtermRef.current?.write(data);
  }, []);

  const onSessionClose = useCallback((closureStatus?: string | null) => {
    if (xtermRef.current && closureStatus) {
      xtermRef.current.writeln(
        `\r\n\x1b[33mSession ended: ${closureStatus}\x1b[0m`
      );
    }
  }, []);

  const { status, error, send, resize, disconnect } = useGenericTerminalSession(
    {
      sessionId,
      onOutput,
      onClose: onSessionClose,
    }
  );

  const isDark = theme === "dark";
  const terminalTheme = useMemo(
    () =>
      isDark
        ? {
            background: "#1a1a2e",
            foreground: "#e4e4e7",
            cursor: "#3b82f6",
            selectionBackground: "#3b82f680",
            black: "#09090b",
            red: "#ef4444",
            green: "#22c55e",
            yellow: "#eab308",
            blue: "#3b82f6",
            magenta: "#a855f7",
            cyan: "#06b6d4",
            white: "#fafafa",
            brightBlack: "#52525b",
            brightRed: "#f87171",
            brightGreen: "#4ade80",
            brightYellow: "#facc15",
            brightBlue: "#60a5fa",
            brightMagenta: "#c084fc",
            brightCyan: "#22d3ee",
            brightWhite: "#ffffff",
          }
        : {
            background: "#fafafa",
            foreground: "#18181b",
            cursor: "#2563eb",
            selectionBackground: "#3b82f640",
            black: "#09090b",
            red: "#dc2626",
            green: "#16a34a",
            yellow: "#ca8a04",
            blue: "#2563eb",
            magenta: "#9333ea",
            cyan: "#0891b2",
            white: "#f4f4f5",
            brightBlack: "#71717a",
            brightRed: "#ef4444",
            brightGreen: "#22c55e",
            brightYellow: "#eab308",
            brightBlue: "#3b82f6",
            brightMagenta: "#a855f7",
            brightCyan: "#06b6d4",
            brightWhite: "#ffffff",
          },
    [isDark]
  );

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

    // Handle resize
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

  const terminalBackground = terminalTheme.background;

  const statusLabel = (() => {
    switch (status) {
      case "connecting":
        return "Connecting";
      case "connected":
        return "Connected";
      case "closed":
        return "Ended";
      case "error":
        return "Error";
      default:
        return "Idle";
    }
  })();

  const statusVariant: ComponentProps<typeof Badge>["variant"] = (() => {
    switch (status) {
      case "connected":
        return "success";
      case "error":
        return "error";
      case "connecting":
        return "secondary";
      case "closed":
        return "secondary";
      default:
        return "outline";
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
          <Badge variant={statusVariant}>{statusLabel}</Badge>
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
              aria-label="Close terminal"
            >
              ×
            </Button>
          )}
        </div>
      </div>
      <div
        ref={terminalRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{ backgroundColor: terminalBackground }}
      />
    </div>
  );
}
