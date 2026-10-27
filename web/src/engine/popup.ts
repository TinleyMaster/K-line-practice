/**
 * 弹窗打开标记（body.popup-open）。
 *
 * 作用：弹窗打开时让吸底回放条降级，避免盖住弹窗底部（「完成」按钮点不到）。
 *
 * 用 Set 按 key 计数而非裸数字 —— 两个弹窗组件可能同时挂载/卸载，
 * 裸计数器在 cleanup 时序交错下会错位（一个关闭把另一个的标记也删了）。
 */

const openKeys = new Set<string>();

export function markPopupOpen(key: string, open: boolean) {
  if (open) openKeys.add(key);
  else openKeys.delete(key);
  document.body.classList.toggle('popup-open', openKeys.size > 0);
}
