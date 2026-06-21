import { listApps } from "@/lib/reviews";

export async function GET() {
  const apps = await listApps();
  return Response.json({ apps });
}
