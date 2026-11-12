const CELLS = [0, 1, 2].flatMap((row) =>
  [0, 1, 2].map((col) => [col, row] as const)
);

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`logo-mark ${className}`}
      aria-hidden
      focusable="false"
    >
      <rect width="24" height="24" rx="5.25" fill="#12151a" />
      {CELLS.map(([col, row]) => {
        const centre = col === 1 && row === 1;
        return (
          <rect
            key={`${col}${row}`}
            className={centre ? "logo-centre" : undefined}
            x={3.5 + col * 6}
            y={3.5 + row * 6}
            width="4.9"
            height="4.9"
            rx="0.85"
            fill={centre ? "#e0554f" : "#3f9e6a"}
          />
        );
      })}
      <rect
        className="logo-scan"
        x="2"
        y="2"
        width="1"
        height="20"
        fill="#bfdbfe"
      />
    </svg>
  );
}
