import { useEffect, useState } from 'react';

/**
 * 响应式断点 hook。
 * 用于「移动端用单图 + Tab 切换 / 桌面用双图并排」这类布局分支。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** 断点定义（与 styles.css 保持一致） */
export const BREAKPOINTS = {
  /** 手机 */
  phone: '(max-width: 767px)',
  /** 矮屏横屏（手机横放）：高度不够放两张图 */
  short: '(max-height: 560px) and (orientation: landscape)',
  /** 需要单图 + Tab 切换的场景：手机竖屏，或矮屏横屏 */
  singleChart: '(max-width: 767px), (max-height: 560px) and (orientation: landscape)',
  /** iPad 竖屏及以下 */
  tablet: '(max-width: 1024px)',
  /** 触摸设备 */
  touch: '(pointer: coarse)',
};
