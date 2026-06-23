"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Mode = "push" | "replace";

// 通用的"状态存进 URL query string"hook，对外接口跟 useState 一样是 [value, setValue]——
// 组件里原来调 setXxx 的地方不用改。值等于默认值时会把对应的 query key 从 URL 里删掉，
// 保持默认视图的 URL 干净。跟具体页面、具体 App、具体数据都无关，换页面/换数据源直接复用。
//
// mode 选 "push" 的字段会产生浏览器历史记录（前进/后退能切换），适合"切换视图"类的状态
// （筛选、切 App、切 tab）；选 "replace" 的不产生历史记录，适合不想让每次操作都占一条
// 后退记录的字段（比如分页）。
export function useQueryState(
  key: string,
  defaultValue: string,
  mode: Mode = "push"
): [string, (value: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(key) ?? defaultValue;

  const setValue = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (!next || next === defaultValue) {
        params.delete(key);
      } else {
        params.set(key, next);
      }
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [key, defaultValue, mode, pathname, router, searchParams]
  );

  return [value, setValue];
}

// 一次改多个 query 参数用这个，不要在一个事件里连着调多个 useQueryState 的 setValue——
// 每个 setValue 都基于同一帧的 searchParams 快照各自发一次 router.push，后一次会覆盖前一次，
// 结果只有最后一个参数生效，其余被悄悄丢掉（之前"选了筛选标签却没反应""切 App 没清掉旧筛选"
// 都是这个竞态）。这个 setter 把多个参数的改动合进同一次 push，从根上避免覆盖。通用，跟具体
// 参数无关——传一个 {key: 值} 的 map，值为空字符串/undefined 表示删掉这个 key。
export function useQueryParams(mode: Mode = "push"): (updates: Record<string, string | undefined>) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, next] of Object.entries(updates)) {
        if (!next) params.delete(key);
        else params.set(key, next);
      }
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [mode, pathname, router, searchParams]
  );
}
