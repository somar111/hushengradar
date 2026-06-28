import { NextRequest } from "next/server";
import { getApp, invalidateAppsCache, updateAppReplySettings } from "@/lib/reviews";
import { getServiceSupabase } from "@/lib/supabase";
import { ensureReplyPlaybookFresh } from "@/lib/replyPlaybook.mjs";
import { isReplySettingsEmpty, normalizeReplySettings } from "@/lib/replySettings.shared.mjs";

type RouteParams = { params: Promise<{ appId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { appId } = await params;
    const app = await getApp(appId);
    return Response.json({ settings: normalizeReplySettings(app.reply_settings) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { appId } = await params;
    const body = await request.json();
    const patch = body?.settings;
    if (!patch || typeof patch !== "object") {
      return Response.json({ error: "settings 必须是对象" }, { status: 400 });
    }
    const settings = await updateAppReplySettings(appId, {
      tone: typeof patch.tone === "string" ? patch.tone : undefined,
      style: typeof patch.style === "string" ? patch.style : undefined,
      contactInfo: typeof patch.contactInfo === "string" ? patch.contactInfo : undefined,
    });

    if (process.env.DEEPSEEK_API_KEY) {
      try {
        const app = await getApp(appId);
        const supabase = getServiceSupabase();
        await ensureReplyPlaybookFresh({
          supabase,
          app: { ...app, reply_settings: settings },
          apiKey: process.env.DEEPSEEK_API_KEY,
        });
        invalidateAppsCache();
      } catch {
        // settings 已保存；playbook 由 cron 补刷
      }
    }

    return Response.json({ settings });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** 供 Demo 首次加载：DB 为空时写入默认 settings（幂等）。 */
export async function PUT(_request: NextRequest, { params }: RouteParams) {
  try {
    const { appId } = await params;
    const app = await getApp(appId);
    if (!isReplySettingsEmpty(app.reply_settings)) {
      return Response.json({ settings: normalizeReplySettings(app.reply_settings), seeded: false });
    }
    const settings = await updateAppReplySettings(appId, {});
    return Response.json({ settings, seeded: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
