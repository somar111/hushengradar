import { listApps, getLatestReviewDate } from "@/lib/reviews";

export async function GET() {
  const apps = await listApps();
  // 前端要拿这个去算"最近一月/一周"的时间窗口锚点，不能等选中某个App后才单独再查一次
  const withLatestDate = await Promise.all(
    apps.map(async (app) => ({ ...app, latestReviewDate: await getLatestReviewDate(app.id) }))
  );
  return Response.json({ apps: withLatestDate });
}
