import { useLayoutEffect } from 'react';

/**
 * 弹窗定位 hook —— 保证弹出面板永远完整落在视口内。
 *
 * 背景：起点选择器 / 指标选择器都挂在页面下方的工具行里。
 * 用纯 CSS `position: absolute` 会随触发器位置一起下沉，
 * 桌面大屏和 iPad 横屏下弹窗会整体掉出视口，底部「完成」按钮点不到
 * （elementFromPoint 返回 null，实测 footClickable=false）。
 *
 * 方案：fixed 定位 + JS 按触发器实测坐标计算 top，
 * 空间不够时向上弹出；左右也做视口夹紧。
 *
 * 用 useLayoutEffect 而非 useEffect：DOM 提交后同步测量，
 * 避免首帧位置闪跳，也避免与其它弹窗的关闭动画竞态。
 */

const MARGIN = 8;
const GAP = 6;

export function usePopupPosition(
  open: boolean,
  panelRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const panel = panelRef.current;
      const trigger = triggerRef.current;
      if (!panel || !trigger) return;

      const vh = window.innerHeight;
      const vw = window.innerWidth;

      // 先量面板自身高度（去掉 max-height 前的自然高度更有参考价值）
      panel.style.maxHeight = 'none';
      const naturalH = panel.offsetHeight;
      const maxH = Math.min(vh - MARGIN * 2, 520);
      panel.style.maxHeight = `${maxH}px`;
      const panelH = Math.min(naturalH, maxH);

      const t = trigger.getBoundingClientRect();

      // 优先向下弹；下方空间不够则向上弹
      const spaceBelow = vh - t.bottom - GAP - MARGIN;
      const spaceAbove = t.top - GAP - MARGIN;
      let top: number;
      if (spaceBelow >= panelH || spaceBelow >= spaceAbove) {
        top = t.bottom + GAP;
      } else {
        top = Math.max(MARGIN, t.top - GAP - panelH);
      }
      // 仍溢出则贴顶
      if (top + panelH > vh - MARGIN) {
        top = Math.max(MARGIN, vh - MARGIN - panelH);
      }

      // 水平方向：优先左对齐触发器，超出则夹到视口内
      const panelW = panel.offsetWidth;
      let left = t.left;
      if (left + panelW > vw - MARGIN) left = vw - MARGIN - panelW;
      if (left < MARGIN) left = MARGIN;

      // 窄屏：直接铺满可用宽度，比半截露在屏幕外好
      if (vw <= 767) {
        panel.style.width = `${vw - MARGIN * 2}px`;
        panel.style.minWidth = '0';
        left = MARGIN;
      } else {
        panel.style.width = '';
        panel.style.minWidth = '';
      }

      panel.style.top = `${Math.round(top)}px`;
      panel.style.left = `${Math.round(left)}px`;
      panel.style.bottom = 'auto';
      panel.style.transform = 'none';
    };

    place();

    const onResize = () => place();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open, panelRef, triggerRef]);
}
