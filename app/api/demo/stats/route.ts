import { NextRequest } from "next/server";
import { getDefaultApp, computeStats } from "@/lib/reviews";

export async function GET(request: NextRequest) {
  const locale = request.nextUrl.searchParams.get("locale") || undefined;
  const app = await getDefaultApp();
  const stats = await computeStats(app.id, locale);
  return Response.json(stats);
}
