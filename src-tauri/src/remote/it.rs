//! docker compose -f fixtures/remote/docker-compose.yml up -d 후
//! cargo test --lib -- --ignored remote_it
use super::*;
use crate::remote::{known_hosts, ops};

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
