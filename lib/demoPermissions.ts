/** Demo「重跑分类」等仅本地维护者启用的能力；生产与其它开发者环境不设此变量即可。 */
export function canUseDemoReclassify(): boolean {
  return process.env.DEMO_RECLASSIFY_ENABLED === "true";
}
