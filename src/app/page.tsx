"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { FleetVehicle, LiveShuttle, ShuttleKey } from "@/lib/shuttles";
import { SHUTTLES } from "@/lib/shuttles";
import {
  LARK_DEPARTURE_GRACE_MIN,
  larkHoldBoard,
  type LarkScheduleSnapshot,
} from "@/lib/schedule";
import styles from "./page.module.css";

const ShuttleMap = dynamic(() => import("@/components/ShuttleMap"), {
  ssr: false,
  loading: () => <div className={styles.mapSkeleton} />,
});

type LiveResponse = {
  fetchedAt: string;
  shuttles: LiveShuttle[];
  fleet?: FleetVehicle[];
  error?: string;
};

type RoutesResponse = {
  express: { color: string; stops: Stop[]; line: [number, number][] };
  regular: { color: string; stops: Stop[]; line: [number, number][] };
};

type Stop = { key: string; name: string; lat: number; lon: number };

const POLL_MS = 1_000;

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const sec = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function statusWord(s: LiveShuttle | undefined): string {
  if (!s || s.serviceStatus === "no_bus") return "no bus";
  if (s.serviceStatus === "out_of_service") return "not in service";
  if (s.serviceStatus === "diverted") {
    return s.divertedTo === "regular"
      ? "on Regular"
      : s.divertedTo === "express"
        ? "on Express"
        : "diverted";
  }
  if (s.atLark) return "at Lark";
  const st = (s.state || "").toLowerCase();
  if (st === "moving") return "en route";
  if (st === "idling") return "holding";
  if (st === "off") return "out of service";
  return st || "unknown";
}

type BoardView = {
  label: string;
  name: string;
  etaMin: number | null;
  detail: string | null;
};

