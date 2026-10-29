import { useEffect, useState } from 'react';

/**
 * 响应式断点 hook（客户端渲染，无 SSR）。
 * 用于把「手机端」整体切换到币安式精简布局，桌面端完全不动。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    handler();
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** 手机断点：≤767px（与现有 styles.css 的 max-width:767px 一致） */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}
