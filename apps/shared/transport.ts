import { z } from 'zod';
export const watchStateSchema = z.object({ revision: z.number().int().nonnegative(), watching: z.boolean() });
export type WatchState = z.infer<typeof watchStateSchema>;
export const REFRESH_TIMING = { pollMs: 750, debounceMs: 200, minIntervalMs: 700 } as const;
