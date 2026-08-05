import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Terminal as TerminalIcon } from "lucide-react";
import { useGenericTerminalSession } from "@/hooks/useGenericTerminalSession";

/** Used only if `--canvas` cannot be read; matches the dark canvas token. */
const CANVAS_FALLBACK = "rgb(26, 28, 30)";

/**
 * The canvas colour as a literal xterm can parse.
 *
 * xterm needs a colour string, not a class, so the terminal cannot inherit
 * `bg-canvas` and used to hardcode a bluish `#1a1a2e` that read as a panel
 * floating on the page. Reading the token keeps it exactly the page colour.
 * It is resolved through a probe element rather than passed as `hsl(...)`
 * because xterm parses `#rrggbb` and `rgb()` directly and hands anything else
 * to a canvas 2D context it may fail to acquire.
 */
function readCanvasTheme(): { background: string; dark: boolean } {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const token = getComputedStyle(root).getPropertyValue("--canvas").trim();
  if (!token) return { background: CANVAS_FALLBACK, dark };

  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:hsl(${token})`;
  document.body.appendChild(probe);
  const background = getComputedStyle(probe).color;
  probe.remove();

  return { background: background || CANVAS_FALLBACK, dark };
}

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
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);
  const { background, dark: isDark } = useCanvasTheme();

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

  // The sixteen ANSI slots stay literal: they are terminal semantics a program
  // addresses by index, not app chrome.
  const terminalTheme = useMemo(
    () =>
      isDark
        ? {
            background,
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
            background,
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
    [isDark, background]
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
