import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

interface ConfirmReq {
  title: string;
  body: string;
  okLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface UiState {
  toasts: Toast[];
  confirm: ConfirmReq | null;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  confirm: null,
  toast: (text, kind = "info") => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 8000 : 3000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (text: string, kind?: Toast["kind"]) => useUi.getState().toast(text, kind);

/** 확인 대화상자. true = 확인 */
export function confirmDialog(opts: { title: string; body: string; okLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.setState({
      confirm: {
        title: opts.title,
        body: opts.body,
        okLabel: opts.okLabel ?? "확인",
        danger: opts.danger ?? false,
        resolve: (ok) => {
          useUi.setState({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}

export interface PromptField {
  label: string;
  value: string;
  placeholder?: string;
  /** select로 고르게 할 때 */
  options?: { value: string; label: string }[];
}

interface PromptReq {
  title: string;
  fields: PromptField[];
  okLabel: string;
  hint?: string;
  resolve: (values: string[] | null) => void;
}

export const usePrompt = create<{ req: PromptReq | null }>(() => ({ req: null }));

/** 입력 대화상자. 취소하면 null */
export function promptDialog(opts: { title: string; fields: PromptField[]; okLabel?: string; hint?: string }): Promise<string[] | null> {
  return new Promise((resolve) =>
    usePrompt.setState({
      req: {
        title: opts.title,
        fields: opts.fields,
        okLabel: opts.okLabel ?? "확인",
        hint: opts.hint,
        resolve: (v) => {
          usePrompt.setState({ req: null });
          resolve(v);
        },
      },
    }),
  );
}
