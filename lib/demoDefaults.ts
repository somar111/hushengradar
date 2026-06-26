import type { AppRow } from "./supabase";

/** Demo 面板默认展示的 Google Play App（Honor of Kings 国际版） */
export const DEFAULT_DEMO_APP_EXTERNAL_ID = "com.levelinfinite.sgameGlobal";

export const DEFAULT_DEMO_TIME_RANGE = "month" as const;

export function resolveDefaultDemoApp(apps: AppRow[]): AppRow | undefined {
  if (!apps.length) return undefined;
  return apps.find((a) => a.external_id === DEFAULT_DEMO_APP_EXTERNAL_ID) ?? apps[0];
}
