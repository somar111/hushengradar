import { NextRequest } from "next/server";
import { getApp, updateAppTerminologyGlossary, invalidateAppsCache } from "@/lib/reviews";
import { getServiceSupabase } from "@/lib/supabase";
import { ensureReplyPlaybookFresh } from "@/lib/replyPlaybook.mjs";
import type { TerminologyEntry } from "@/lib/supabase";

type RouteParams = { params: Promise<{ appId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { appId } = await params;
    const app = await getApp(appId);
    return Response.json({ glossary: app.terminology_glossary ?? [] });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { appId } = await params;
    const body = await request.json();
    const raw = body?.glossary;
    if (!Array.isArray(raw)) {
      return Response.json({ error: "glossary 必须是数组" }, { status: 400 });
    }
    const glossary = await updateAppTerminologyGlossary(appId, raw as TerminologyEntry[]);
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        const app = await getApp(appId);
        const supabase = getServiceSupabase();
        await ensureReplyPlaybookFresh({
          supabase,
          app: { ...app, terminology_glossary: glossary },
          apiKey: process.env.DEEPSEEK_API_KEY,
        });
        invalidateAppsCache();
      } catch {
        // 术语已保存；playbook 由 cron 补刷
      }
    }
    return Response.json({ glossary });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
