//! Durable, bounded authentication challenges; mail I/O lives in `mail`.
use super::*;
use crate::credentials::{Binding, Keyring, MAX_RESERVATIONS};
use http::StatusCode;
use rand::{TryRngCore, rngs::OsRng};
use rusqlite::Transaction;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Otp {
    pub db: Database,
    pub ring: Keyring,
    pub policy: Policy,
    pub enabled: bool,
}
#[derive(Clone)]
pub struct Policy {
    pub lifetime: i64,
    pub cooldown: i64,
    pub email_requests: i64,
    pub peer_requests: i64,
    pub global_requests: i64,
}
impl Policy {
    pub fn load() -> std::result::Result<Self, &'static str> {
        fn setting(
            name: &str,
            default: i64,
            min: i64,
            max: i64,
        ) -> std::result::Result<i64, &'static str> {
            let value = match std::env::var(name) {
                Ok(v) => v.parse::<i64>().map_err(|_| "invalid_otp_policy")?,
                Err(std::env::VarError::NotPresent) => default,
                _ => return Err("invalid_otp_policy"),
            };
            if !(min..=max).contains(&value) {
                return Err("invalid_otp_policy");
            }
            Ok(value)
        }
        Ok(Self {
            lifetime: setting("AUTH_OTP_LIFETIME_SECONDS", 180, 60, 300)?,
            cooldown: setting("AUTH_OTP_COOLDOWN_SECONDS", 60, 30, 180)?,
            email_requests: setting("AUTH_OTP_EMAIL_REQUESTS", 3, 1, 10)?,
            peer_requests: setting("AUTH_OTP_PEER_REQUESTS", 30, 1, 300)?,
            global_requests: setting("AUTH_OTP_GLOBAL_REQUESTS", 300, 1, 500)?,
        })
    }
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            lifetime: 180,
            cooldown: 60,
            email_requests: 3,
            peer_requests: 30,
            global_requests: 300,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestCode {
    pub email: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyCode {
    pub challenge_id: String,
    pub code: String,
}
#[derive(Serialize)]
pub struct Challenge {
    pub challenge_id: String,
    pub expires_in: i64,
    pub resend_after: i64,
}

fn invalid() -> Error {
    Error::Response(
        StatusCode::UNAUTHORIZED,
        "invalid_code",
        "The verification code is invalid or no longer available.",
    )
}
fn limited() -> Error {
    Error::Response(
        StatusCode::TOO_MANY_REQUESTS,
        "authentication_rate_limited",
        "Too many attempts. Try again later.",
    )
}
fn subject(kind: &str, value: &str) -> Vec<u8> {
    Sha256::digest(format!("roisey-else/otp-budget/{kind}\0{value}")).to_vec()
}
fn budget(tx: &Transaction<'_>, kind: &str, value: &str, limit: i64, now: i64) -> Result<bool> {
    let key = subject(kind, value);
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM auth_otp_rate_events WHERE kind=?1 AND subject=?2 AND occurred_at>?3",
        params![kind, key, now - 900],
        |r| r.get(0),
    )?;
    Ok(count < limit)
}
fn record(tx: &Transaction<'_>, kind: &str, value: &str, now: i64) -> Result<()> {
    tx.execute(
        "INSERT INTO auth_otp_rate_events(kind,subject,occurred_at) VALUES (?1,?2,?3)",
        params![kind, subject(kind, value), now],
    )?;
    Ok(())
}
fn cleanup(tx: &Transaction<'_>, now: i64) -> Result<()> {
    tx.execute("DELETE FROM auth_otp_rate_events WHERE id IN (SELECT id FROM auth_otp_rate_events WHERE occurred_at<=?1 ORDER BY occurred_at LIMIT 300)",[now-900])?;
    tx.execute("DELETE FROM auth_otp_challenges WHERE id IN (SELECT id FROM auth_otp_challenges WHERE expires_at<=?1 ORDER BY expires_at LIMIT 100)",[now-900])?;
    Ok(())
}
pub(crate) fn invalidate(tx: &Transaction<'_>, user: &str) -> Result<()> {
    tx.execute("UPDATE auth_otp_challenges SET state='invalidated' WHERE user_id=?1 AND state IN ('queued','sending','delivered')",[user])?;
    tx.execute("UPDATE auth_email_outbox SET state='failed',envelope=NULL WHERE user_id=?1 AND state IN ('queued','sending')",[user])?;
    Ok(())
}
/// Uniform rejection sampling over OS randomness; leading zeros are retained.
fn generate() -> Result<Zeroizing<String>> {
    loop {
        let n = OsRng.try_next_u32().map_err(|_| Error::Internal)?;
        if n < u32::MAX - (u32::MAX % 1_000_000) {
            return Ok(Zeroizing::new(format!("{:06}", n % 1_000_000)));
        }
    }
}
pub(crate) fn binding<'a>(user: &'a str, challenge: &'a str) -> Binding<'a> {
    Binding {
        client: user,
        connection: challenge,
        provider: "auth_email",
        purpose: "authentication",
    }
}
impl Otp {
    /// Reservation commits separately and is never refunded by encryption rollback.
    async fn reserve(&self) -> Result<String> {
        let ring = self.ring.clone();
        self.db.write(move|tx| {
            ring.preflight(tx,false,true)?;
            let (label,fingerprint)=ring.active();
            let saved:Option<(String,i64)>=tx.query_row("SELECT id,reservations FROM integration_encryption_keys WHERE key_label=?1",[label],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            let first=saved.is_none();
            let id=if let Some((id,used))=saved {if used>=MAX_RESERVATIONS{return Err(Error::Busy);}id}else{
                let id=validation::new_id();tx.execute("INSERT INTO integration_encryption_keys VALUES (?1,?2,?3,0,?4)",params![id,label,fingerprint.as_slice(),validation::now()])?;id
            };
            tx.execute("UPDATE integration_encryption_keys SET reservations=reservations+1 WHERE id=?1",[&id])?;
            // First use is audited; irreversible quota remains durable. Anonymous requests
            // must not manufacture an unbounded retained business audit trail.
            if first {
            let resource=validation::new_id(); let request_id=audit::request_id();
            audit::append(tx,Event{actor:None,request_id:&request_id,kind:"integration_encryption",id:&resource,client:None,action:"created",before:None,after:Some(Snapshot{exists:Some(true),..Default::default()}),source:"job"})?;
            }
            Ok(id)
        }).await
    }
    pub async fn request(
        &self,
        input: RequestCode,
        peer: String,
        browser: &str,
    ) -> Result<Challenge> {
        let email = super::email(&input.email)?;
        let browser_digest = digest(browser).map_err(|_| Error::Invalid("invalid_request"))?;
        if !self.enabled {
            return Err(Error::Busy);
        }
        let policy = self.policy.clone();
        let target = email.clone();
        let admitted=self.db.write(move|tx| {
            let now=Utc::now().timestamp();cleanup(tx,now)?;
            if !budget(tx,"request_global","all",policy.global_requests,now)? || !budget(tx,"request_peer",&peer,policy.peer_requests,now)? || !budget(tx,"request_email",&target,policy.email_requests,now)? {return Ok(false);}
            let recent:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM auth_otp_rate_events WHERE kind='request_email' AND subject=?1 AND occurred_at>?2)",params![subject("request_email",&target),now-policy.cooldown],|r|r.get(0))?;
            if recent{return Ok(false);}
            for (kind,value) in [("request_global","all"),("request_peer",peer.as_str()),("request_email",target.as_str())] {record(tx,kind,value,now)?;}
            Ok(true)
        }).await?;
        if !admitted {
            return Err(limited());
        }
        let key_id = self.reserve().await?;
        let challenge = secret().0;
        let id = challenge.clone();
        let ring = self.ring.clone();
        let policy = self.policy.clone();
        let code = generate()?;
        self.db.write(move|tx| {
            let now=Utc::now().timestamp();
            let count:i64=tx.query_row("SELECT count(*) FROM auth_otp_challenges",[],|r|r.get(0))?;
            let queued:i64=tx.query_row("SELECT count(*) FROM auth_email_outbox WHERE state IN ('queued','sending')",[],|r|r.get(0))?;
            if count>=6000 || queued>=100 {return Err(Error::Busy);}
            let user:Option<String>=tx.query_row("SELECT id FROM users WHERE email=?1 AND status='active'",[&email],|r|r.get(0)).optional()?;
            let (label,_)=ring.active();
            let identity=user.clone().unwrap_or_else(validation::new_id);
            let hash=ring.otp_digest(label,&[&id,&identity,"authentication",&code])?;
            let locale:String=tx.query_row("SELECT coalesce((SELECT locale FROM user_locale_preferences WHERE user_id=?1),'en')",[&identity],|r|r.get(0))?;
            let payload=Zeroizing::new(serde_json::to_vec(&serde_json::json!({"email":email,"code":&*code,"locale":locale,"seconds":policy.lifetime})).map_err(|_|Error::Internal)?);
            // Match the bounded crypto/query work for ineligible addresses; only delivery differs.
            let envelope=ring.seal(&binding(&identity,&id),&payload)?;
            if let Some(user)=&user {invalidate(tx,user)?;}
            tx.execute("INSERT INTO auth_otp_challenges(id,user_id,key_label,otp_digest,browser_digest,created_at,expires_at,state) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",params![id,user,label,hash,browser_digest,now,now+policy.lifetime,if user.is_some(){"queued"}else{"invalidated"}])?;
            if let Some(user)=user {
                tx.execute("INSERT INTO auth_email_outbox VALUES (?1,?2,?3,?4,?5,'queued')",params![id,user,key_id,envelope.bytes(),now+60])?;
            }
            Ok(())
        }).await?;
        tracing::info!("auth_otp_request");
        Ok(Challenge {
            challenge_id: challenge,
            expires_in: self.policy.lifetime,
            resend_after: self.policy.cooldown,
        })
    }
    pub async fn verify(
        &self,
        input: VerifyCode,
        peer: String,
        browser: &str,
        request_id: String,
    ) -> Result<LoginResult> {
        if digest(&input.challenge_id).is_err()
            || input.code.len() != 6
            || !input.code.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(Error::Invalid("invalid_request"));
        }
        let browser = digest(browser).map_err(|_| invalid())?;
        let code = Zeroizing::new(input.code);
        let ring = self.ring.clone();
        let outcome=self.db.write(move|tx| {
            let now=Utc::now().timestamp();cleanup(tx,now)?;
            if !budget(tx,"verify_global","all",1000,now)? || !budget(tx,"verify_peer",&peer,100,now)? {return Ok(Err(limited()));}
            record(tx,"verify_global","all",now)?;record(tx,"verify_peer",&peer,now)?;
            type Row=(Option<String>,String,Vec<u8>,Vec<u8>,i64,i64,String);
            let row:Option<Row>=tx.query_row("SELECT user_id,key_label,otp_digest,browser_digest,expires_at,attempts,state FROM auth_otp_challenges WHERE id=?1 AND purpose='authentication'",[&input.challenge_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
            let Some((user,label,expected,binding,expires,attempts,state))=row else{return Ok(Err(invalid()));};
            if !bool::from(binding.ct_eq(&browser)) {return Ok(Err(invalid()));}
            if expires<=now || attempts>=5 || state!="delivered" {return Ok(Err(invalid()));}
            let Some(user)=user else{return Ok(Err(invalid()));};
            let hash=ring.otp_digest(&label,&[&input.challenge_id,&user,"authentication",&code])?;
            if !bool::from(expected.ct_eq(&hash)) {
                tx.execute("UPDATE auth_otp_challenges SET attempts=attempts+1,state=CASE WHEN attempts>=4 THEN 'exhausted' ELSE state END WHERE id=?1",[input.challenge_id])?;
                return Ok(Err(invalid()));
            }
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND status='active')",[&user],|r|r.get(0))?;
            if !active {invalidate(tx,&user)?;return Ok(Err(invalid()));}
            tx.execute("UPDATE auth_otp_challenges SET state='consumed',consumed_at=?1 WHERE id=?2 AND state='delivered'",params![now,input.challenge_id])?;
            invalidate(tx,&user)?;
            Ok(Ok(Auth::establish(tx,user,request_id)?))
        }).await?;
        tracing::info!(
            event = if outcome.is_ok() {
                "auth_otp_verify_success"
            } else {
                "auth_otp_verify_failed"
            },
            "auth_otp_verification"
        );
        outcome
    }
}

#[cfg(test)]
mod tests;
