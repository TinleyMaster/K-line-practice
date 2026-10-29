import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 最大高度，默认 88dvh */
  maxHeight?: string;
}

/**
 * 移动端通用底部抽屉（上滑 sheet）。
 * 用于 ☰ 菜单、开仓面板、持仓面板 —— 统一一套 backdrop + 滑动动画。
 * 仅在 .app-mobile 作用域下有样式（见 styles.css），桌面端不使用本组件。
 */
export function BottomSheet({ open, onClose, title, children, maxHeight = '88dvh' }: Props) {
  return (
    <>
      <div
        className={`sheet-backdrop ${open ? 'open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <div
        className={`sheet ${open ? 'open' : ''}`}
        role="dialog"
        aria-modal={open}
        style={{ maxHeight }}
      >
        <div className="sheet-grabber" onClick={onClose} />
        {title && <div className="sheet-title">{title}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </>
  );
}
