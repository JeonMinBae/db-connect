import { listen } from "@tauri-apps/api/event";
import { api, type Pick } from "../api";

export interface OsDrop {
  pick: Pick;
  /** 물리 픽셀 */
  x: number;
  y: number;
}

/** 드롭을 처리했으면 true. 처리한 쪽이 pick 의 해제까지 책임진다. */
export type DropHandler = (pick: Pick, x: number, y: number) => boolean;

const handlers = new Set<DropHandler>();

export function registerDropHandler(h: DropHandler): () => void {
  handlers.add(h);
  return () => void handlers.delete(h);
}

/** 어느 핸들러도 받지 않은 드롭은 토큰을 해제한다 */
export function routeDrop(e: OsDrop, hs: Iterable<DropHandler>, release: (pickId: string) => void): boolean {
  for (const h of [...hs]) if (h(e.pick, e.x, e.y)) return true;
  release(e.pick.pick_id);
  return false;
}

/** 요소 안의 점인지 (물리 픽셀 좌표를 CSS 픽셀로 바꿔 비교) */
export function insideElement(el: Element | null, x: number, y: number, dpr = window.devicePixelRatio || 1): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cx = x / dpr;
  const cy = y / dpr;
  return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
}

/** 앱 전체에서 한 번만 설치한다. 해제 함수를 돌려준다. */
export function installDropListener(): () => void {
  const un = listen<OsDrop>("os-drop", (ev) => {
    routeDrop(ev.payload, handlers, (id) => void api.pickRelease(id).catch(() => {}));
  });
  return () => void un.then((f) => f());
}
