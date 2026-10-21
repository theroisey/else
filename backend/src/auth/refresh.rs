use super::*;

type RefreshRow = (String, String, Vec<u8>, String, Option<String>);

pub(super) fn cleanup(tx: &rusqlite::Transaction<'_>, now: &str) -> Result<()> {
    // Only expired authentication credentials; no business/audit history is deleted.
    tx.execute("DELETE FROM session_refresh_tokens WHERE token_hash IN (SELECT token_hash FROM session_refresh_tokens WHERE expires_at<=?1 ORDER BY expires_at LIMIT 200)",[now])?;
    Ok(())
}

impl Auth {
    pub async fn renew(
        &self,
        token: &str,
        csrf: &str,
        header: &str,
        request_id: String,
    ) -> Result<LoginResult> {
        self.refresh_action(token, csrf, header, request_id, false)
            .await?
            .ok_or(Error::Unauthorized)
    }

    pub async fn logout_refresh(
        &self,
        token: &str,
        csrf: &str,
        header: &str,
        request_id: String,
    ) -> Result<()> {
        self.refresh_action(token, csrf, header, request_id, true)
            .await?;
        Ok(())
    }

    async fn refresh_action(
        &self,
        token: &str,
        csrf: &str,
        header: &str,
        request_id: String,
        logout: bool,
    ) -> Result<Option<LoginResult>> {
        let token_hash = digest(token)?;
        let csrf_hash = digest(csrf).map_err(|_| csrf_error())?;
        if csrf.len() != header.len() || !bool::from(csrf.as_bytes().ct_eq(header.as_bytes())) {
            return Err(csrf_error());
        }
        let (access, access_hash) = secret();
        let (next_csrf, next_csrf_hash) = secret();
        let (refresh, refresh_hash) = secret();
        // A replay revocation must commit before reporting Unauthorized.
        let (result,replayed) = self.db.write(move |tx| {
            let now=validation::now();
            let row: Option<RefreshRow> = tx.query_row(
                "SELECT s.id,s.user_id,r.csrf_hash,r.expires_at,r.consumed_at FROM session_refresh_tokens r JOIN sessions s ON s.id=r.session_id JOIN users u ON u.id=s.user_id WHERE r.token_hash=?1 AND r.expires_at>?2 AND s.revoked_at IS NULL AND u.status='active'",
                params![token_hash,now],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
            let (session_id,user_id,expected_csrf,deadline,consumed) = row.ok_or(Error::Unauthorized)?;
            if !bool::from(expected_csrf.ct_eq(&csrf_hash)) { return Err(csrf_error()); }
            let actor=Actor::session(user_id,session_id,expected_csrf,request_id);
            if consumed.is_some() || logout {
                tx.execute("UPDATE sessions SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",params![now,actor.session_id])?;
                audit::mutation(tx,&actor,"session",&actor.session_id,None,"archived",(Some(Snapshot{exists:Some(true),..Snapshot::default()}),Snapshot{exists:Some(false),..Snapshot::default()}))?;
                return Ok((None,!logout));
            }
            let deadline_instant=chrono::DateTime::parse_from_rfc3339(&deadline).map_err(|_|Error::Internal)?.with_timezone(&Utc);
            let expires=(Utc::now()+Duration::hours(12)).min(deadline_instant).to_rfc3339_opts(SecondsFormat::Micros,true);
            tx.execute("UPDATE session_refresh_tokens SET consumed_at=?1 WHERE token_hash=?2 AND consumed_at IS NULL",params![now,token_hash])?;
            tx.execute("INSERT INTO session_refresh_tokens VALUES (?1,?2,?3,?4,?5,NULL)",params![refresh_hash,actor.session_id,next_csrf_hash,now,deadline])?;
            tx.execute("UPDATE sessions SET token_hash=?1,csrf_hash=?2,expires_at=?3 WHERE id=?4 AND revoked_at IS NULL",params![access_hash,next_csrf_hash,expires,actor.session_id])?;
            audit::mutation(tx,&actor,"session",&actor.session_id,None,"updated",(Some(Snapshot{exists:Some(true),..Snapshot::default()}),Snapshot{exists:Some(true),..Snapshot::default()}))?;
            cleanup(tx,&now)?;
            let next_actor=Actor::session(actor.user_id,actor.session_id,next_csrf_hash,actor.request_id);
            Ok((Some(LoginResult{session:Session{user:user(tx,&next_actor.user_id)?,actor:next_actor,expires_at:expires},token:access,csrf:next_csrf,refresh,refresh_expires_at:deadline}),false))
        }).await?;
        if replayed {
            Err(Error::Unauthorized)
        } else {
            Ok(result)
        }
    }
}

fn csrf_error() -> Error {
    Error::Response(
        http::StatusCode::FORBIDDEN,
        "csrf_failed",
        "Request verification failed.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture() -> (tempfile::TempDir, Auth, LoginResult) {
        let directory = tempfile::tempdir().unwrap();
        let auth = Auth::new(Database::open(&directory.path().join("else.sqlite3"), true).unwrap())
            .unwrap();
        auth.bootstrap(
            "refresh.fixture@example.com".into(),
            "Synthetic refresh owner".into(),
        )
        .await
        .unwrap();
        let login = auth
            .test_login("refresh.fixture@example.com".into(), audit::request_id())
            .await
            .unwrap();
        (directory, auth, login)
    }

    #[tokio::test]
    async fn expired_access_rotates_all_credentials_rechecks_grants_and_keeps_absolute_deadline() {
        let (directory, auth, login) = fixture().await;
        let conn = crate::db::connection(&directory.path().join("else.sqlite3")).unwrap();
        conn.execute(
            "UPDATE sessions SET created_at='2019-01-01T00:00:00.000000Z',expires_at='2020-01-01T00:00:00.000000Z' WHERE id=?1",
            [&login.session.actor.session_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE user_roles SET revoked_at=?1 WHERE user_id=?2",
            params![validation::now(), login.session.actor.user_id],
        )
        .unwrap();
        assert!(
            auth.current(&login.token, audit::request_id())
                .await
                .is_err()
        );
        let renewed = auth
            .renew(
                &login.refresh,
                &login.csrf,
                &login.csrf,
                audit::request_id(),
            )
            .await
            .unwrap();
        assert_ne!(renewed.token, login.token);
        assert_ne!(renewed.csrf, login.csrf);
        assert_ne!(renewed.refresh, login.refresh);
        assert_eq!(renewed.refresh_expires_at, login.refresh_expires_at);
        assert_eq!(
            renewed.session.actor.session_id,
            login.session.actor.session_id
        );
        assert!(renewed.session.user.permissions.is_empty());
        assert!(
            auth.current(&renewed.token, audit::request_id())
                .await
                .is_ok()
        );
        let old = login.session.actor.clone();
        assert!(
            auth.db
                .read(move |tx| security::fresh(tx, &old))
                .await
                .is_err()
        );
        assert!(
            auth.current(&login.token, audit::request_id())
                .await
                .is_err()
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM session_refresh_tokens", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        let raw = URL_SAFE_NO_PAD.decode(&renewed.refresh).unwrap();
        let stored: Vec<u8> = conn
            .query_row(
                "SELECT token_hash FROM session_refresh_tokens WHERE consumed_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(stored, raw);
        assert_eq!(stored, digest(&renewed.refresh).unwrap());
        auth.logout(renewed.session.actor).await.unwrap();
        assert!(
            auth.renew(
                &renewed.refresh,
                &renewed.csrf,
                &renewed.csrf,
                audit::request_id()
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn invalid_csrf_cannot_revoke_and_concurrent_replay_revokes_the_whole_family() {
        let (_directory, auth, login) = fixture().await;
        let foreign = secret().0;
        assert!(matches!(
            auth.renew(&login.refresh, &foreign, &foreign, audit::request_id())
                .await,
            Err(Error::Response(http::StatusCode::FORBIDDEN, ..))
        ));
        assert!(
            auth.current(&login.token, audit::request_id())
                .await
                .is_ok()
        );
        assert!(
            auth.renew(&login.refresh, &login.csrf, &foreign, audit::request_id())
                .await
                .is_err()
        );
        let (a, b) = tokio::join!(
            auth.renew(
                &login.refresh,
                &login.csrf,
                &login.csrf,
                audit::request_id()
            ),
            auth.renew(
                &login.refresh,
                &login.csrf,
                &login.csrf,
                audit::request_id()
            )
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let rotated = a.or(b).unwrap();
        assert!(
            auth.current(&rotated.token, audit::request_id())
                .await
                .is_err()
        );
        assert!(
            auth.renew(
                &rotated.refresh,
                &rotated.csrf,
                &rotated.csrf,
                audit::request_id()
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn failed_audit_rolls_back_rotation_and_expired_access_can_logout_without_renewal() {
        let (directory, auth, login) = fixture().await;
        let conn = crate::db::connection(&directory.path().join("else.sqlite3")).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_refresh_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        assert!(
            auth.renew(
                &login.refresh,
                &login.csrf,
                &login.csrf,
                audit::request_id()
            )
            .await
            .is_err()
        );
        assert!(
            auth.current(&login.token, audit::request_id())
                .await
                .is_ok()
        );
        conn.execute_batch("DROP TRIGGER reject_refresh_audit")
            .unwrap();
        conn.execute(
            "UPDATE sessions SET created_at='2019-01-01T00:00:00.000000Z',expires_at='2020-01-01T00:00:00.000000Z' WHERE id=?1",
            [&login.session.actor.session_id],
        )
        .unwrap();
        auth.logout_refresh(
            &login.refresh,
            &login.csrf,
            &login.csrf,
            audit::request_id(),
        )
        .await
        .unwrap();
        assert!(
            auth.renew(
                &login.refresh,
                &login.csrf,
                &login.csrf,
                audit::request_id()
            )
            .await
            .is_err()
        );
        let second = auth
            .test_login("refresh.fixture@example.com".into(), audit::request_id())
            .await
            .unwrap();
        conn.execute(
            "UPDATE users SET status='disabled' WHERE id=?1",
            [&second.session.actor.user_id],
        )
        .unwrap();
        assert!(
            auth.renew(
                &second.refresh,
                &second.csrf,
                &second.csrf,
                audit::request_id()
            )
            .await
            .is_err()
        );
    }
}
