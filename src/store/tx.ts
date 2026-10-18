import { create } from "zustand";

export interface TxState {
  manual: boolean;
  /** 마지막 커밋/롤백 이후 변경 가능성이 있는 문장을 실행했는지 */
  dirty: boolean;
  /** PG: 오류로 트랜잭션이 중단됨 (Rollback 필요) */
  aborted: boolean;
}

interface TxStore {
  modes: Record<string, TxState>;
  set: (consoleId: string, p: Partial<TxState>) => void;
  clear: (consoleId: string) => void;
}

export const useTx = create<TxStore>((set) => ({
  modes: {},
  set: (id, p) =>
    set((s) => ({ modes: { ...s.modes, [id]: { ...(s.modes[id] ?? { manual: false, dirty: false, aborted: false }), ...p } } })),
  clear: (id) =>
    set((s) => {
      const modes = { ...s.modes };
      delete modes[id];
      return { modes };
    }),
}));

export const manualOf = (consoleId: string) => !!useTx.getState().modes[consoleId]?.manual;
