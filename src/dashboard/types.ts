export type RunState =
  | "starting"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "stale"
  | "unknown";

export type RunEvent = {
  at?: string;
  stage: string;
  details: Record<string, string>;
};

export type RunProgress = {
  completed: number;
  total?: number;
  label: string;
  active?: string[];
  failed?: number;
  blocked?: number;
};

export type GateSummary = {
  name: string;
  outcome: string;
  command?: string;
  exitCode?: string;
};

export type WorkTaskSummary = {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
};

export type WorkSummary = {
  goal?: string;
  tasks: WorkTaskSummary[];
};

export type DispatchItemSummary = {
  id: string;
  title: string;
  status: string;
  progress?: RunProgress;
  work?: WorkSummary;
  elapsedMs?: number;
  estimatedRemainingMs?: number;
};

export type DispatchSummary = {
  goal?: string;
  items: DispatchItemSummary[];
  completedKnownTasks: number;
  totalKnownTasks: number;
  estimatedRemainingMs?: number;
  estimateBasis: number;
  unplannedItems: number;
};

export type ActivitySummary = {
  label: string;
  detail?: string;
};

export type RunHealth = {
  state: RunState;
  process: "alive" | "dead" | "unverified";
  warning?: string;
};

export type RunSummary = {
  id: string;
  project?: string;
  workflow?: string;
  stage?: string;
  operation?: string;
  gate?: string;
  binding?: string;
  profile?: string;
  lastActivity: string;
  health: RunHealth;
  backlog?: RunProgress;
  backlogWork?: WorkSummary;
  dispatch?: DispatchSummary;
  tasks?: RunProgress;
  work?: WorkSummary;
  activity?: ActivitySummary;
  gates: GateSummary[];
  failure?: string;
  events: RunEvent[];
  warnings: string[];
  category?: "active" | "attention" | "recent";
  attemptCount?: number;
  archived?: boolean;
};

export type ProfileSummary = {
  name: string;
  enabled: boolean;
  profileClass: string;
  activeAssignments: number;
  capacityClass: string;
  circuitState: string;
};

export type DashboardSnapshot = {
  generatedAt: string;
  runs: RunSummary[];
  profiles: ProfileSummary[];
  discoveredRunCount: number;
  view: "current" | "history";
};
