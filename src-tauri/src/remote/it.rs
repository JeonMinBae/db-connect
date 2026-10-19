//! docker compose -f fixtures/remote/docker-compose.yml up -d 후
//! cargo test --lib -- --ignored remote_it
use super::*;
use crate::remote::transfer::{self, Answer, Choice, Job, TransferDone};
use crate::remote::text::{self, Enc, OpenText, SaveText};
use crate::remote::{known_hosts, ops};
use crate::store::config::{FsEncoding, FtpTls};

fn sftp_cfg() -> ConnectionConfig {
    ConnectionConfig { driver: Driver::Sftp, host: "localhost".into(), port: 2222, user: "test".into(), ..Default::default() }
}

#[tokio::test]
#[ignore]
async fn sftp_list_root() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = sftp_cfg();
    let first = Session::open(&cfg, Some("test"), dir.path()).await;
    let Err(AppError::HostKey { fingerprint, changed: false, .. }) = first else { panic!("TOFU 질문이 와야 한다") };
    known_hosts::trust(dir.path(), "localhost", 2222, &fingerprint).unwrap();
    let mut s = Session::open(&cfg, Some("test"), dir.path()).await.unwrap();
    let names: Vec<_> = s.list("/").await.unwrap().into_iter().map(|e| e.name).collect();
    assert!(names.contains(&"upload".to_string()));

    // 저장된 지문과 다르면 changed=true
    known_hosts::trust(dir.path(), "localhost", 2222, "SHA256:other").unwrap();
    let Err(AppError::HostKey { changed: true, .. }) = Session::open(&cfg, Some("test"), dir.path()).await else { panic!("changed 여야 한다") };
}

#[tokio::test]
#[ignore]
async fn sftp_stat_and_wrong_password() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = sftp_cfg();
    let Err(AppError::HostKey { fingerprint, .. }) = Session::open(&cfg, Some("test"), dir.path()).await else { panic!() };
    known_hosts::trust(dir.path(), "localhost", 2222, &fingerprint).unwrap();
    let mut s = Session::open(&cfg, Some("test"), dir.path()).await.unwrap();
    let (e, _) = s.stat("/upload").await.unwrap().unwrap();
    assert!(e.dir);
    assert!(s.stat("/nope").await.unwrap().is_none());
    assert!(matches!(Session::open(&cfg, Some("bad"), dir.path()).await, Err(AppError::User(_))));
}

async fn trusted_sftp() -> (Session, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = sftp_cfg();
    let Err(AppError::HostKey { fingerprint, .. }) = Session::open(&cfg, Some("test"), dir.path()).await else { panic!() };
    known_hosts::trust(dir.path(), "localhost", 2222, &fingerprint).unwrap();
    (Session::open(&cfg, Some("test"), dir.path()).await.unwrap(), dir)
}

#[tokio::test]
#[ignore]
async fn sftp_mkdir_rename_delete() {
    let (mut s, _d) = trusted_sftp().await;
    let base = format!("/upload/it-{}", uuid::Uuid::new_v4());
    s.mkdir(&base).await.unwrap();
    s.mkdir(&format!("{base}/sub")).await.unwrap();
    let renamed = format!("{base}-r");
    s.rename(&base, &renamed).await.unwrap();
    assert!(s.stat(&base).await.unwrap().is_none());
    // 파일 쓰기 API 는 아직 없어 빈 하위 폴더만 검증한다 (파일 포함 삭제는 업로드 단위에서)
    assert_eq!(ops::delete_tree(&mut s, &renamed).await.unwrap(), 0);
    assert!(s.stat(&renamed).await.unwrap().is_none());
}

fn test_env(answer: Option<crate::remote::transfer::Answer>) -> crate::remote::transfer::Env {
    use crate::remote::transfer::Env;
    Env {
        job_id: "it".into(),
        emit: std::sync::Arc::new(|_| {}),
        ask: std::sync::Arc::new(move |_| {
            Box::pin(async move { answer.ok_or_else(|| AppError::user("질문이 오면 안 된다")) })
        }),
    }
}

