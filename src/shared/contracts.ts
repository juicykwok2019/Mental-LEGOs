import { z } from 'zod';

export const APP_INFO_CHANNEL = 'app:get-info' as const;
export const RENDERER_READY_CHANNEL = 'app:renderer-ready' as const;

export const appInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.literal('win32'),
  phase: z.literal('phase-0'),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export interface MentalLegosDesktopApi {
  getAppInfo(): Promise<AppInfo>;
  reportReady(): Promise<void>;
}
