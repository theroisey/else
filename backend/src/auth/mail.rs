//! One bounded asynchronous SMTP worker in the existing application process.
use super::{
    otp::{self, Otp},
    *,
};
use crate::{credentials::Envelope, private_files};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, MultiPart},
    transport::smtp::authentication::Credentials,
};
use pingora_core::{server::ShutdownWatch, services::background::BackgroundService};
use std::{collections::BTreeMap, env, path::PathBuf, time::Duration as StdDuration};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct MailConfig {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<Zeroizing<String>>,
    from: String,
    name: String,
    security: String,
    timeout: u64,
}
fn variable(
    settings: &BTreeMap<String, String>,
    name: &str,
    max: usize,
) -> std::result::Result<Option<String>, &'static str> {
    match settings.get(name).cloned() {
        Some(v) if !v.is_empty() && v.len() <= max && !v.chars().any(char::is_control) => {
            Ok(Some(v))
        }
        Some(v) if v.is_empty() => Ok(None),
        None => Ok(None),
        _ => Err("invalid_smtp_configuration"),
    }
}
impl MailConfig {
    pub fn load(local: bool) -> std::result::Result<Option<Self>, &'static str> {
        let names = [
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USERNAME",
            "SMTP_PASSWORD",
            "SMTP_PASSWORD_FILE",
            "SMTP_FROM_ADDRESS",
            "SMTP_FROM_NAME",
            "SMTP_SECURITY",
            "SMTP_TIMEOUT_SECONDS",
        ];
        let mut settings = BTreeMap::new();
        for name in names {
            match env::var(name) {
                Ok(value) => {
                    settings.insert(name.to_owned(), value);
                }
                Err(env::VarError::NotPresent) => {}
                Err(_) => return Err("invalid_smtp_configuration"),
            }
        }
        let result = Self::parse(local, &settings);
        if let Some(secret) = settings.get_mut("SMTP_PASSWORD") {
            use zeroize::Zeroize;
            secret.zeroize();
        }
        result
    }
    fn parse(
        local: bool,
        settings: &BTreeMap<String, String>,
    ) -> std::result::Result<Option<Self>, &'static str> {
        if settings.values().all(String::is_empty) {
            return Ok(None);
        }
        let host = variable(settings, "SMTP_HOST", 253)?.ok_or("invalid_smtp_configuration")?;
        if host
            .chars()
            .any(|c| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '-' | ':'))
        {
            return Err("invalid_smtp_configuration");
        }
        let port = variable(settings, "SMTP_PORT", 5)?
            .unwrap_or_else(|| "587".into())
            .parse::<u16>()
            .map_err(|_| "invalid_smtp_configuration")?;
        if port == 0 {
            return Err("invalid_smtp_configuration");
        }
        let security =
            variable(settings, "SMTP_SECURITY", 16)?.unwrap_or_else(|| "starttls".into());
        if !matches!(security.as_str(), "tls" | "starttls")
            && !(security == "none" && local && matches!(host.as_str(), "127.0.0.1" | "::1"))
        {
            return Err("invalid_smtp_configuration");
        }
        let username = variable(settings, "SMTP_USERNAME", 254)?;
        let direct = variable(settings, "SMTP_PASSWORD", 4096)?.map(Zeroizing::new);
        let file = variable(settings, "SMTP_PASSWORD_FILE", 4096)?;
        if direct.is_some() && file.is_some() {
            return Err("invalid_smtp_configuration");
        }
        let password = if let Some(path) = file {
            let raw = private_files::read(&PathBuf::from(path), 4096)
                .map_err(|_| "smtp_secret_unavailable")?;
            let text = std::str::from_utf8(&raw)
                .map_err(|_| "invalid_smtp_configuration")?
                .trim_end_matches(['\r', '\n']);
            if text.is_empty() || text.chars().any(char::is_control) {
                return Err("invalid_smtp_configuration");
            }
            Some(Zeroizing::new(text.to_owned()))
        } else {
            direct
        };
        if username.is_some() != password.is_some()
            || (!local && username.is_none())
            || (security == "none" && username.is_some())
        {
            return Err("invalid_smtp_configuration");
        }
        let from = super::email(
            &variable(settings, "SMTP_FROM_ADDRESS", 254)?.ok_or("invalid_smtp_configuration")?,
        )
        .map_err(|_| "invalid_smtp_configuration")?;
        let name =
            variable(settings, "SMTP_FROM_NAME", 100)?.unwrap_or_else(|| "Roisey Else".into());
        let timeout = variable(settings, "SMTP_TIMEOUT_SECONDS", 2)?
            .unwrap_or_else(|| "10".into())
            .parse::<u64>()
            .map_err(|_| "invalid_smtp_configuration")?;
        if !(1..=15).contains(&timeout) {
            return Err("invalid_smtp_configuration");
        }
        Ok(Some(Self {
            host,
            port,
            username,
            password,
            from,
            name,
            security,
            timeout,
        }))
    }
    fn transport(&self) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
        let builder = match self.security.as_str() {
            "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(&self.host)
                .map_err(|_| Error::Internal)?,
            "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.host)
                .map_err(|_| Error::Internal)?,
            "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.host),
            _ => return Err(Error::Internal),
        }
        .port(self.port)
        .timeout(Some(StdDuration::from_secs(self.timeout)));
        let builder = if let (Some(user), Some(password)) = (&self.username, &self.password) {
            builder.credentials(Credentials::new(user.clone(), password.to_string()))
        } else {
            builder
        };
        Ok(builder.build())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Payload {
    pub email: String,
    pub code: String,
    pub locale: String,
    pub seconds: i64,
}
impl Drop for Payload {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.code.zeroize();
    }
}