/// 프로토콜 공통: 재귀 업로드·다운로드, 충돌 응답. base 는 존재하지 않는 새 경로.
async fn transfer_scenario(cfg: &ConnectionConfig, data_dir: &std::path::Path, secret: &str, base: String) {
    let open = || async { Session::open(cfg, Some(secret), data_dir).await.unwrap() };

    // 로컬 트리: dir/a.txt, dir/sub/b.bin, dir/sub/deep/c.txt
    let src = tempfile::tempdir().unwrap();
    let root = src.path().join("dir");
    std::fs::create_dir_all(root.join("sub/deep")).unwrap();
    std::fs::write(root.join("a.txt"), b"alpha").unwrap();
    std::fs::write(root.join("sub/b.bin"), (0..=255u8).cycle().take(100_000).collect::<Vec<_>>()).unwrap();
    std::fs::write(root.join("sub/deep/c.txt"), "한글 content").unwrap();

    let mut s = open().await;
    s.mkdir(&base).await.unwrap();

    let up = Job::Upload { pick_id: String::new(), dest_dir: base.clone() };
    let done = transfer::run(open().await, up, vec![root.clone()], test_env(None)).await.unwrap();
    assert_eq!(done, TransferDone { files: 3, bytes: 5 + 100_000 + "한글 content".len() as u64, skipped: 0 });

    // 다운로드: 폴더 대상
    let dst = tempfile::tempdir().unwrap();
    let down = Job::Download { paths: vec![format!("{base}/dir")], pick_id: String::new() };
    let done = transfer::run(open().await, down, vec![dst.path().to_path_buf()], test_env(None)).await.unwrap();
    assert_eq!(done.files, 3);
    for rel in ["a.txt", "sub/b.bin", "sub/deep/c.txt"] {
        assert_eq!(std::fs::read(root.join(rel)).unwrap(), std::fs::read(dst.path().join("dir").join(rel)).unwrap(), "{rel}");
    }
    assert!(!dst.path().join("dir/a.txt.part").exists());

    // 단일 파일 다운로드는 pick 경로가 곧 대상 파일
    let one = dst.path().join("renamed.txt");
    let down = Job::Download { paths: vec![format!("{base}/dir/a.txt")], pick_id: String::new() };
    transfer::run(open().await, down, vec![one.clone()], test_env(None)).await.unwrap();
    assert_eq!(std::fs::read(&one).unwrap(), b"alpha");

    // 같은 이름 업로드: Rename 응답 → "a (1).txt", Skip 은 skipped 로 집계
    let up = Job::Upload { pick_id: String::new(), dest_dir: format!("{base}/dir") };
    let rename = Answer { choice: Choice::Rename, all: false };
    let done = transfer::run(open().await, up.clone(), vec![root.join("a.txt")], test_env(Some(rename))).await.unwrap();
    assert_eq!(done.files, 1);
    let names: Vec<_> = s.list(&format!("{base}/dir")).await.unwrap().into_iter().map(|e| e.name).collect();
    assert!(names.contains(&"a (1).txt".to_string()), "{names:?}");
    let skip = Answer { choice: Choice::Skip, all: true };
    let done = transfer::run(open().await, up, vec![root.join("a.txt")], test_env(Some(skip))).await.unwrap();
    assert_eq!((done.files, done.skipped), (0, 1));

    // 4개: a.txt, a (1).txt, b.bin, c.txt
    assert_eq!(ops::delete_tree(&mut s, &base).await.unwrap(), 4);
    assert!(s.stat(&base).await.unwrap().is_none());
}

/// 프로토콜 공통: 텍스트 열기·저장·충돌. p 는 존재하지 않는 새 파일 경로.
async fn text_scenario(s: &mut Session, p: String) {
    let p = p.as_str();
    let s = &mut *s;
    let raw = b"\xC7\xD1\xB1\xDB\r\nabc\r\n";
    s.write_all(p, raw).await.unwrap();

    let OpenText::Text { text, meta, stamp } = text::open_text(s, p).await.unwrap() else { panic!("Text 여야 한다") };
    assert_eq!((meta.encoding, meta.crlf, meta.bom), (Enc::EucKr, true, false));
    assert_eq!(text, "한글\nabc\n");

    // 변경 없이 저장해도 바이트가 같다
    let SaveText::Saved { stamp: saved } = text::save_text(s, p, meta, &text, &stamp, false).await.unwrap() else { panic!("Saved 여야 한다") };
    assert_eq!(s.read_all(p, 1024).await.unwrap(), raw);

    // 다른 곳에서 바뀜 (SFTP mtime 이 초 단위라 크기를 바꾼다)
    s.write_all(p, b"changed elsewhere!!").await.unwrap();
    assert_eq!(text::save_text(s, p, meta, "mine\n", &saved, false).await.unwrap(), SaveText::Conflict);
    assert_eq!(s.read_all(p, 1024).await.unwrap(), b"changed elsewhere!!");
    assert!(matches!(text::save_text(s, p, meta, "mine\n", &saved, true).await.unwrap(), SaveText::Saved { .. }));
    assert_eq!(s.read_all(p, 1024).await.unwrap(), b"mine\r\n".as_slice());

    // 제한 초과 / 사라진 파일
    assert!(matches!(s.read_all(p, 2).await, Err(AppError::User(_))));
    s.remove_file(p).await.unwrap();
    assert_eq!(text::save_text(s, p, meta, "x", &saved, false).await.unwrap(), SaveText::Conflict);
}

