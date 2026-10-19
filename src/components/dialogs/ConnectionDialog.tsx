import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../../api";
import { isRemote, type ConnDriver, type ConnectionConfig, type SslMode } from "../../api/types";
import { confirmHostKey, useConnections } from "../../store/connections";
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

type S3Preset = "aws" | "r2" | "minio" | "custom";
const S3_PRESETS: Record<Exclude<S3Preset, "custom">, Pick<ConnectionConfig, "s3_endpoint" | "s3_region" | "s3_path_style">> = {
  aws: { s3_endpoint: "", s3_region: "", s3_path_style: false },
  r2: { s3_endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", s3_region: "auto", s3_path_style: true },
  minio: { s3_endpoint: "http://localhost:9000", s3_region: "us-east-1", s3_path_style: true },
};
const guessPreset = (c: ConnectionConfig): S3Preset =>
  !c.s3_endpoint ? "aws" : c.s3_endpoint.includes("r2.cloudflarestorage.com") ? "r2" : c.s3_endpoint === S3_PRESETS.minio.s3_endpoint ? "minio" : "custom";

/** URI에서 호스트 부분 (이름 자동 생성용) */
const uriHost = (uri: string) => uri.replace(/^mongodb(\+srv)?:\/\//, "").replace(/^[^@/]*@/, "").split(/[/?]/)[0];
/** endpoint URL 의 host (파싱 실패 시 빈 문자열) */
const endpointHost = (url: string) => {
  try {
    return new URL(url.trim()).host;
  } catch {
    return "";
  }
};
/** URI에 비밀번호가 들어 있는지 (user:pass@) */
const uriHasPassword = (uri: string) => /^mongodb(\+srv)?:\/\/[^@/?]*:[^@/?]*@/.test(uri.trim());

/** isNew = 새 접속. 편집일 때 비밀번호 칸을 비워 두면 기존 비밀번호를 유지한다. */
export function ConnectionDialog(props: { initial: ConnectionConfig; isNew: boolean; onClose: () => void }) {
  const [cfg, setCfg] = useState(props.initial);
  const [password, setPassword] = useState("");
  const [preset, setPreset] = useState<S3Preset>(() => guessPreset(props.initial));
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useConnections((s) => s.save);
  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const d = cfg.driver;
  const isLite = d === "sqlite";
  const isRedis = d === "redis";
  const isMongo = d === "mongodb";
  const remote = isRemote(d);
  const isSftp = d === "sftp";
  const isS3 = d === "s3";
  const isFtp = d === "ftp";
  const keyMode = isSftp && cfg.ssh_key_path !== null;
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(cfg.host.trim().toLowerCase());
  // 인증서를 검증하지 않는 모드로 원격 서버에 접속하면 경고한다
  const weakTls = !isLite && !isMongo && !remote && !isLocal && ["disable", "prefer", "require"].includes(cfg.ssl_mode);

  // 편집 시 비밀번호 칸이 비어 있으면 null(유지), "삭제" 체크 시 "" 전달
  const pwArg = (): string | null => (clearPassword ? "" : password ? password : props.isNew ? "" : null);

  // 암시적 TLS 는 기본 포트가 990 이라, 기본값(21/990)일 때만 함께 바꾼다
  const changeFtpTls = (t: ConnectionConfig["ftp_tls"]) =>
    setCfg((c) => ({
      ...c,
      ftp_tls: t,
      port: t === "implicit" && c.port === 21 ? 990 : c.ftp_tls === "implicit" && t !== "implicit" && c.port === 990 ? 21 : c.port,
      tls_insecure: t === "none" ? false : c.tls_insecure,
    }));

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
      let text: string;
      try {
        text = await api.testConnection(cfg, pwArg());
      } catch (e) {
        // 호스트 키를 신뢰하기로 했으면 한 번만 다시 시도한다
        if (!(await confirmHostKey(e))) throw e;
        text = await api.testConnection(cfg, pwArg());
      }
      setTestResult({ ok: true, text });
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
    if (isS3) return cfg.s3_bucket.trim() || endpointHost(cfg.s3_endpoint) || "S3";
    return `${cfg.user}@${cfg.host}`;
  };

  const submit = async () => {
    const name = cfg.name.trim() || autoName() || "접속";
    try {
      // 접두어는 앞뒤 '/' 없이 저장한다 (백엔드는 trim 된 값을 가정)
      const s3_prefix = cfg.s3_prefix.replace(/^\/+|\/+$/g, "");
      if (await save({ ...cfg, name, s3_prefix }, pwArg())) props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const passwordRow = (
    <>
      <label>{keyMode ? "passphrase" : isS3 ? "Secret Key" : "비밀번호"}</label>
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

        {isS3 && (
          <>
            <label>프리셋</label>
            <select
              value={preset}
              onChange={(e) => {
                const v = e.target.value as S3Preset;
                setPreset(v);
                if (v !== "custom") setCfg((c) => ({ ...c, ...S3_PRESETS[v] }));
              }}
            >
              <option value="aws">AWS S3</option>
              <option value="r2">Cloudflare R2</option>
              <option value="minio">MinIO</option>
              <option value="custom">직접 입력</option>
            </select>
            <label>Endpoint</label>
            <input value={cfg.s3_endpoint} placeholder="비우면 AWS (https://s3.<리전>.amazonaws.com)" onChange={(e) => set("s3_endpoint", e.target.value)} />
            <label>Region</label>
            <input value={cfg.s3_region} placeholder="AWS 는 비우면 버킷마다 자동 감지" onChange={(e) => set("s3_region", e.target.value)} />
            <label>Access Key</label>
            <input value={cfg.user} onChange={(e) => set("user", e.target.value)} />
            {passwordRow}
            <label>버킷</label>
            <input value={cfg.s3_bucket} placeholder="비우면 버킷 목록 (선택)" onChange={(e) => set("s3_bucket", e.target.value)} />
            <label>접두어</label>
            <input value={cfg.s3_prefix} placeholder="(선택) 예: backups/2024" onChange={(e) => set("s3_prefix", e.target.value)} />
            <label>주소 방식</label>
            <label className="row">
              <input type="checkbox" checked={cfg.s3_path_style} onChange={(e) => set("s3_path_style", e.target.checked)} />
              <span className="hint">path-style (MinIO·R2 등 대부분의 호환 서버)</span>
            </label>
            {cfg.s3_endpoint.trim().startsWith("http://") && !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(endpointHost(cfg.s3_endpoint)) && (
              <div className="full hint" style={{ color: "var(--danger)" }}>
                http 로 접속하면 키와 데이터가 평문으로 전송됩니다.
              </div>
            )}
          </>
        )}

        {remote && !isS3 && (
          <>
            {hostRow}
            <label>사용자</label>
            <input value={cfg.user} onChange={(e) => set("user", e.target.value)} />
            {isSftp && (
              <>
                <label>인증 방식</label>
                <div className="row">
                  <label className="row">
                    <input type="radio" name="ssh-auth" checked={!keyMode} onChange={() => set("ssh_key_path", null)} /> 비밀번호
                  </label>
                  <label className="row">
                    <input type="radio" name="ssh-auth" checked={keyMode} onChange={() => set("ssh_key_path", cfg.ssh_key_path ?? "")} /> 키 파일
                  </label>
                </div>
                {keyMode && (
                  <>
                    <label>키 파일</label>
                    <div className="row">
                      <input value={cfg.ssh_key_path ?? ""} placeholder="개인키 파일 경로" onChange={(e) => set("ssh_key_path", e.target.value)} />
                      <button
                        onClick={async () => {
                          const p = await api.pickKeyFile();
                          if (p) set("ssh_key_path", p);
                        }}
                      >
                        찾기…
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {passwordRow}
            {isFtp && (
              <>
                <label>암호화</label>
                <select value={cfg.ftp_tls} onChange={(e) => changeFtpTls(e.target.value as ConnectionConfig["ftp_tls"])}>
                  <option value="none">없음</option>
                  <option value="explicit">명시적 TLS</option>
                  <option value="implicit">암시적 TLS</option>
                </select>
                {cfg.ftp_tls === "none" && !isLocal && (
                  <div className="full hint" style={{ color: "var(--danger)" }}>
                    암호화하지 않으면 비밀번호와 파일이 평문으로 전송됩니다.
                  </div>
                )}
                {cfg.ftp_tls !== "none" && (
                  <>
                    <label>인증서</label>
                    <label className="row">
                      <input type="checkbox" checked={cfg.tls_insecure} onChange={(e) => set("tls_insecure", e.target.checked)} />
                      <span className="hint">자체서명 인증서 허용</span>
                    </label>
                    {cfg.tls_insecure && (
                      <div className="full hint" style={{ color: "var(--danger)" }}>
                        인증서를 검증하지 않으면 중간자가 통신을 가로챌 수 있습니다.
                      </div>
                    )}
                  </>
                )}
                <label>파일명 인코딩</label>
                <select value={cfg.fs_encoding} onChange={(e) => set("fs_encoding", e.target.value as ConnectionConfig["fs_encoding"])}>
                  <option value="utf8">UTF-8</option>
                  <option value="euc-kr">EUC-KR</option>
                </select>
              </>
            )}
          </>
        )}

        {!isLite && !isMongo && !isRedis && !remote && (
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
            {remote ? "업로드·삭제·수정을 앱에서 막습니다." : isRedis || isMongo ? "쓰기 명령을 앱에서 거부합니다." : "DB 세션을 읽기 전용으로 엽니다."} 실수 방지 기능이며 보안 기능은 아닙니다.
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
