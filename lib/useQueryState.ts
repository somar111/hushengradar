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
