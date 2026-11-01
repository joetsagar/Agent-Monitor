import { useEffect, useMemo, useState } from "react";
import type { EventRow } from "../../shared/types";
import { fetchAgentEvents } from "./api";
import { useApp } from "./ctx";
import { demoEvents, isDemoId } from "./demo";

/** Seeded from the events endpoint (newest first), merged with live `event` messages. Returns newest first. */
export function useAgentEvents(agentId: string, enabled = true, limit = 300) {
  const { state } = useApp();
  const [seed, setSeed] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = state.epoch;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    if (isDemoId(agentId)) {
      setSeed(demoEvents(agentId, Date.now())); setLoading(false); setError(null);
      return;
    }
    fetchAgentEvents(agentId, limit)
      .then((rows) => { if (!cancelled) { setSeed(rows); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, enabled, epoch, limit]);

  const live = state.liveEvents[agentId];
  const events = useMemo(() => {
    const byId = new Map<number, EventRow>();
    for (const e of seed) byId.set(e.id, e);
    // live rows lack `detail`; keep the richer seeded copy when both exist
    for (const e of live ?? []) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].filter((e) => e.kind !== "marker").sort((a, b) => b.ts - a.ts || b.id - a.id);
  }, [seed, live]);
  return { events, loading, error };
}
