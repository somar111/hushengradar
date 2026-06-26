import { NextRequest } from "next/server";
import { canUseDemoReclassify } from "@/lib/demoPermissions";
import { reclassifyReviewsMatching } from "@/lib/reclassifyReviews";
import { getApp, getDefaultApp, ReclassifyLimitError } from "@/lib/reviews";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!canUseDemoReclassify()) {
    return Response.json({ error: "暂无权限" }, { status: 403 });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY 未配置，无法重跑分类" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const appId = typeof body?.appId === "string" ? body.appId : undefined;
  const tag = typeof body?.tag === "string" ? body.tag : undefined;
  const subTag = typeof body?.subTag === "string" ? body.subTag : undefined;
  const locale = typeof body?.locale === "string" ? body.locale : undefined;
  const q = typeof body?.q === "string" ? body.q : undefined;
  const since = typeof body?.since === "string" ? body.since : undefined;
  const repliedParam = body?.replied;
  const replied = repliedParam === true ? true : repliedParam === false ? false : undefined;

  if (!tag) {
    return Response.json({ error: "请先选择问题类型" }, { status: 400 });
  }

  try {
    const app = appId ? await getApp(appId) : await getDefaultApp();
    const result = await reclassifyReviewsMatching(app, {
      appId: app.id,
      tag,
      subTag,
      locale,
      q,
      since,
      replied,
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof ReclassifyLimitError) {
      return Response.json({ error: e.message, total: e.total }, { status: 400 });
    }
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
