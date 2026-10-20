import { Fragment, useEffect, useRef, useState } from "react";
import type { ConnDriver } from "../api/types";
import mongoLogo from "../assets/logos/mongodb.svg";
import mysqlLogo from "../assets/logos/mysql.svg";
import pgLogo from "../assets/logos/postgresql.svg";
import redisLogo from "../assets/logos/redis.svg";
import sqliteLogo from "../assets/logos/sqlite.svg";
import ftpLogo from "../assets/logos/ftp.svg";
import sftpLogo from "../assets/logos/sftp.svg";
import s3Logo from "../assets/logos/s3.svg";


/** 공식 로고 (출처: src/assets/logos/NOTICE.md) */
export const DRIVER_INFO: Record<ConnDriver, { name: string; logo: string }> = {
  postgres: { name: "PostgreSQL", logo: pgLogo },
  mysql: { name: "MySQL / MariaDB", logo: mysqlLogo },
  sqlite: { name: "SQLite", logo: sqliteLogo },
  redis: { name: "Redis", logo: redisLogo },
  mongodb: { name: "MongoDB", logo: mongoLogo },
  ftp: { name: "FTP / FTPS", logo: ftpLogo },
  sftp: { name: "SFTP", logo: sftpLogo },
  s3: { name: "S3 호환 (AWS·R2·MinIO)", logo: s3Logo },
};

/** 글자 크기에 맞춘 작은 로고 */
export function DbLogo({ driver, size = 14 }: { driver: ConnDriver; size?: number }) {
  return <img src={DRIVER_INFO[driver].logo} width={size} height={size} alt="" className="db-logo" />;
}

/** 로고가 붙은 드라이버 선택 상자 (기본 select는 옵션에 이미지를 넣을 수 없어 직접 만든다) */
export function DriverSelect({ value, onChange }: { value: ConnDriver; onChange: (d: ConnDriver) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const drivers = Object.keys(DRIVER_INFO) as ConnDriver[];
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
  const pick = (d: ConnDriver) => {
    onChange(d);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = drivers.indexOf(value);
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
        <span>{DRIVER_INFO[value].name}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="select-list" role="listbox">
          {drivers.map((d) => (
            <Fragment key={d}>
              {d === "ftp" && <div className="group">파일</div>}
              <div role="option" aria-selected={d === value} className={`item${d === value ? " selected" : ""}`} onMouseDown={() => pick(d)}>
                <DbLogo driver={d} />
                <span>{DRIVER_INFO[d].name}</span>
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