/// 프로토콜 공통 시나리오: mkdir → 업로드 → 목록 → 텍스트 왕복 → rename → 재귀 삭제
pub async fn scenario(s: &mut Session, base: &str) {
    s.mkdir(base).await.unwrap();
    s.write_all(&format!("{base}/한글.txt"), "a
b".as_bytes()).await.unwrap();
    let names: Vec<_> = s.list(base).await.unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["한글.txt"]);
    let bytes = s.read_all(&format!("{base}/한글.txt"), text::MAX_EDIT).await.unwrap();
    assert_eq!(bytes, b"a
b");
    s.rename(&format!("{base}/한글.txt"), &format!("{base}/b.txt")).await.unwrap();
    assert_eq!(ops::delete_tree(s, base).await.unwrap(), 1);
    assert!(s.stat(base).await.unwrap().is_none());
}

#[tokio::test]
#[ignore]
async fn sftp_scenario() {
    let (mut s, d) = trusted_sftp().await;
    scenario(&mut s, &format!("/upload/it-{}", uuid::Uuid::new_v4())).await;
    text_scenario(&mut s, format!("/upload/it-{}.txt", uuid::Uuid::new_v4())).await;
    transfer_scenario(&sftp_cfg(), d.path(), "test", format!("/upload/it-{}", uuid::Uuid::new_v4())).await;
}

fn ftp_cfg() -> ConnectionConfig {
    ConnectionConfig { driver: Driver::Ftp, host: "localhost".into(), port: 21, user: "test".into(), ..Default::default() }
}

/// pure-ftpd 기본 동시 접속 한도(5)를 넘지 않도록 FTP 테스트는 한 번에 하나만 돌린다
static FTP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn tmp() -> std::path::PathBuf {
    std::env::temp_dir()
}

async fn ftp_all(cfg: &ConnectionConfig) {
    let _g = FTP_LOCK.lock().await;
    let mut s = Session::open(cfg, Some("test"), &tmp()).await.unwrap();
    scenario(&mut s, &format!("/it-{}", uuid::Uuid::new_v4())).await;
    text_scenario(&mut s, format!("/it-{}.txt", uuid::Uuid::new_v4())).await;
    transfer_scenario(cfg, &tmp(), "test", format!("/it-{}", uuid::Uuid::new_v4())).await;
}

#[tokio::test]
#[ignore]
async fn ftp_plain() {
    ftp_all(&ftp_cfg()).await;
}

#[tokio::test]
#[ignore]
async fn ftp_wrong_password() {
    let _g = FTP_LOCK.lock().await;
    assert!(matches!(Session::open(&ftp_cfg(), Some("bad"), &tmp()).await, Err(AppError::User(_))));
}

#[tokio::test]
#[ignore]
async fn ftp_explicit_tls_insecure() {
    let mut cfg = ftp_cfg();
    cfg.ftp_tls = FtpTls::Explicit;
    assert!(Session::open(&cfg, Some("test"), &tmp()).await.is_err(), "자체서명은 기본 거부");
    cfg.tls_insecure = true;
    ftp_all(&cfg).await;
}

#[tokio::test]
#[ignore]
async fn ftp_euc_kr_names() {
    let _g = FTP_LOCK.lock().await;
    let mut cfg = ftp_cfg();
    cfg.fs_encoding = FsEncoding::EucKr;
    let mut s = Session::open(&cfg, Some("test"), &tmp()).await.unwrap();
    let base = format!("/it-{}", uuid::Uuid::new_v4());
    let dir = format!("{base}/폴더");
    s.mkdir(&base).await.unwrap();
    s.mkdir(&dir).await.unwrap();
    s.write_all(&format!("{dir}/한글.txt"), b"x").await.unwrap();
    let names: Vec<_> = s.list(&dir).await.unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["한글.txt"]);
    assert!(s.stat(&format!("{dir}/한글.txt")).await.unwrap().is_some());

    // 서버에는 EUC-KR 바이트로 저장됐으므로 UTF-8 로 읽으면 깨진다
    let mut u = Session::open(&ftp_cfg(), Some("test"), &tmp()).await.unwrap();
    let raw: Vec<_> = u.list(&base).await.unwrap().into_iter().map(|e| e.name).collect();
    assert_ne!(raw, ["폴더"]);
    assert_eq!(ops::delete_tree(&mut s, &base).await.unwrap(), 1);
}

