// 用 Postgres 直连执行 supabase/migrations/ 下尚未应用的 SQL 迁移。
// 用法：node scripts/migrate.mjs（自动读项目根 .env.local 里的 DATABASE_URL）
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 cron 脚本一致：没显式 export 时从 .env.local 补环境变量 */
function loadEnvLocal() {
  const path = join(rootDir, ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvLocal();

const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL（或 SUPABASE_DB_URL）");
  console.error("请在 .env.local 添加 Session pooler 连接串（不要用 Direct db.*.supabase.co，易连不上）：");
  console.error("Supabase → Project Settings → Database → Connection string → Session pooler → URI");
  console.error("用户格式：postgresql://postgres.[project-ref]:[password]@aws-1-[region].pooler.supabase.com:5432/postgres");
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase/migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

await client.query(`
  create table if not exists public._schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  );
`);

const { rows: applied } = await client.query("select filename from public._schema_migrations");
const done = new Set(applied.map((r) => r.filename));

let count = 0;
for (const file of files) {
  if (done.has(file)) {
    console.log(`跳过（已应用） ${file}`);
    continue;
  }
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  console.log(`应用 ${file} ...`);
  await client.query(sql);
  await client.query("insert into public._schema_migrations (filename) values ($1)", [file]);
  console.log(`完成 ${file}`);
  count++;
}

await client.end();
console.log(count ? `\n共应用 ${count} 个迁移。` : "\n没有待应用的迁移。");
