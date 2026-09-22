export interface SeedMessage { id: string; sender: string; receivedAt: string; text: string; }
export interface SeedThread { id: string; subject: string; messages: SeedMessage[]; }

export const SEED_THREADS: SeedThread[] = [
  { id: "t-1", subject: "Welcome", messages: [
    { id: "m-1", sender: "jane", receivedAt: "2026-09-17T09:00:00.000Z", text: "Hello there" },
  ]},
  { id: "t-2", subject: "Follow up", messages: [
    { id: "m-2", sender: "raj", receivedAt: "2026-09-17T10:00:00.000Z", text: "Circling back" },
    { id: "m-3", sender: "raj", receivedAt: "2026-09-17T10:05:00.000Z", text: "Any update?" },
  ]},
];
