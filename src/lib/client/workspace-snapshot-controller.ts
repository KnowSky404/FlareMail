export interface WorkspaceSnapshotDecision {
  apply: boolean;
  announceRestore: boolean;
  resetUserScoped: boolean;
}

/** Tracks server-authored snapshot identity without serializing the full mailbox payload. */
export class WorkspaceSnapshotController {
  private appliedIdentity: string | null = null;
  private appliedUserIdentity: string | null = null;
  private hydrated = false;

  accept(identity: string, userIdentity: string): WorkspaceSnapshotDecision {
    if (!identity || identity === this.appliedIdentity) {
      return { apply: false, announceRestore: false, resetUserScoped: false };
    }

    const decision = {
      apply: true,
      announceRestore: !this.hydrated,
      resetUserScoped: Boolean(this.appliedUserIdentity && this.appliedUserIdentity !== userIdentity)
    };
    this.appliedIdentity = identity;
    this.appliedUserIdentity = userIdentity;
    this.hydrated = true;
    return decision;
  }

  noteUser(userIdentity: string): void {
    this.appliedUserIdentity = userIdentity;
  }

  reset(): void {
    this.appliedIdentity = null;
    this.appliedUserIdentity = null;
    this.hydrated = false;
  }
}