fn template(
    locale: &str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
) {
    match locale {
        "tr" => (
            "Roisey Else giriş kodunuz",
            "Girişinizi doğrulayın",
            "Roisey Else çalışma alanınıza girmek için bu kodu kullanın.",
            "Bu kod tek kullanımlıktır. Kodunuzu kimseyle paylaşmayın.",
            "Giriş isteğini siz yapmadıysanız bu e-postayı yok sayın. Roisey Else kodunuzu paylaşmanızı asla istemez.",
        ),
        "ro" => (
            "Codul de conectare Roisey Else",
            "Confirmați conectarea",
            "Folosiți acest cod pentru a accesa spațiul Roisey Else.",
            "Codul poate fi folosit o singură dată. Nu îl divulgați nimănui.",
            "Dacă nu ați solicitat conectarea, ignorați acest mesaj. Roisey Else nu vă va cere niciodată să divulgați codul.",
        ),
        "de" => (
            "Ihr Roisey Else Anmeldecode",
            "Anmeldung bestätigen",
            "Verwenden Sie diesen Code für Ihren Roisey Else Arbeitsbereich.",
            "Dieser Code ist nur einmal gültig. Geben Sie ihn niemals weiter.",
            "Falls Sie keine Anmeldung angefordert haben, ignorieren Sie diese E-Mail. Roisey Else wird Sie niemals bitten, Ihren Code weiterzugeben.",
        ),
        "fr" => (
            "Votre code de connexion Roisey Else",
            "Confirmez votre connexion",
            "Utilisez ce code pour accéder à votre espace Roisey Else.",
            "Ce code est à usage unique. Ne le communiquez à personne.",
            "Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail. Roisey Else ne vous demandera jamais de partager votre code.",
        ),
        _ => (
            "Your Roisey Else sign-in code",
            "Verify your sign-in",
            "Use this code to access your Roisey Else workspace.",
            "This code can only be used once. Never share it with anyone.",
            "If you did not request this code, ignore this email. Roisey Else will never ask you to share your verification code.",
        ),
    }
}
fn expiry(locale: &str, seconds: i64) -> String {
    match locale {
        "tr" => format!("Kod {seconds} saniye içinde geçersiz olur."),
        "ro" => format!("Codul expiră în {seconds} de secunde."),
        "de" => format!("Der Code läuft in {seconds} Sekunden ab."),
        "fr" => format!("Ce code expire dans {seconds} secondes."),
        _ => format!("This code expires in {seconds} seconds."),
    }
}
fn message(config: &MailConfig, payload: &Payload) -> Result<Message> {
    // All interpolated content is validated digits/numbers or compiled localized copy.
    if payload.code.len() != 6
        || !payload.code.bytes().all(|b| b.is_ascii_digit())
        || !(1..=300).contains(&payload.seconds)
    {
        return Err(Error::Internal);
    }
    let (subject, title, instruction, warning, ignore) = template(&payload.locale);
    let expiration = expiry(&payload.locale, payload.seconds);
    let text = format!(
        "Roisey Else\n\n{title}\n\n{instruction}\n\n{}\n\n{expiration}\n{warning}\n\n{ignore}",
        &*payload.code
    );
    let html = format!(
        "<!doctype html><html><body style=\"margin:0;background:#f2f0ea;color:#171714;font-family:Arial,sans-serif\"><table role=\"presentation\" style=\"width:100%;padding:24px\"><tr><td align=\"center\"><table role=\"presentation\" style=\"width:100%;max-width:480px;background:#f8f7f3;padding:32px;border:1px solid #d9d6ce\"><tr><td><p style=\"letter-spacing:3px;font-size:12px\">ROISEY ELSE</p><h1 style=\"font-family:Georgia,serif;font-weight:400;font-size:28px\">{title}</h1><p style=\"line-height:1.6\">{instruction}</p><p style=\"font-size:36px;letter-spacing:8px;font-variant-numeric:tabular-nums\">{}</p><p>{expiration}</p><p style=\"line-height:1.6\">{warning}</p><hr style=\"border:0;border-top:1px solid #d9d6ce\"><p style=\"font-size:13px;line-height:1.6\">{ignore}</p></td></tr></table></td></tr></table></body></html>",
        &*payload.code
    );
    Message::builder()
        .from(Mailbox::new(
            Some(config.name.clone()),
            config.from.parse().map_err(|_| Error::Internal)?,
        ))
        .to(payload.email.parse().map_err(|_| Error::Internal)?)
        .subject(subject)
        .multipart(MultiPart::alternative_plain_html(text, html))
        .map_err(|_| Error::Internal)
}

