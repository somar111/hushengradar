import gplayPkg from "google-play-scraper";

const gplay = (gplayPkg as unknown as { default?: typeof gplayPkg }).default ?? gplayPkg;

// google-play-scraper 的 .d.ts 把 sort 错误地标成枚举值类型而非枚举命名空间，
// 导致 gplay.sort.NEWEST 在类型层面访问不到，这里按官方文档的实际值（2 = NEWEST）写死
const SORT_NEWEST = 2;

export type RawGooglePlayReview = {
  id: string;
  userName: string;
  date: string;
  score: number;
  text: string;
  version: string | null;
  replyDate: string | null;
  replyText: string | null;
};

/**
 * 通用 Google Play 评论增量抓取：按 Newest 排序翻页，抓到比 sinceDate 早的就停。
 * 不针对任何具体 App，packageName 完全由调用方传入。
 */
export async function fetchReviewsSince(
  packageName: string,
  sinceDate: Date,
  opts: { lang?: string; country?: string; maxPages?: number } = {}
): Promise<RawGooglePlayReview[]> {
  const { lang = "en", country = "us", maxPages = 40 } = opts;
  const all: RawGooglePlayReview[] = [];
  let token: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const res = await gplay.reviews({
      appId: packageName,
      sort: SORT_NEWEST,
      num: 150,
      lang,
      country,
      paginate: true,
      nextPaginationToken: token,
    });

    if (!res.data.length) break;
    all.push(
      ...res.data.map((r) => ({
        id: r.id,
        userName: r.userName,
        date: r.date,
        score: r.score,
        text: r.text ?? "",
        version: r.version ?? null,
        replyDate: r.replyDate ?? null,
        replyText: r.replyText ?? null,
      }))
    );

    const oldest = res.data[res.data.length - 1];
    if (new Date(oldest.date) < sinceDate) break;
    if (!res.nextPaginationToken) break;
    token = res.nextPaginationToken;
    await new Promise((r) => setTimeout(r, 300));
  }

  return all.filter((r) => new Date(r.date) >= sinceDate);
}
