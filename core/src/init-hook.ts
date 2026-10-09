import { z } from "zod";

export const initHookSchema = z.object({
  async: z.boolean().optional(),
  name: z.string(),
  run: z.string().max(65536),
  timeoutMs: z.number().min(1000).max(3600000),
});
export type InitHook = z.infer<typeof initHookSchema>;
