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

#[tokio::test]
#[ignore]
async fn sftp_transfer_roundtrip() {
    use crate::remote::transfer::{self, Answer, Choice, Job, TransferDone};
    let (_s, d) = trusted_sftp().await;
    let cfg = sftp_cfg();
    let open = || async { Session::open(&cfg, Some("test"), d.path()).await.unwrap() };

    // 로컬 트리: dir/a.txt, dir/sub/b.bin, dir/sub/deep/c.txt
    let src = tempfile::tempdir().unwrap();
    let root = src.path().join("dir");
    std::fs::create_dir_all(root.join("sub/deep")).unwrap();
    std::fs::write(root.join("a.txt"), b"alpha").unwrap();
    std::fs::write(root.join("sub/b.bin"), (0..=255u8).cycle().take(100_000).collect::<Vec<_>>()).unwrap();
    std::fs::write(root.join("sub/deep/c.txt"), "한글 content").unwrap();

    let base = format!("/upload/it-{}", uuid::Uuid::new_v4());
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
