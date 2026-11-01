import { useCallback, useMemo, useRef, useState } from "react";
import type { Interaction, InteractionResponse } from "../../shared/types";
import { respondToInteraction, useMonitor } from "./api";
import type { MonitorState } from "./api";
import { Ctx } from "./ctx";
import type { AppCtx, Scope } from "./ctx";
import { DEMO, demoWouldFail, isDemoId, makeDemo } from "./demo";
import { lsGet, lsSet } from "./util";
import { Drawer } from "./components/Drawer";
import { Header } from "./components/Header";
import { LiveActivity } from "./components/LiveActivity";
import { NeedsYou } from "./components/NeedsYou";
import { UsageSidebar } from "./components/UsageSidebar";

function mergeDemo(s: MonitorState, demo: ReturnType<typeof makeDemo>, ix: Record<string, Interaction>): MonitorState {
  return {
    ...s,
    loaded: true,
    projects: [...s.projects, ...demo.projects],
    sessions: [...s.sessions, ...demo.sessions],
    agents: [...s.agents, ...demo.agents],
    tasks: [...s.tasks, ...demo.tasks],
    interactions: [...s.interactions, ...demo.interactions.map((i) => ix[i.id] ?? i)],
    usage: [...s.usage, ...demo.usage],
    milestones: [...s.milestones, ...demo.milestones].sort((a, b) => b.ts - a.ts).slice(0, 100),
  };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function App() {
  const mon = useMonitor();
  const dispatch = mon.dispatch;
  const [scope, setScope] = useState<Scope>({ projectId: "all" });
  const [drawer, setDrawer] = useState<{ agentId: string; interactionId?: string } | null>(null);
  const [showRequests, setShowRequests] = useState(false);
  const [cleared, setCleared] = useState<Record<string, number>>(() => {
    try {
      const saved = JSON.parse(lsGet("agent-monitor-cleared-v1") ?? "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  });
  const demoData = useMemo(() => (DEMO ? makeDemo(Date.now()) : null), []);
  const [demoIx, setDemoIx] = useState<Record<string, Interaction>>({});
  const demoRef = useRef(demoData);
  const demoIxRef = useRef(demoIx);
  demoIxRef.current = demoIx;

  const fullState = useMemo(
    () => (demoData ? mergeDemo(mon.state, demoData, demoIx) : mon.state),
    [mon.state, demoData, demoIx],
  );
  // Clear only quiet sessions. A later event makes a cleared session visible again.
  const clearable = fullState.sessions.filter((s) =>
    (scope.projectId === "all" || s.projectId === scope.projectId) &&
    ["idle", "ended", "failed", "interrupted", "cancelled"].includes(s.runtimeState) &&
    !fullState.agents.some((a) => a.sessionId === s.id && ["working", "waiting", "blocked"].includes(a.status)) &&
    !(s.lastEventAt <= cleared[s.id])
  );
  const hidden = new Set(fullState.sessions.filter((s) =>
    ["idle", "ended", "failed", "interrupted", "cancelled"].includes(s.runtimeState) &&
    s.lastEventAt <= cleared[s.id]
  ).map((s) => s.id));
  const state: MonitorState = {
    ...fullState,
    sessions: fullState.sessions.filter((s) => !hidden.has(s.id)),
    agents: fullState.agents.filter((a) => !hidden.has(a.sessionId)),
    tasks: fullState.tasks.filter((t) => !hidden.has(t.sessionId)),
    interactions: fullState.interactions.filter((i) => !hidden.has(i.sessionId)),
    usage: fullState.usage.filter((u) => !hidden.has(u.sessionId)),
    milestones: fullState.milestones.filter((m) => !hidden.has(m.sessionId)),
  };
  const saveCleared = (next: Record<string, number>) => {
    setCleared(next);
    lsSet("agent-monitor-cleared-v1", JSON.stringify(next));
    setDrawer(null);
  };
  const billingMode = mon.state.server?.billingMode ?? mon.boot?.billingMode ?? "subscription";

  const patchDemo = useCallback((id: string, patch: Partial<Interaction>) => {
    const base = demoIxRef.current[id] ?? demoRef.current?.interactions.find((i) => i.id === id);
    if (!base) return;
    setDemoIx((cur) => ({ ...cur, [id]: { ...base, ...(cur[id] ?? {}), ...patch, updatedAt: Date.now() } }));
  }, []);

  const respond = useCallback(async (i: Interaction, r: InteractionResponse, clientRequestId: string) => {
    if (isDemoId(i.id)) {
      // Simulated: never touches the server.
      await sleep(700);
      const fail = demoWouldFail(r);
      if (i.kind === "review" && !fail) { patchDemo(i.id, { status: "decided", response: r, statusDetail: "Simulated decision recorded" }); return; }
      patchDemo(i.id, { status: "delivering", response: r, statusDetail: null });
      window.setTimeout(() => {
        if (fail) {
          patchDemo(i.id, { status: "failed", statusDetail: "Simulated delivery failure (response contained the word \"fail\")" });
          window.setTimeout(() => patchDemo(i.id, { status: "pending", response: null, statusDetail: null }), 3000);
        } else {
          patchDemo(i.id, { status: "delivered" });
          window.setTimeout(() => patchDemo(i.id, { status: "resumed" }), 2000);
        }
      }, 1200);
      return;
    }
    const updated = await respondToInteraction(i.id, r, clientRequestId);
    dispatch({ type: "interaction", data: updated });
  }, [dispatch, patchDemo]);

  const openDrawer = useCallback((agentId: string, interactionId?: string) => setDrawer({ agentId, interactionId }), []);

  const ctx: AppCtx = useMemo(() => ({
    state, boot: mon.boot, billingMode, demo: DEMO, openDrawer, respond,
  }), [state, mon.boot, billingMode, openDrawer, respond]);

  return (
    <Ctx.Provider value={ctx}>
      <div className="app app-live app-desktop">
        {DEMO && <div className="demo-banner" role="note">SIMULATED DATA — demonstration activity and usage. Responses to demo items never reach the server.</div>}
        <div className="monitor-column">
          <Header
            scope={scope} setScope={setScope} conn={mon.conn}
            clearableCount={clearable.length} clearedCount={hidden.size}
            onClearFinished={() => saveCleared({ ...cleared, ...Object.fromEntries(clearable.map((s) => [s.id, s.lastEventAt])) })}
            onShowCleared={() => saveCleared({})}
            lastMessageAt={mon.lastMessageAt} bootError={mon.bootError}
            requestsOpen={showRequests} onToggleRequests={() => setShowRequests((v) => !v)}
          />
          <main tabIndex={-1} aria-label="Live agent activity">
            {showRequests && <div id="pending-requests" className="request-tray"><NeedsYou scope={scope} /></div>}
            {!state.loaded ? <div className="panel muted">Connecting to the backend…</div> : <LiveActivity scope={scope} />}
          </main>
        </div>
        <UsageSidebar />
        {drawer && <Drawer key={drawer.agentId} agentId={drawer.agentId} interactionId={drawer.interactionId} onClose={() => setDrawer(null)} />}
      </div>
    </Ctx.Provider>
  );
}
