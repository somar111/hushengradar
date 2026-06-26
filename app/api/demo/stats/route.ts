import { NextRequest } from "next/server";
import { getApp, getDefaultApp, computeStats } from "@/lib/reviews";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const appId = params.get("appId") || undefined;
  const locale = params.get("locale") || undefined;
  const since = params.get("since") || undefined;
  const forceRefresh = params.get("fresh") === "1";
  const app = appId ? await getApp(appId) : await getDefaultApp();
  const stats = await computeStats(app.id, locale, since, undefined, { forceRefresh });
  return Response.json({ ...stats, app: { id: app.id, displayName: app.display_name } });
}