function boardForShuttle(
  s: LiveShuttle | undefined,
  holdSlotMin: number | null,
): BoardView {
  if (!s || s.serviceStatus === "no_bus") {
    return {
      label: "Service",
      name: "No bus on this route",
      etaMin: null,
      detail: null,
    };
  }

  // Parked / fueling / off-network — never a next-stop or departure timer.
  if (s.serviceStatus === "out_of_service") {
    return {
      label: "Not in service",
      name: s.assignmentNote ?? "Not rideable",
      etaMin: null,
      detail: s.address,
    };
  }

  // Usual bus is covering the other line — still show live next stop / hold
  // for the route it's actually on (not this line's schedule pretend).
  if (s.serviceStatus === "diverted") {
    const other = s.divertedTo ? SHUTTLES[s.divertedTo].name : "other line";
    if (s.atLark && s.larkSchedule) {
      const snap = s.larkSchedule as LarkScheduleSnapshot;
      const hold = larkHoldBoard(snap, holdSlotMin);
      if (hold.mode === "lark_unscheduled") {
        return {
          label: `On ${other}`,
          name: "Lark Chapel Hill",
          etaMin: null,
          detail: `${s.assignmentNote ?? `Running ${other}`} · departure unknown`,
        };
      }
      return {
        label: `Departing (${other})`,
        name: "Lark Chapel Hill",
        etaMin: hold.etaMin,
        detail: [
          s.assignmentNote ?? `Running ${other} — not ${s.name} service`,
          hold.departAtLabel ? `Scheduled ${hold.departAtLabel}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    if (s.nextStop) {
      return {
        label: `Next on ${other}`,
        name: s.nextStop.name,
        etaMin:
          s.nextStop.etaMin != null
            ? Math.max(0, Math.round(s.nextStop.etaMin))
            : null,
        detail:
          s.assignmentNote ?? `Running ${other} — not ${s.name} service`,
      };
    }
    return {
      label: `On ${other}`,
      name: s.vehicleNumber ?? "Bus",
      etaMin: null,
      detail: s.assignmentNote,
    };
  }

  if (!s.rideable) {
    return {
      label: "Not in service",
      name: s.assignmentNote ?? "Not rideable",
      etaMin: null,
      detail: null,
    };
  }

  if (s.atLark && s.larkSchedule) {
    const snap = s.larkSchedule as LarkScheduleSnapshot;
    const hold = larkHoldBoard(snap, holdSlotMin);
    if (hold.mode === "lark_unscheduled") {
      return {
        label: "At Lark",
        name: "Lark Chapel Hill",
        etaMin: null,
        detail: s.assignmentNote
          ? `${s.assignmentNote} · departure unknown`
          : "Departure time unknown",
      };
    }
    return {
      label: hold.mode === "departing_lark_now" ? "Departing" : "Departing Lark",
      name: "Lark Chapel Hill",
      etaMin: hold.etaMin,
      detail: [
        hold.departAtLabel
          ? `Scheduled ${hold.departAtLabel} · every ${hold.headwayMin} min`
          : `Every ${hold.headwayMin} min`,
        s.assignmentNote,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  if (s.nextStop) {
    return {
      label: "Next stop",
      name: s.nextStop.name,
      etaMin:
        s.nextStop.etaMin != null
          ? Math.max(0, Math.round(s.nextStop.etaMin))
          : null,
      detail: s.assignmentNote,
    };
  }

  return {
    label: "Next stop",
    name: "—",
    etaMin: null,
    detail: s.assignmentNote,
  };
}

function LineBullet({
  line,
  size = "md",
}: {
  line: ShuttleKey;
  size?: "sm" | "md" | "lg";
}) {
  const meta = SHUTTLES[line];
  return (
    <span
      className={`${styles.bullet} ${styles[`bullet_${size}`]}`}
      style={{ background: meta.color }}
      aria-hidden
    >
      {meta.bullet}
    </span>
  );
}

export default function HomePage() {
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [routes, setRoutes] = useState<RoutesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<ShuttleKey | "both">("both");
  const [tick, setTick] = useState(0);
  /** Slot (minutes from midnight) each shuttle started holding for at Lark. */
  const holdSlots = useRef<Partial<Record<ShuttleKey, number | null>>>({
    express: null,
    regular: null,
  });
  const [, setHoldEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/routes")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setRoutes(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const data = (await res.json()) as LiveResponse;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) {
          let holdChanged = false;
          for (const s of data.shuttles) {
            const prev = holdSlots.current[s.key] ?? null;
            const trackHold =
              s.atLark &&
              (s.serviceStatus === "active" || s.serviceStatus === "diverted") &&
              s.larkSchedule;

            if (!trackHold) {
              if (prev != null) {
                holdSlots.current[s.key] = null;
                holdChanged = true;
              }
              continue;
            }
            if (prev == null && s.larkSchedule) {
              // First sample inside Lark: hold for the upcoming clock slot,
              // unless we're inside the grace window of the slot that just
              // passed (departing now).
              const snap = s.larkSchedule;
              const target =
                snap.minutesSincePrev <= LARK_DEPARTURE_GRACE_MIN
                  ? snap.prevSlotMin
                  : snap.nextSlotMin;
              holdSlots.current[s.key] = target;
              holdChanged = true;
            }
          }
          setLive(data);
          setError(null);
          if (holdChanged) setHoldEpoch((n) => n + 1);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    pull();
    const id = setInterval(pull, POLL_MS);
    const age = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(age);
    };
  }, []);

  const byKey = useMemo(() => {
    const map = new Map<ShuttleKey, LiveShuttle>();
    live?.shuttles.forEach((s) => map.set(s.key, s));
    return map;
  }, [live]);

  void tick;

  return (
    <main className={styles.shell}>
      <div className={styles.mapPane}>
        <ShuttleMap
          routes={routes}
          shuttles={live?.shuttles ?? []}
          fleet={live?.fleet ?? []}
          focus={focus}
          holdSlots={holdSlots.current}
        />
      </div>

      <aside className={styles.board}>
        <div className={styles.boardHandle} aria-hidden />
        <header className={styles.masthead}>
          <div className={styles.brandBlock}>
            <h1 className={styles.brand}>LARK</h1>
            <p className={styles.brandSub}>Chapel Hill shuttle</p>
          </div>
          <div className={styles.serviceRow} aria-label="Service lines">
            <LineBullet line="express" size="lg" />
            <LineBullet line="regular" size="lg" />
          </div>
        </header>

        <nav className={styles.lineSelect} aria-label="Filter lines">
          {(["both", "express", "regular"] as const).map((key) => {
            const on = focus === key;
            return (
              <button
                key={key}
                type="button"
                className={on ? styles.lineBtnOn : styles.lineBtn}
                onClick={() => setFocus(key)}
                aria-label={
                  key === "both" ? "All lines" : SHUTTLES[key].name
                }
                aria-pressed={on}
              >
                {key === "both" ? (
                  <>
                    <span className={styles.dualBullets}>
                      <LineBullet line="express" size="sm" />
                      <LineBullet line="regular" size="sm" />
                    </span>
                    <span className={styles.lineBtnText}>All</span>
                  </>
                ) : (
                  <>
                    <LineBullet line={key} size="sm" />
                    <span className={styles.lineBtnText}>
                      {SHUTTLES[key].name}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </nav>

        <div className={styles.rolls}>
          {(["express", "regular"] as ShuttleKey[]).map((key) => {
            if (focus !== "both" && focus !== key) return null;
            const s = byKey.get(key);
            const board = boardForShuttle(s, holdSlots.current[key] ?? null);
            return (
              <section key={key} className={styles.roll}>
                <div className={styles.rollHead}>
                  <LineBullet line={key} size="md" />
                  <div className={styles.rollTitle}>
                    <h2>{SHUTTLES[key].name.toUpperCase()}</h2>
                    <p className={styles.toward}>
                      {key === "express"
                        ? "every 15 min from Lark"
                        : "every 30 min from Lark"}
                    </p>
                  </div>
                  <div
                    className={styles.liveTag}
                    data-state={
                      !s ||
                      s.serviceStatus === "no_bus" ||
                      s.serviceStatus === "out_of_service"
                        ? "off"
                        : s.serviceStatus === "diverted"
                          ? "idling"
                          : s.atLark
                            ? "idling"
                            : (s.state || "").toLowerCase()
                    }
                  >
                    {statusWord(s)}
                  </div>
                </div>

                <div className={styles.nextBlock}>
                  <div className={styles.nextLabel}>{board.label}</div>
                  <div className={styles.nextRow}>
                    <div className={styles.nextName}>{board.name}</div>
                    <div className={styles.eta}>
                      {board.etaMin != null ? (
                        <>
                          <span className={styles.etaNum}>{board.etaMin}</span>
                          <span className={styles.etaUnit}>min</span>
                        </>
                      ) : (
                        <span className={styles.etaUnit}>
                          {s?.serviceStatus === "active" && s.atLark
                            ? "TBD"
                            : s?.serviceStatus === "diverted" && s.atLark
                              ? "TBD"
                              : "—"}
                        </span>
                      )}
                    </div>
                  </div>
                  {board.detail ? (
                    <div className={styles.metaValue} style={{ marginTop: 6 }}>
                      {board.detail}
                    </div>
                  ) : null}
                </div>

                <div className={styles.metaGrid}>
                  <div className={styles.metaItem}>
                    <div className={styles.metaLabel}>Last reported</div>
                    <div className={styles.metaValue}>
                      {s?.address ?? "Waiting for signal"}
                    </div>
                  </div>
                  <div className={styles.metaItem}>
                    <div className={styles.metaLabel}>Updated</div>
                    <div className={styles.metaValue}>
                      {ageLabel(s?.locatedAt ?? null)}
                      {s?.speed ? ` · ${s.speed}` : ""}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}

        <footer className={styles.footer}>
          Live every 1s · Motive share
          {live?.fetchedAt ? ` · ${ageLabel(live.fetchedAt)}` : ""}
        </footer>
      </aside>
    </main>
  );
}
