/** 기본 페이지 크기. 백엔드 db/exec.rs의 PAGE와 같다 */
export const DEFAULT_PAGE_SIZE = 500;
export const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000, 5000, 10000];
/** 직접 입력 상한 (백엔드 MAX_PAGE와 같다) */
export const MAX_PAGE_SIZE = 100_000;
