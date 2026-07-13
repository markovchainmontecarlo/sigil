import type { ProcessIdentity } from "./process-identity.js";

export type OwnedProcessKind = "acp" | "codex-app-server" | "pty" | "shell" | "gate";

export type OwnedProcessInfo = {
  identity: ProcessIdentity;
  ownerIdentity: ProcessIdentity;
  kind: OwnedProcessKind;
  processGroupId: number;
};

export type ProcessLifecycle = {
  started?(process: OwnedProcessInfo): void | Promise<void>;
  stopped?(process: OwnedProcessInfo): void | Promise<void>;
};
