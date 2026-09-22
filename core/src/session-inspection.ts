/** Read-only detail returned on demand, outside the fleet snapshot. */
export interface SessionInspection {
  text: string;
  sampledAt: number;
}
export type SessionTab = "chat" | "changes" | "monitor";
