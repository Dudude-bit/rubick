import { useEffect, useRef, useState, type CSSProperties } from "react";

type Claim = {
  said: string;
  seen: string;
  x: string;
  y: string;
  depth: number;
  rot: string;
  from: [string, string];
  drift: [string, string];
  dur: string;
  delay: string;
};

const CLAIMS: Claim[] = [
  {
    said: "Running",
    seen: "CrashLoopBackOff",
    x: "4%",
    y: "0%",
    depth: 1.1,
    rot: "-4deg",
    from: ["40px", "-30px"],
    drift: ["-6px", "8px"],
    dur: "9s",
    delay: "300ms",
  },
  {
    said: "1/1 Ready",
    seen: "0/1 Ready",
    x: "30%",
    y: "21%",
    depth: 0.6,
    rot: "3deg",
    from: ["-30px", "-40px"],
    drift: ["7px", "5px"],
    dur: "11s",
    delay: "420ms",
  },
  {
    said: "Endpoints: 3",
    seen: "Endpoints: 0",
    x: "2%",
    y: "42%",
    depth: 0.8,
    rot: "-3deg",
    from: ["50px", "10px"],
    drift: ["-5px", "-7px"],
    dur: "10s",
    delay: "540ms",
  },
  {
    said: "Healthy",
    seen: "Degraded",
    x: "28%",
    y: "63%",
    depth: 1.3,
    rot: "4deg",
    from: ["-20px", "40px"],
    drift: ["6px", "-6px"],
    dur: "8.5s",
    delay: "660ms",
  },
  {
    said: "Certificate Ready",
    seen: "Renewal failed",
    x: "8%",
    y: "84%",
    depth: 0.9,
    rot: "-2deg",
    from: ["30px", "40px"],
    drift: ["-8px", "4px"],
    dur: "12s",
    delay: "780ms",
  },
];

type State = "said" | "inspecting" | "busted";

const INSPECT_MS = 450;
const BETWEEN_MS = 2600;
const FIRST_MS = 2200;

function useBusting(count: number) {
  const [states, setStates] = useState<State[]>(() =>
    Array.from({ length: count }, () => "said")
  );
  const next = useRef(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStates(Array.from({ length: count }, () => "busted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const bust = () => {
      const i = next.current;
      if (i >= count) return;
      setStates((s) => s.map((v, j) => (j === i ? "inspecting" : v)));
      timer = setTimeout(() => {
        setStates((s) => s.map((v, j) => (j === i ? "busted" : v)));
        next.current = i + 1;
        timer = setTimeout(bust, BETWEEN_MS);
      }, INSPECT_MS);
    };
    timer = setTimeout(bust, FIRST_MS);
    return () => clearTimeout(timer);
  }, [count]);
  return states;
}

function useOffscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([e]) => {
      el.toggleAttribute("data-offscreen", !e?.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

export function Claims() {
  const states = useBusting(CLAIMS.length);
  const ref = useOffscreen<HTMLDivElement>();
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-[38%] lg:block"
    >
      {CLAIMS.map((c, i) => (
        <span
          key={c.said}
          className="claim absolute"
          style={
            {
              right: c.x,
              top: c.y,
              "--depth": c.depth,
            } as CSSProperties
          }
        >
          <span
            data-state={states[i]}
            className="claim-card grid rounded-full border border-neutral-700/80 bg-neutral-900 px-3.5 py-1.5 font-mono text-[13px]"
            style={
              {
                "--rot": c.rot,
                "--fx": c.from[0],
                "--fy": c.from[1],
                "--dx": c.drift[0],
                "--dy": c.drift[1],
                "--wob": "3deg",
                "--dur": c.dur,
                "--d": c.delay,
              } as CSSProperties
            }
          >
            <span className="claim-said inline-flex items-center gap-2 text-neutral-100 opacity-0 [grid-area:1/1]">
              <span className="claim-dot size-1.5 rounded-full bg-green-400" />
              {c.said}
            </span>
            <span className="claim-seen inline-flex items-center gap-2 text-red-300 [grid-area:1/1]">
              <span className="size-1.5 rounded-full bg-red-400" />
              {c.seen}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
