import { useEffect, useRef, useState } from "react";
import { isRemote, type ConnDriver, type RemoteDriver } from "../api/types";
import mongoLogo from "../assets/logos/mongodb.svg";
import mysqlLogo from "../assets/logos/mysql.svg";
import pgLogo from "../assets/logos/postgresql.svg";
import redisLogo from "../assets/logos/redis.svg";
import sqliteLogo from "../assets/logos/sqlite.svg";

/** 선택기에는 DB 드라이버만 나온다 (파일 접속 로고는 별도 작업) */
type Driver = Exclude<ConnDriver, RemoteDriver>;

/** 공식 로고 (출처: src/assets/logos/NOTICE.md) */
export const DRIVER_INFO: Record<Driver, { name: string; logo: string }> = {
  postgres: { name: "PostgreSQL", logo: pgLogo },
  mysql: { name: "MySQL / MariaDB", logo: mysqlLogo },
  sqlite: { name: "SQLite", logo: sqliteLogo },
  redis: { name: "Redis", logo: redisLogo },
  mongodb: { name: "MongoDB", logo: mongoLogo },
};

/** 글자 크기에 맞춘 작은 로고 */
export function DbLogo({ driver, size = 14 }: { driver: ConnDriver; size?: number }) {
  if (isRemote(driver)) return null;
  return <img src={DRIVER_INFO[driver].logo} width={size} height={size} alt="" className="db-logo" />;
}

/** 로고가 붙은 드라이버 선택 상자 (기본 select는 옵션에 이미지를 넣을 수 없어 직접 만든다) */
export function DriverSelect({ value, onChange }: { value: ConnDriver; onChange: (d: Driver) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const drivers = Object.keys(DRIVER_INFO) as Driver[];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // 목록이 열려 있으면 Escape는 목록만 닫는다 (대화상자의 Escape보다 먼저 받는다)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const pick = (d: Driver) => {
    onChange(d);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = isRemote(value) ? 0 : drivers.indexOf(value);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(drivers[(i + (e.key === "ArrowDown" ? 1 : drivers.length - 1)) % drivers.length]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((o) => !o);
    }
  };
  return (
    <div className="driver-select" ref={ref}>
      <button type="button" className="select-like" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} onKeyDown={onKeyDown}>
        <DbLogo driver={value} />
        <span>{isRemote(value) ? value : DRIVER_INFO[value].name}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="select-list" role="listbox">
          {drivers.map((d) => (
            <div key={d} role="option" aria-selected={d === value} className={`item${d === value ? " selected" : ""}`} onMouseDown={() => pick(d)}>
              <DbLogo driver={d} />
              <span>{DRIVER_INFO[d].name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
