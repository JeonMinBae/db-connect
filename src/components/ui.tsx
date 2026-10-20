import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { usePrompt, useUi } from "../store/ui";

export function Modal(props: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    // 에디터 자동완성 닫기처럼 안쪽에서 처리한 Escape는 무시한다
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={props.width ? { width: props.width } : undefined}>
        <header>{props.title}</header>
        <div className="body">{props.children}</div>
        <footer>{props.footer}</footer>
      </div>
    </div>
  );
}

export function ConfirmHost() {
  const req = useUi((s) => s.confirm);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), [req]);
  if (!req) return null;
  return (
    <Modal
      title={req.title}
      onClose={() => req.resolve(false)}
      footer={
        <>
          <button onClick={() => req.resolve(false)}>취소</button>
          <button ref={okRef} className={req.danger ? "danger" : "primary"} onClick={() => req.resolve(true)}>
            {req.okLabel}
          </button>
        </>
      }
    >
      {req.body}
    </Modal>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 켜고 끄는 항목. 값이 있으면 체크 자리를 잡아 켜고 꺼도 글자가 밀리지 않는다 */
  checked?: boolean;
}
export type MenuEntry = MenuItem | "sep";

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

let openMenu: ((m: MenuState | null) => void) | null = null;

/** 우클릭 위치에 컨텍스트 메뉴를 연다 */
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) {
  e.preventDefault?.();
  openMenu?.({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    openMenu = setMenu;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      openMenu = null;
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, []);
  // 화면 밖으로 나가지 않게 위치 보정
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 4), y: Math.min(menu.y, window.innerHeight - r.height - 4) });
  }, [menu]);
  if (!menu) return null;
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="sep" />
        ) : (
          <div
            key={i}
            className={`item${it.disabled ? " disabled" : ""}`}
            onClick={() => {
              setMenu(null);
              it.onClick();
            }}
          >
            {it.checked !== undefined && <span className="check">{it.checked ? "✓" : ""}</span>}
            {it.label}
          </div>
        ),
      )}
    </div>
  );
}

/** 드래그로 크기를 바꾸는 분할기 */
export function Splitter(props: { dir: "v" | "h"; size: number; onResize: (size: number) => void; min: number; max: number }) {
  return (
    <div
      className={props.dir === "v" ? "splitter-v" : "splitter-h"}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const start = props.dir === "v" ? e.clientX : e.clientY;
        const base = props.size;
        const move = (ev: PointerEvent) => {
          const d = (props.dir === "v" ? ev.clientX : ev.clientY) - start;
          props.onResize(Math.max(props.min, Math.min(props.max, base + d)));
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}

export function PromptHost() {
  const req = usePrompt((s) => s.req);
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => setValues(req?.fields.map((f) => f.value) ?? []), [req]);
  if (!req) return null;
  const ok = () => req.resolve(values);
  return (
    <Modal
      title={req.title}
      onClose={() => req.resolve(null)}
      width={460}
      footer={
        <>
          <button onClick={() => req.resolve(null)}>취소</button>
          <button className="primary" onClick={ok}>
            {req.okLabel}
          </button>
        </>
      }
    >
      <div className="form" onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && ok()}>
        {req.fields.map((f, i) => (
          <Fragment key={i}>
            <label>{f.label}</label>
            {f.options ? (
              <select value={values[i] ?? ""} onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus={i === 0}
                value={values[i] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
              />
            )}
          </Fragment>
        ))}
        {req.hint && <div className="full hint">{req.hint}</div>}
      </div>
    </Modal>
  );
}
