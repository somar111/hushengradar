import { NextRequest } from "next/server";
import { getApp, getDefaultApp, queryReviews, countReviewsReplyBreakdown } from "@/lib/reviews";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const appId = params.get("appId") || undefined;
  const tag = params.get("tag") || undefined;
  const subTag = params.get("subTag") || undefined;
  const locale = params.get("locale") || undefined;
  const ratingParam = params.get("rating");
  const rating = ratingParam ? Number(ratingParam) : undefined;
  const q = params.get("q") || undefined;
  const since = params.get("since") || undefined;
  const repliedParam = params.get("replied");
  const replied = repliedParam === "true" ? true : repliedParam === "false" ? false : undefined;
  const page = Math.max(1, Number(params.get("page") || "1"));
  const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize") || "20")));

  const app = appId ? await getApp(appId) : await getDefaultApp();
  const filterOpts = { appId: app.id, tag, subTag, locale, rating, q, since };
  const [replyCounts, { items, total }] = await Promise.all([
    countReviewsReplyBreakdown(filterOpts),
    queryReviews({ ...filterOpts, replied, page, pageSize }),
  ]);

  return Response.json({ items, total, page, pageSize, replyCounts });
}
