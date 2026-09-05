const common = {
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

type IconProps = { className?: string; style?: React.CSSProperties };

function Logs({ className, style }: IconProps) {
  return (
    <svg {...common} className={`fi ${className ?? ""}`} style={style}>
      <path d="M3 4h14M3 8h9" />
      <path className="fi-logs-dup" d="M3 12h9M3 16h9" />
      <text
        className="fi-logs-count"
        x="15"
        y="9.5"
        fontSize="5"
        fontFamily="var(--font-mono)"
        fill="currentColor"
        stroke="none"
      >
        x3
      </text>
    </svg>
  );
}

function Shell({ className, style }: IconProps) {
  return (
    <svg {...common} className={`fi ${className ?? ""}`} style={style}>
      <path d="M4 6l4 4-4 4" />
      <path className="fi-caret" d="M10 14h5" strokeWidth={2} />
    </svg>
  );
}

function Route({ className, style }: IconProps) {
  return (
    <svg {...common} className={`fi ${className ?? ""}`} style={style}>
      <circle cx="4" cy="14" r="1.75" />
      <circle cx="16" cy="6" r="1.75" />
      <path
        className="fi-route-path"
        pathLength={1}
        d="M5.75 14h3a2 2 0 0 0 2-2V8a2 2 0 0 1 2-2h1.5"
      />
    </svg>
  );
}

function Secret({ className, style }: IconProps) {
  return (
    <svg {...common} className={`fi ${className ?? ""}`} style={style}>
      <rect x="2.5" y="6" width="15" height="8" rx="2" />
      <path className="fi-secret-val" d="M6 10h8" />
      <g className="fi-secret-dots" fill="currentColor" stroke="none">
        <circle cx="7" cy="10" r="1" />
        <circle cx="10" cy="10" r="1" />
        <circle cx="13" cy="10" r="1" />
      </g>
    </svg>
  );
}

function Crd({ className, style }: IconProps) {
  return (
    <svg {...common} className={`fi ${className ?? ""}`} style={style}>
      <rect x="7" y="7" width="6" height="6" rx="1" />
      <path
        className="fi-brace-l"
        d="M5 4a2 2 0 0 0-2 2v2.5L2 10l1 1.5V14a2 2 0 0 0 2 2"
      />
      <path
        className="fi-brace-r"
        d="M15 4a2 2 0 0 1 2 2v2.5l1 1.5-1 1.5V14a2 2 0 0 1-2 2"
      />
    </svg>
  );
}

function Helm({ className, style }: IconProps) {
  return (
    <svg {...common} className={`fi ${className ?? ""}`} style={style}>
      <path d="M3 10h14" />
      <circle cx="4" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16" cy="10" r="1.5" />
      <circle
        className="fi-rev"
        cx="4"
        cy="10"
        r="2.25"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export const FEATURE_ICONS = {
  logs: Logs,
  shell: Shell,
  route: Route,
  secret: Secret,
  crd: Crd,
  helm: Helm,
} as const;

export type FeatureIconKind = keyof typeof FEATURE_ICONS;
