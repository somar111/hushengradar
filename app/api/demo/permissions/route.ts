import { canUseDemoReclassify } from "@/lib/demoPermissions";

export async function GET() {
  return Response.json({ reclassify: canUseDemoReclassify() });
}
