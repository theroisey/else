//! Loopback SMTP sink for explicitly owned test processes. Never part of production.
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::Path,
    time::Duration,
};
pub fn run(action: &str, root: &Path, arg: &str) {
    assert!(
        root.is_absolute()
            && root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("else-otp-")
    );
    if action == "smtp-read" {
        let bytes = fs::read(root.join("messages.json")).unwrap_or_else(|_| b"{}".to_vec());
        let messages: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        println!(
            "{}",
            messages
                .get(arg)
                .map(serde_json::Value::to_string)
                .unwrap_or_else(|| "{}".into())
        );
        return;
    }
    fs::DirBuilder::new().mode(0o700).create(root).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", arg.parse::<u16>().unwrap())).unwrap();
    fs::write(root.join("ready"), b"synthetic-smtp-fixture").unwrap();
    for stream in listener.incoming().flatten() {
        let _ = receive(stream, root);
    }
}
fn receive(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut input = BufReader::new(stream.try_clone()?);
    let mut recipient = String::new();
    stream.write_all(b"220 synthetic SMTP fixture\r\n")?;
    loop {
        let mut line = String::new();
        if input.read_line(&mut line)? == 0 || line.len() > 4096 {
            break;
        }
        if line.starts_with("EHLO") || line.starts_with("HELO") {
            stream.write_all(b"250 fixture\r\n")?;
        } else if line.starts_with("MAIL FROM:") {
            stream.write_all(b"250 OK\r\n")?;
        } else if let Some(value) = line.strip_prefix("RCPT TO:") {
            recipient = value
                .trim()
                .trim_start_matches('<')
                .split('>')
                .next()
                .unwrap()
                .to_owned();
            stream.write_all(b"250 OK\r\n")?;
        } else if line.trim() == "DATA" {
            stream.write_all(b"354 data\r\n")?;
            let mut code = None;
            let mut length = 0;
            loop {
                let mut data = String::new();
                if input.read_line(&mut data)? == 0 {
                    return Ok(());
                }
                if data == ".\r\n" {
                    break;
                }
                length += data.len();
                if length > 65536 {
                    return Ok(());
                }
                let text = data.trim();
                if text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit()) {
                    code = Some(text.to_owned());
                }
            }
            if let Some(code) = code {
                let path = root.join("messages.json");
                let bytes = fs::read(&path).unwrap_or_else(|_| b"{}".to_vec());
                let mut map: std::collections::BTreeMap<String, serde_json::Value> =
                    serde_json::from_slice(&bytes).unwrap();
                assert!(map.len() < 300);
                let received = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                map.insert(
                    recipient.clone(),
                    serde_json::json!({"code":code,"received_at":received}),
                );
                let temporary = root.join("messages.pending");
                fs::write(&temporary, serde_json::to_vec(&map).unwrap())?;
                fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
                fs::rename(temporary, path)?;
            }
            stream.write_all(b"250 accepted\r\n")?;
        } else if line.trim() == "QUIT" {
            stream.write_all(b"221 bye\r\n")?;
            break;
        } else {
            stream.write_all(b"250 OK\r\n")?;
        }
    }
    Ok(())
}
