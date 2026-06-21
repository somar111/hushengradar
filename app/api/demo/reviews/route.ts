import { NextRequest } from "next/server";
import { getApp, getDefaultApp, queryReviews } from "@/lib/reviews";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const appId = params.get("appId") || undefined;
  const tag = params.get("tag") || undefined;
  const locale = params.get("locale") || undefined;
  const ratingParam = params.get("rating");
  const rating = ratingParam ? Number(ratingParam) : undefined;
  const q = params.get("q") || undefined;
  const since = params.get("since") || undefined;
  const page = Math.max(1, Number(params.get("page") || "1"));
  const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize") || "20")));

  const app = appId ? await getApp(appId) : await getDefaultApp();
  const { items, total } = await queryReviews({ appId: app.id, tag, locale, rating, q, since, page, pageSize });

  return Response.json({ items, total, page, pageSize });
}
