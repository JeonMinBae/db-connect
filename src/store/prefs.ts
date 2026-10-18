import { create } from "zustand";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../grid/constants";

const KEY = "dbc.pageSize";

function load(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_SIZE ? n : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** 앱 전체 표시 설정 (이 PC에만 저장) */
export const usePrefs = create<{ pageSize: number; setPageSize: (n: number) => void }>((set) => ({
  pageSize: load(),
  setPageSize: (n) => {
    set({ pageSize: n });
    try {
      localStorage.setItem(KEY, String(n));
    } catch {
      // 저장하지 못해도 이번 실행에서는 쓴다
    }
  },
}));
