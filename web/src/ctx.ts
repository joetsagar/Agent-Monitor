import { createContext, useContext } from "react";
import type { Agent, Interaction, InteractionResponse, Session } from "../../shared/types";
import type { Bootstrap, MonitorState } from "./api";

export interface Scope { projectId: string | "all" }

export interface AppCtx {
  state: MonitorState;
  boot: Bootstrap | null;
  billingMode: "subscription" | "api";
  demo: boolean;
  openDrawer: (agentId: string, interactionId?: string) => void;
  respond: (i: Interaction, r: InteractionResponse, clientRequestId: string) => Promise<void>;
}

export const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("no context");
  return c;
}

export function inScope<T extends { projectId: string }>(list: T[], scope: Scope): T[] {
  return scope.projectId === "all" ? list : list.filter((x) => x.projectId === scope.projectId);
}

export function sessionOf(state: MonitorState, id: string): Session | undefined {
  return state.sessions.find((s) => s.id === id);
}
export function agentOf(state: MonitorState, id: string): Agent | undefined {
  return state.agents.find((a) => a.id === id);
}
export function projectName(state: MonitorState, id: string): string {
  return state.projects.find((p) => p.id === id)?.name ?? "Unknown project";
}
