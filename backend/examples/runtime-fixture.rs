//! Host-only synthetic container inspection/fault helper. Never shipped in the image.
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    time::Duration,
};

fn status(pid: u32, key: &str) -> String {
    fs::read_to_string(format!("/proc/{pid}/status"))
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix(key).map(str::trim))
        .unwrap()
        .into()
}
fn reply(reader: &mut BufReader<TcpStream>) -> serde_json::Value {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let line = line.trim_end();
    match &line[..1] {
        "+" => line[1..].into(),
        ":" => line[1..].parse::<i64>().unwrap().into(),
        "$" => {
            let length: usize = line[1..].parse().unwrap();
            let mut bytes = vec![0; length + 2];
            std::io::Read::read_exact(reader, &mut bytes).unwrap();
            String::from_utf8(bytes[..length].to_vec()).unwrap().into()
        }
        "*" => (0..line[1..].parse::<usize>().unwrap())
            .map(|_| reply(reader))
            .collect::<Vec<_>>()
            .into(),
        _ => panic!("synthetic Redis command failed"),
    }
}
fn command(arguments: &[&str]) -> serde_json::Value {
    let mut socket = TcpStream::connect("127.0.0.1:6379").unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(socket, "*{}\r\n", arguments.len()).unwrap();
    for value in arguments {
        write!(socket, "${}\r\n{}\r\n", value.len(), value).unwrap();
    }
    reply(&mut BufReader::new(socket))
}
fn main() {
    let action = std::env::args().nth(1).unwrap_or_else(|| "inspect".into());
    assert_eq!(
        fs::read_to_string("/proc/1/comm").unwrap().trim(),
        "roisey-else"
    );
    // The task/children file depends on optional kernel configuration. Inspect
    // normal process status instead so the fixture works on minimal hosts.
    let children: Vec<u32> = fs::read_dir("/proc")
        .unwrap()
        .filter_map(|entry| {
            entry
                .ok()?
                .file_name()
                .to_string_lossy()
                .parse::<u32>()
                .ok()
        })
        .filter(|pid| {
            fs::read_to_string(format!("/proc/{pid}/status"))
                .ok()
                .is_some_and(|text| {
                    text.lines().any(|line| {
                        line.strip_prefix("PPid:")
                            .is_some_and(|parent| parent.trim() == "1")
                    })
                })
        })
        .collect();
    assert_eq!(children.len(), 1, "Rust PID 1 must own one Redis child");
    let pid = children[0];
    assert_eq!(
        fs::read_to_string(format!("/proc/{pid}/comm"))
            .unwrap()
            .trim(),
        "redis-server"
    );
    assert_eq!(status(pid, "PPid:"), "1");
    let uid = unsafe { libc::geteuid() }.to_string();
    assert!(status(pid, "Uid:").split_whitespace().all(|v| v == uid));
    assert!(status(1, "Uid:").split_whitespace().all(|v| v == uid));
    match action.as_str() {
        "kill" | "pause" | "resume" => {
            let signal = match action.as_str() {
                "kill" => libc::SIGKILL,
                "pause" => libc::SIGSTOP,
                _ => libc::SIGCONT,
            };
            assert_eq!(unsafe { libc::kill(pid as libc::pid_t, signal) }, 0);
            println!("{{\"action\":\"{action}\",\"child_pid\":{pid}}}");
        }
        "private" => {
            let address: std::net::IpAddr = std::env::args().nth(2).unwrap().parse().unwrap();
            assert!(!address.is_loopback());
            assert!(
                TcpStream::connect_timeout(
                    &std::net::SocketAddr::new(address, 6379),
                    Duration::from_millis(500)
                )
                .is_err()
            );
            println!("private_loopback_verified");
        }
        "readonly" => {
            assert_eq!(
                fs::File::create("/synthetic-readonly-probe")
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::EROFS)
            );
            assert!(fs::read_dir("/tmp").unwrap().next().is_none());
            println!("readonly_root_and_transient_cache_verified");
        }
        "inspect" => {
            assert_eq!(command(&["PING"]), "PONG");
            let mut config = serde_json::Map::new();
            for key in [
                "bind",
                "port",
                "save",
                "appendonly",
                "maxmemory",
                "maxmemory-policy",
                "daemonize",
                "dir",
                "pidfile",
                "logfile",
                "protected-mode",
            ] {
                let value = command(&["CONFIG", "GET", key]);
                config.insert(key.into(), value[1].clone());
            }
            let gid = unsafe { libc::getegid() }.to_string();
            assert!(status(pid, "Gid:").split_whitespace().all(|v| v == gid));
            let mut root_files = fs::read_dir("/")
                .unwrap()
                .map(|p| p.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            root_files.sort();
            println!(
                "{}",
                serde_json::json!({"pid1": "roisey-else", "redis_pid": pid, "redis_parent": 1, "uid": uid, "gid": gid, "redis_config": config, "root_files": root_files})
            );
        }
        _ => panic!("unknown synthetic action"),
    }
}