fn s3_cfg(bucket: &str) -> ConnectionConfig {
    ConnectionConfig {
        driver: Driver::S3,
        user: "minioadmin".into(),
        s3_endpoint: "http://localhost:9000".into(),
        s3_region: "us-east-1".into(),
        s3_bucket: bucket.into(),
        s3_path_style: true,
        ..Default::default()
    }
}

#[tokio::test]
#[ignore]
async fn s3_scenarios() {
    let cfg = s3_cfg("it-bucket");
    let mut s = Session::open(&cfg, Some("minioadmin"), &tmp()).await.unwrap();
    scenario(&mut s, &format!("/it-{}", uuid::Uuid::new_v4())).await;
    text_scenario(&mut s, format!("/it-{}.txt", uuid::Uuid::new_v4())).await;
    transfer_scenario(&cfg, &tmp(), "minioadmin", format!("/it-{}", uuid::Uuid::new_v4())).await;
}

#[tokio::test]
#[ignore]
async fn s3_buckets_and_empty_folder() {
    let mut s = Session::open(&s3_cfg(""), Some("minioadmin"), &tmp()).await.unwrap();
    let root: Vec<_> = s.list("/").await.unwrap();
    assert!(root.iter().any(|e| e.dir && e.name == "it-bucket"), "{root:?}");
    assert!(matches!(s.mkdir("/new-bucket").await, Err(AppError::User(_))));
    assert!(matches!(s.rename("/it-bucket", "/other").await, Err(AppError::User(_))));

    // 빈 폴더(마커 객체)가 목록에 보이고, 마커 자신은 숨겨진다
    let base = format!("/it-bucket/it-{}", uuid::Uuid::new_v4());
    s.mkdir(&base).await.unwrap();
    s.mkdir(&format!("{base}/빈 폴더")).await.unwrap();
    let names: Vec<_> = s.list(&base).await.unwrap().into_iter().map(|e| (e.name, e.dir)).collect();
    assert_eq!(names, [("빈 폴더".to_string(), true)]);
    assert!(s.stat(&format!("{base}/빈 폴더")).await.unwrap().is_some_and(|(e, _)| e.dir));
    assert!(s.stat(&format!("{base}/nope")).await.unwrap().is_none());

    // 폴더 이름 변경은 하위 전체를 옮긴다
    s.write_all(&format!("{base}/빈 폴더/a b.txt"), b"hi").await.unwrap();
    let moved = format!("{base}/moved");
    s.rename(&format!("{base}/빈 폴더"), &moved).await.unwrap();
    assert!(s.stat(&format!("{base}/빈 폴더")).await.unwrap().is_none());
    assert_eq!(s.read_all(&format!("{moved}/a b.txt"), 100).await.unwrap(), b"hi");

    // 1000개 초과 목록도 끝까지 읽는다 (페이지네이션)
    for i in 0..1005 {
        s.write_all(&format!("{base}/many/f{i:04}"), b"").await.unwrap();
    }
    assert_eq!(s.list(&format!("{base}/many")).await.unwrap().len(), 1005);
    assert_eq!(ops::delete_tree(&mut s, &base).await.unwrap(), 1006);
}

#[tokio::test]
#[ignore]
async fn s3_presign_and_bad_key() {
    let mut s = Session::open(&s3_cfg("it-bucket"), Some("minioadmin"), &tmp()).await.unwrap();
    let p = format!("/it-{}.txt", uuid::Uuid::new_v4());
    s.write_all(&p, "사전서명 본문".as_bytes()).await.unwrap();
    let url = s.presign(&p, 60).await.unwrap();
    let out = tmp().join(format!("presign-{}.out", uuid::Uuid::new_v4()));
    let code = std::process::Command::new("curl").args(["-s", "-o"]).arg(&out).args(["-w", "%{http_code}", &url]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&code.stdout), "200");
    assert_eq!(std::fs::read(&out).unwrap(), "사전서명 본문".as_bytes());
    let _ = std::fs::remove_file(&out);
    assert!(s.presign("/", 60).await.is_err());
    s.remove_file(&p).await.unwrap();

    let mut bad = Session::open(&s3_cfg("it-bucket"), Some("wrong-secret"), &tmp()).await.unwrap();
    assert!(matches!(bad.list("/").await, Err(AppError::User(_))));
}