pub struct Worker {
    otp: Otp,
    config: MailConfig,
    transport: AsyncSmtpTransport<Tokio1Executor>,
}
impl Worker {
    pub fn new(otp: Otp, config: MailConfig) -> Result<Self> {
        let transport = config.transport()?;
        Ok(Self {
            otp,
            config,
            transport,
        })
    }
    async fn recover(&self) -> Result<()> {
        self.otp.db.write(|tx| {
            tx.execute("UPDATE auth_otp_challenges SET state='invalidated' WHERE state='sending'",[])?;
            tx.execute("UPDATE auth_email_outbox SET state='failed',envelope=NULL WHERE state='sending'",[])?;Ok(())
        }).await
    }
    pub async fn run_once(&self) -> Result<bool> {
        let ring = self.otp.ring.clone();
        let item=self.otp.db.write(move|tx| {
            let now=Utc::now().timestamp();
            tx.execute("UPDATE auth_otp_challenges SET state='invalidated' WHERE state IN ('queued','sending') AND id IN (SELECT challenge_id FROM auth_email_outbox WHERE deadline<=?1)",[now])?;
            tx.execute("UPDATE auth_email_outbox SET state='failed',envelope=NULL WHERE state IN ('queued','sending') AND deadline<=?1",[now])?;
            let row:Option<(String,String,Vec<u8>)>=tx.query_row("SELECT o.challenge_id,o.user_id,o.envelope FROM auth_email_outbox o JOIN auth_otp_challenges c ON c.id=o.challenge_id JOIN users u ON u.id=o.user_id WHERE o.state='queued' AND c.state='queued' AND o.deadline>?1 AND c.expires_at>?1 AND u.status='active' ORDER BY o.deadline,o.challenge_id LIMIT 1",[now],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let Some((id,user,envelope))=row else{return Ok(None);};
            let decoded=Envelope::parse(envelope).and_then(|envelope|ring.open(&otp::binding(&user,&id),&envelope)).and_then(|raw|serde_json::from_slice::<Payload>(&raw).map_err(|_|Error::Internal));
            let payload=match decoded {Ok(payload)=>payload,Err(_)=>{
                tx.execute("UPDATE auth_email_outbox SET state='failed',envelope=NULL WHERE challenge_id=?1",[&id])?;
                tx.execute("UPDATE auth_otp_challenges SET state='invalidated' WHERE id=?1",[&id])?;
                return Ok(None);
            }};
            tx.execute("UPDATE auth_email_outbox SET state='sending' WHERE challenge_id=?1",[&id])?;
            tx.execute("UPDATE auth_otp_challenges SET state='sending' WHERE id=?1",[&id])?;
            Ok(Some((id,user,payload)))
        }).await?;
        let Some((id, user, mut payload)) = item else {
            return Ok(false);
        };
        let check = id.clone();
        let email = payload.email.clone();
        let remaining=self.otp.db.read(move|tx|Ok(tx.query_row("SELECT c.expires_at-?4 FROM auth_otp_challenges c JOIN users u ON u.id=c.user_id JOIN auth_email_outbox o ON o.challenge_id=c.id WHERE c.id=?1 AND c.user_id=?2 AND c.state='sending' AND o.state='sending' AND u.status='active' AND u.email=?3 AND o.deadline>?4 AND c.expires_at>?4",params![check,user,email,Utc::now().timestamp()],|r|r.get::<_,i64>(0)).optional()?)).await?;
        let sent = if let Some(seconds) = remaining {
            payload.seconds = seconds;
            match message(&self.config, &payload) {
                Ok(message) => tokio::time::timeout(
                    StdDuration::from_secs(self.config.timeout),
                    self.transport.send(message),
                )
                .await
                .is_ok_and(|r| r.is_ok()),
                Err(_) => false,
            }
        } else {
            false
        };
        self.otp.db.write(move|tx| {
            let now=Utc::now().timestamp();
            tx.execute("UPDATE auth_otp_challenges SET state=CASE WHEN ?1 AND expires_at>?2 AND EXISTS(SELECT 1 FROM auth_email_outbox o WHERE o.challenge_id=auth_otp_challenges.id AND o.deadline>?2) THEN 'delivered' ELSE 'invalidated' END WHERE id=?3 AND state='sending'",params![sent,now,id])?;
            tx.execute("UPDATE auth_email_outbox SET state=?1,envelope=NULL WHERE challenge_id=?2 AND state='sending'",params![if sent{"sent"}else{"failed"},id])?;Ok(())
        }).await?;
        if sent {
            tracing::info!("auth_otp_delivery_sent");
        } else {
            tracing::warn!(
                error_code = "email_delivery_failed",
                "auth_otp_delivery_failed"
            );
        }
        Ok(true)
    }
}
#[async_trait::async_trait]
impl BackgroundService for Worker {
    async fn start(&self, mut shutdown: ShutdownWatch) {
        while self.recover().await.is_err() {
            tracing::error!(
                error_code = "email_recovery_failed",
                "auth_email_worker_failed"
            );
            tokio::select! {_=shutdown.changed()=>return,_=tokio::time::sleep(StdDuration::from_secs(1))=>{}}
        }
        loop {
            let delay = match self.run_once().await {
                Ok(true) => 100,
                Ok(false) => 500,
                Err(_) => {
                    tracing::warn!(
                        error_code = "email_queue_failed",
                        "auth_email_worker_failed"
                    );
                    1000
                }
            };
            tokio::select! {_=shutdown.changed()=>break,_=tokio::time::sleep(StdDuration::from_millis(delay))=>{}}
        }
    }
}

#[cfg(test)]
mod tests;
