export type ChatRecoveryContext = {
  incidentId?: string;
  recoveryKind?: string;
};

export type ChatRecoveryOptions = Record<string, never>;

export class AIChatAgent<Env = unknown> {
  env!: Env;
  messages: unknown[] = [];
}
