// locale 只是「用哪组 lang/country 参数抓到这条」，不代表真实评论语言，纯展示用。
//
// 短称覆盖表：只收录想要更口语化短名的地区（「印尼」比「印度尼西亚」顺口，「沙特」比「沙特阿拉伯」顺口）。
// 没收录的地区会自动 fallback 到 Intl.DisplayNames 生成。
export const localeLabelOverrides: Record<string, string> = {
  en_us: "英语 · 美国",
  id_id: "印尼语 · 印尼",
  es_mx: "西班牙语 · 墨西哥",
  ar_sa: "阿拉伯语 · 沙特",
  pt_br: "葡萄牙语 · 巴西",
  hi_in: "印地语 · 印度",
  fr_fr: "法语 · 法国",
  de_de: "德语 · 德国",
  ru_ru: "俄语 · 俄罗斯",
  vi_vn: "越南语 · 越南",
  th_th: "泰语 · 泰国",
  tr_tr: "土耳其语 · 土耳其",
  ja_jp: "日语 · 日本",
  ko_kr: "韩语 · 韩国",
  zh_tw: "中文 · 台湾",
};

let languageNames: Intl.DisplayNames | null = null;
let regionNames: Intl.DisplayNames | null = null;
try {
  languageNames = new Intl.DisplayNames(["zh"], { type: "language" });
  regionNames = new Intl.DisplayNames(["zh"], { type: "region" });
} catch {
  // 老环境没有 Intl.DisplayNames，fallback 失效时退化成裸 code
}

export function localeLabel(locale: string | null | undefined): string {
  if (!locale) return "未知";
  if (localeLabelOverrides[locale]) return localeLabelOverrides[locale];
  const [lang, country] = locale.split("_");
  if (languageNames && regionNames && lang && country) {
    try {
      return `${languageNames.of(lang)} · ${regionNames.of(country.toUpperCase())}`;
    } catch {
      // code 不被识别时退化成裸 code
    }
  }
  return locale;
}
