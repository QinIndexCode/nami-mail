export type SettingsLoadTicket = Readonly<{
  requestId: number;
  settingsRevision: number;
}>;

export type SettingsLoadCoordinator = {
  beginLoad: () => SettingsLoadTicket;
  canApplyLoad: (ticket: SettingsLoadTicket) => boolean;
  recordSettingsChange: () => void;
};

export function createSettingsLoadCoordinator(): SettingsLoadCoordinator {
  let latestRequestId = 0;
  let settingsRevision = 0;

  return {
    beginLoad: () => ({ requestId: ++latestRequestId, settingsRevision }),
    canApplyLoad: (ticket) => ticket.requestId === latestRequestId && ticket.settingsRevision === settingsRevision,
    recordSettingsChange: () => {
      settingsRevision += 1;
    },
  };
}
