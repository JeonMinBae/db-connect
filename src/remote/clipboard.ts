import { create } from "zustand";
import type { Clip } from "./browser";

/** 앱 전체에서 하나만 쓰는 원격 파일 클립보드. 다른 접속 탭에서도 붙여넣을 수 있다 */
export const useRemoteClip = create<{ clip: Clip | null; setClip: (c: Clip | null) => void }>((set) => ({
  clip: null,
  setClip: (clip) => set({ clip }),
}));
