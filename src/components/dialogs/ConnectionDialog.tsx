import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../../api";
import type { ConnDriver, ConnectionConfig, SslMode } from "../../api/types";
import { useConnections } from "../../store/connections";
import { toast } from "../../store/ui";
import { DriverSelect } from "../dbLogos";
import { Modal } from "../ui";

const DEFAULT_PORT: Record<ConnDriver, number> = { postgres: 5432, mysql: 3306, sqlite: 0, redis: 6379, mongodb: 0, ftp: 21, sftp: 22, s3: 0 };

export function blankConfig(): ConnectionConfig {
  return {
    id: crypto.randomUUID(),
    name: "",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    database: "",
    user: "",
    ssl_mode: "prefer",
    ssl_root_cert: null,
    sqlite_path: "",
    read_only: false,
    color: null,
    redis_db: 0,
    key_separator: ":",
    mongo_uri: "",
    ftp_tls: "none",
    tls_insecure: false,
    fs_encoding: "utf8",
    ssh_key_path: null,
    s3_endpoint: "",
    s3_region: "",
    s3_bucket: "",
    s3_prefix: "",
    s3_path_style: false,
  };
}

/** URI에서 호스트 부분 (이름 자동 생성용) */
const uriHost = (uri: string) => uri.replace(/^mongodb(\+srv)?:\/\//, "").replace(/^[^@/]*@/, "").split(/[/?]/)[0];
/** URI에 비밀번호가 들어 있는지 (user:pass@) */
const uriHasPassword = (uri: string) => /^mongodb(\+srv)?:\/\/[^@/?]*:[^@/?]*@/.test(uri.trim());

/** isNew = 새 접속. 편집일 때 비밀번호 칸을 비워 두면 기존 비밀번호를 유지한다. */
export function ConnectionDialog(props: { initial: ConnectionConfig; isNew: boolean; onClose: () => void }) {
  const [cfg, setCfg] = useState(props.initial);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useConnections((s) => s.save);
  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const d = cfg.driver;
  const isLite = d === "sqlite";
  const isRedis = d === "redis";
  const isMongo = d === "mongodb";
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(cfg.host.trim().toLowerCase());
  // 인증서를 검증하지 않는 모드로 원격 서버에 접속하면 경고한다
  const weakTls = !isLite && !isMongo && !isLocal && ["disable", "prefer", "require"].includes(cfg.ssl_mode);

  // 편집 시 비밀번호 칸이 비어 있으면 null(유지), "삭제" 체크 시 "" 전달
  const pwArg = (): string | null => (clearPassword ? "" : password ? password : props.isNew ? "" : null);

  const changeDriver = (nd: ConnDriver) => {
    setTestResult(null);
    setCfg((c) => ({
      ...c,
      driver: nd,
      port: DEFAULT_PORT[nd] || c.port,
      // Redis는 로컬에서 TLS를 거의 쓰지 않는다
      ssl_mode: nd === "redis" ? "disable" : c.driver === "redis" ? "prefer" : c.ssl_mode,
    }));
  };

  const pickFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }, { name: "All", extensions: ["*"] }] });
    if (typeof path === "string") {
      setCfg((c) => ({ ...c, sqlite_path: path, name: c.name || path.split(/[\\/]/).pop() || c.name }));
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult({ ok: true, text: await api.testConnection(cfg, pwArg()) });
    } catch (e) {
      setTestResult({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const autoName = () => {
    if (isLite) return cfg.sqlite_path.split(/[\\/]/).pop();
    if (isMongo) return uriHost(cfg.mongo_uri);
    if (isRedis) return `${cfg.host}:${cfg.port}`;
    return `${cfg.user}@${cfg.host}`;
  };

  const submit = async () => {
    const name = cfg.name.trim() || autoName() || "접속";
    try {
      if (await save({ ...cfg, name }, pwArg())) props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const passwordRow = (
    <>
      <label>비밀번호</label>
      <div className="row">
        <input
          type="password"
          value={password}
          disabled={clearPassword}
          placeholder={props.isNew ? "" : "(변경하지 않으면 비워 두세요)"}
          onChange={(e) => setPassword(e.target.value)}
        />
        {!props.isNew && (
          <label className="hint">
            <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> 삭제
          </label>
        )}
      </div>
    </>
  );

  const hostRow = (
    <>
      <label>호스트 / 포트</label>
      <div className="row">
        <input value={cfg.host} onChange={(e) => set("host", e.target.value)} />
        <input style={{ width: 80, flex: "none" }} type="number" value={cfg.port} onChange={(e) => set("port", Number(e.target.value))} />
      </div>
    </>
  );

  const tlsWarning = weakTls && (
    <div className="full hint" style={{ color: "var(--danger)" }}>
      원격 서버에 인증서를 검증하지 않는 모드로 접속하면 중간자가 TLS를 끄거나 가로채 비밀번호와 데이터를 볼 수 있습니다. 가능하면 인증서 검증을 쓰세요.
    </div>
  );

  return (
    <Modal
      title={props.isNew ? "새 접속" : `접속 편집: ${props.initial.name}`}
      onClose={props.onClose}
      width={520}
      footer={
        <>
          <button onClick={test} disabled={testing}>
            {testing ? "테스트 중…" : "연결 테스트"}
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={props.onClose}>취소</button>
          <button className="primary" onClick={submit}>
            저장
          </button>
        </>
      }
    >
      <div className="form">
        <label>이름</label>
        <input value={cfg.name} onChange={(e) => set("name", e.target.value)} placeholder="(자동)" autoFocus />

        <label>드라이버</label>
        <DriverSelect value={cfg.driver} onChange={changeDriver} />

        {isLite && (
          <>
            <label>파일</label>
            <div className="row">
              <input value={cfg.sqlite_path} onChange={(e) => set("sqlite_path", e.target.value)} />
              <button onClick={pickFile}>찾기…</button>
            </div>
          </>
        )}

        {isMongo && (
          <>
            <label>연결 문자열</label>
            <textarea
              rows={3}
              spellCheck={false}
              value={cfg.mongo_uri}
              placeholder="mongodb://사용자@호스트:27017/DB?authSource=admin  또는  mongodb+srv://…"
              onChange={(e) => set("mongo_uri", e.target.value)}
              style={{ fontFamily: "var(--mono)", resize: "vertical" }}
            />
            {uriHasPassword(cfg.mongo_uri) && <div className="full hint">저장하면 URI의 비밀번호를 떼어 Windows 자격 증명 관리자에 따로 보관합니다.</div>}
            {passwordRow}
            <div className="full hint">TLS·레플리카셋·인증 DB 같은 옵션은 URI에 넣습니다 (예: ?tls=true&amp;replicaSet=rs0&amp;authSource=admin).</div>
          </>
        )}

        {isRedis && (
          <>
            {hostRow}
            <label>사용자 (ACL)</label>
            <input value={cfg.user} placeholder="(선택) 비워 두면 default 사용자" onChange={(e) => set("user", e.target.value)} />
            {passwordRow}
            <label>기본 DB / 구분자</label>
            <div className="row">
              <input type="number" min={0} max={255} value={cfg.redis_db} onChange={(e) => set("redis_db", Math.max(0, Math.min(255, Number(e.target.value) || 0)))} />
              <input
                style={{ width: 80, flex: "none" }}
                value={cfg.key_separator}
                title="키 트리에서 폴더를 나눌 구분자"
                onChange={(e) => set("key_separator", e.target.value)}
              />
            </div>
            <label>TLS</label>
            <select value={cfg.ssl_mode === "prefer" ? "require" : cfg.ssl_mode === "verify-ca" ? "verify-full" : cfg.ssl_mode} onChange={(e) => set("ssl_mode", e.target.value as SslMode)}>
              <option value="disable">사용 안 함</option>
              <option value="require">사용 (인증서 검증 안 함)</option>
              <option value="verify-full">사용 (인증서 검증)</option>
            </select>
            {tlsWarning}
          </>
        )}

        {!isLite && !isMongo && !isRedis && (
          <>
            {hostRow}
            <label>데이터베이스</label>
            <input value={cfg.database} onChange={(e) => set("database", e.target.value)} />
            <label>사용자</label>
            <input value={cfg.user} onChange={(e) => set("user", e.target.value)} />
            {passwordRow}
            <label>SSL</label>
            <select value={cfg.ssl_mode} onChange={(e) => set("ssl_mode", e.target.value as SslMode)}>
              <option value="disable">disable</option>
              <option value="prefer">prefer</option>
              <option value="require">require</option>
              <option value="verify-ca">verify-ca</option>
              <option value="verify-full">verify-full</option>
            </select>
            {tlsWarning}
            <label>루트 인증서</label>
            <div className="row">
              <input value={cfg.ssl_root_cert ?? ""} placeholder="(선택) CA 파일 경로" onChange={(e) => set("ssl_root_cert", e.target.value || null)} />
              <button
                onClick={async () => {
                  const p = await open({ multiple: false });
                  if (typeof p === "string") set("ssl_root_cert", p);
                }}
              >
                찾기…
              </button>
            </div>
          </>
        )}

        <label>색상</label>
        <div className="row">
          <input type="color" value={cfg.color ?? "#3574f0"} onChange={(e) => set("color", e.target.value)} />
          {cfg.color && (
            <button className="icon" onClick={() => set("color", null)}>
              지우기
            </button>
          )}
        </div>

        <label>읽기 전용</label>
        <label className="row">
          <input type="checkbox" checked={cfg.read_only} onChange={(e) => set("read_only", e.target.checked)} />
          <span className="hint">
            {isRedis || isMongo ? "쓰기 명령을 앱에서 거부합니다." : "DB 세션을 읽기 전용으로 엽니다."} 실수 방지 기능이며 보안 기능은 아닙니다.
          </span>
        </label>

        {testResult && (
          <div className="full hint" style={{ color: testResult.ok ? "var(--ok)" : "var(--danger)", whiteSpace: "pre-wrap" }}>
            {testResult.ok ? "✓ " : "✗ "}
            {testResult.text}
          </div>
        )}
      </div>
    </Modal>
  );
}
