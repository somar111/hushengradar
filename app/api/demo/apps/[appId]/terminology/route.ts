import { NextRequest } from "next/server";
import { getApp, updateAppTerminologyGlossary } from "@/lib/reviews";
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
    return Response.json({ glossary });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
