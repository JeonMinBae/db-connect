use crate::error::AppResult;

const SERVICE: &str = "data-connector";
/// db-connect 시절 서비스명. migrate::legacy_data 가 옮길 때만 쓴다
const LEGACY_SERVICE: &str = "db-connect";

/// 옛 서비스명에 남은 비밀번호를 새 서비스명으로 옮긴다. 새 쪽에 이미 있으면 옛 항목만 지운다
pub fn migrate_legacy(id: &str) -> AppResult<()> {
    let old = keyring::Entry::new(LEGACY_SERVICE, id)?;
    let pw = match old.get_password() {
        Ok(p) => p,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if get_password(id)?.is_none() {
        set_password(id, &pw)?;
    }
    old.delete_credential()?;
    Ok(())
}

pub fn set_password(id: &str, pw: &str) -> AppResult<()> {
    keyring::Entry::new(SERVICE, id)?.set_password(pw)?;
    Ok(())
}

pub fn get_password(id: &str) -> AppResult<Option<String>> {
    match keyring::Entry::new(SERVICE, id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_password(id: &str) -> AppResult<()> {
    match keyring::Entry::new(SERVICE, id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실제 Windows 자격 증명 관리자를 사용한다.
    #[test]
    fn roundtrip() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        assert_eq!(get_password(&id).unwrap(), None);
        set_password(&id, "pw-1").unwrap();
        assert_eq!(get_password(&id).unwrap().as_deref(), Some("pw-1"));
        set_password(&id, "pw-2").unwrap();
        assert_eq!(get_password(&id).unwrap().as_deref(), Some("pw-2"));
        delete_password(&id).unwrap();
        delete_password(&id).unwrap();
        assert_eq!(get_password(&id).unwrap(), None);
    }

    #[test]
    fn migrate_legacy_moves_password() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let old = keyring::Entry::new(LEGACY_SERVICE, &id).unwrap();
        old.set_password("old-pw").unwrap();
        migrate_legacy(&id).unwrap();
        assert_eq!(get_password(&id).unwrap().as_deref(), Some("old-pw"));
        assert!(matches!(old.get_password(), Err(keyring::Error::NoEntry)));
        migrate_legacy(&id).unwrap();
        delete_password(&id).unwrap();
    }
}
