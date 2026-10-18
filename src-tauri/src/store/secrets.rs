use crate::error::AppResult;

const SERVICE: &str = "db-connect";

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
}
