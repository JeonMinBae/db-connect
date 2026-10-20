import { isRemote, type ConnectionConfig, type RemoteEntry } from "../api/types";
import { parent } from "./path";

export type SortKey = "name" | "size" | "mtime" | "perm";

/** 폴더는 정렬 방향과 무관하게 항상 위 */
export function sortEntries(list: RemoteEntry[], key: SortKey, asc: boolean): RemoteEntry[] {
  const sign = asc ? 1 : -1;
  const byName = (a: RemoteEntry, b: RemoteEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...list].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const d =
      key === "name" ? byName(a, b) : key === "size" ? a.size - b.size : key === "perm" ? (a.perm ?? -1) - (b.perm ?? -1) : (a.mtime ?? 0) - (b.mtime ?? 0); // perm: 없음(null)이 가장 앞
    return d ? sign * d : byName(a, b); // 동률은 방향과 무관하게 이름 오름차순
  });
}

/** 끌기 대상 이름. Ctrl 로 시작한 끌기는 선택에 없던 행을 선택에 더하고, 일반 끌기는 선택에 없으면 그 행만 */
export function dragNames(selected: string[], name: string, additive: boolean): string[] {
  if (selected.includes(name)) return selected;
  return additive ? [...selected, name] : [name];
}

export function visibleEntries(list: RemoteEntry[], opt: { showHidden: boolean; filter: string }) {
  const f = opt.filter.trim().toLowerCase();
  return list.filter((e) => (opt.showHidden || !e.name.startsWith(".")) && (!f || e.name.toLowerCase().includes(f)));
}

/** 이동 기록. back 만 지원한다 (앞으로 가기 없음) */
export class History {
  private stack: string[] = [];
  current: string;
  constructor(start: string) {
    this.current = start;
  }
  clone(): History {
    const h = new History(this.current);
    h.stack = [...this.stack];
    return h;
  }
  push(path: string) {
    if (path === this.current) return;
    this.stack.push(this.current);
    this.current = path;
  }
  back(): string | null {
    const p = this.stack.pop();
    if (p === undefined) return null;
    this.current = p;
    return p;
  }
  /** 루트이면 null */
  up(): string | null {
    const p = parent(this.current);
    if (p === this.current) return null;
    this.push(p);
    return p;
  }
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export function mtimeText(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function permText(perm: number | null): string {
  if (perm === null) return "";
  return "rwxrwxrwx".replace(/./g, (c, i) => (perm & (1 << (8 - i)) ? c : "-"));
}

/** "755", "0644" → 숫자. 8진수 3~4자리가 아니면 null */
export const parseMode = (s: string): number | null => (/^[0-7]{3,4}$/.test(s.trim()) ? parseInt(s.trim(), 8) : null);

/** dest 가 src 자신이거나 그 하위인지 (폴더를 자기 안으로 옮기지 못하게) */

/** 앱 전체 하나뿐인 잘라내기/복사 보관함 (clipboard.ts). 접속이 다르면 복사로만 붙여넣는다 */
export type Clip = { mode: "cut" | "copy"; connId: string; paths: string[] };

/** 같은 접속이면 기존 복사/이동, 다른 접속이면 잘라내기여도 접속 간 복사 */
export const pasteKind = (clip: Clip, connId: string): "copy" | "move" | "cross" => (clip.connId !== connId ? "cross" : clip.mode === "cut" ? "move" : "copy");

/** 접속 간 복사 대상 후보: 원격 접속만, 원본 자신은 빼고, 읽기 전용은 고를 수 없게 표시 */
export function crossTargets(configs: ConnectionConfig[], srcId: string): { cfg: ConnectionConfig; disabled: boolean }[] {
  return configs.filter((c) => isRemote(c.driver) && c.id !== srcId).map((cfg) => ({ cfg, disabled: cfg.read_only }));
}

export const pathsLabel = (paths: string[]): string => (paths.length === 1 ? (paths[0].split("/").pop() ?? paths[0]) : `${paths.length}개 항목`);
