use std::{
    collections::BTreeMap,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use serde::Serialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    sync::Semaphore,
    task::JoinSet,
    time::Instant,
};

use crate::error::{AppError, AppResult};

/// Ports swept on every host (FR-1).
pub const SWEEP_PORTS: [u16; 7] = [554, 8554, 80, 8000, 8080, 8899, 37777];
/// Ports that standardly speak RTSP: all `COMMON_PATHS` are tried there; other
/// open ports only get a single `/` probe and count only if they answer RTSP.
const RTSP_PORTS: [u16; 2] = [554, 8554];
/// Paths tried during RTSP fingerprinting.
pub const COMMON_PATHS: [&str; 6] = [
    "/",
    "/stream1",
    "/live",
    "/h264",
    "/Streaming/Channels/101",
    "/cam/realmonitor?channel=1&subtype=0",
];
const MAX_HOSTS: usize = 1024;
const CONCURRENCY: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub host: String,
    pub port: u16,
    pub vendor: Option<String>,
    pub paths: Vec<String>,
    pub requires_auth: bool,
    pub source: String,
}

/// Result of an RTSP `DESCRIBE` against one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtspInfo {
    pub status: u16,
    pub server: Option<String>,
    pub requires_auth: bool,
}

/// Network boundary: everything that touches the wire.
#[async_trait]
pub trait Probe: Send + Sync {
    async fn onvif_ws_discovery(&self) -> Vec<Candidate>;
    async fn tcp_open(&self, ip: Ipv4Addr, port: u16) -> bool;
    async fn rtsp_fingerprint(&self, ip: Ipv4Addr, port: u16, path: &str) -> Option<RtspInfo>;
}

// ---------------------------------------------------------------- CIDR

/// Parse `a.b.c.d/n` (n in 22..=32) into the usable host addresses.
pub fn cidr_hosts(cidr: &str) -> AppResult<Vec<Ipv4Addr>> {
    let bad = || AppError::Unprocessable("cidr must look like 192.168.1.0/24".into());
    let (ip, bits) = cidr.trim().split_once('/').ok_or_else(bad)?;
    let ip: Ipv4Addr = ip.parse().map_err(|_| bad())?;
    let bits: u32 = bits.parse().map_err(|_| bad())?;
    if bits > 32 {
        return Err(bad());
    }
    if (1u64 << (32 - bits)) as usize > MAX_HOSTS {
        return Err(AppError::Unprocessable(
            "cidr too large (max /22, 1024 addresses)".into(),
        ));
    }
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    let net = u32::from(ip) & mask;
    let size = 1u32 << (32 - bits);
    let (first, last) = if bits >= 31 {
        (net, net + size - 1)
    } else {
        (net + 1, net + size - 2)
    };
    Ok((first..=last).map(Ipv4Addr::from).collect())
}

/// The host's primary IPv4 /24 (route to the internet; nothing is sent).
pub async fn default_cidr() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    s.connect("8.8.8.8:80").await.ok()?;
    match s.local_addr().ok()? {
        SocketAddr::V4(a) => {
            let o = a.ip().octets();
            Some(format!("{}.{}.{}.0/24", o[0], o[1], o[2]))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- scan

fn merge(into: &mut Candidate, other: Candidate) {
    if into.vendor.is_none() {
        into.vendor = other.vendor;
    }
    for p in other.paths {
        if !into.paths.contains(&p) {
            into.paths.push(p);
        }
    }
    into.requires_auth |= other.requires_auth;
    for s in other.source.split('+') {
        if !into.source.split('+').any(|x| x == s) {
            into.source = format!("{}+{}", into.source, s);
        }
    }
}

/// Add `c` to `map`, deduplicating on (host, port).
fn add(map: &mut BTreeMap<(Ipv4Addr, u16), Candidate>, c: Candidate) {
    let Ok(ip) = c.host.parse::<Ipv4Addr>() else {
        return;
    };
    match map.get_mut(&(ip, c.port)) {
        Some(existing) => merge(existing, c),
        None => {
            map.insert((ip, c.port), c);
        }
    }
}

/// Orchestrate ONVIF + port sweep + RTSP fingerprint over `cidr`, bounded by
/// `timeout` overall (partial results are returned when the deadline hits).
pub async fn scan(
    probe: Arc<dyn Probe>,
    cidr: &str,
    timeout: Duration,
) -> AppResult<Vec<Candidate>> {
    let hosts = cidr_hosts(cidr)?;
    let deadline = Instant::now() + timeout;
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let mut found: BTreeMap<(Ipv4Addr, u16), Candidate> = BTreeMap::new();

    let mut set: JoinSet<Vec<Candidate>> = JoinSet::new();
    {
        let p = probe.clone();
        set.spawn(async move { p.onvif_ws_discovery().await });
    }
    for ip in hosts {
        for port in SWEEP_PORTS {
            let (p, sem) = (probe.clone(), sem.clone());
            set.spawn(async move {
                let Ok(_permit) = sem.acquire().await else {
                    return vec![];
                };
                if !p.tcp_open(ip, port).await {
                    return vec![];
                }
                let mut cand = Candidate {
                    host: ip.to_string(),
                    port,
                    vendor: None,
                    paths: vec![],
                    requires_auth: false,
                    source: "portscan".into(),
                };
                let paths: &[&str] = if RTSP_PORTS.contains(&port) {
                    &COMMON_PATHS
                } else {
                    &COMMON_PATHS[..1]
                };
                let mut answered = false;
                for path in paths {
                    if let Some(info) = p.rtsp_fingerprint(ip, port, path).await {
                        answered = true;
                        if info.status == 404 {
                            continue;
                        }
                        if cand.vendor.is_none() {
                            cand.vendor = info.server.clone();
                        }
                        cand.requires_auth |= info.requires_auth;
                        if info.status == 200 || info.status == 401 {
                            cand.paths.push(path.to_string());
                        }
                    }
                }
                if answered {
                    vec![cand]
                } else {
                    vec![]
                }
            });
        }
    }
    while let Ok(Some(res)) = tokio::time::timeout_at(deadline, set.join_next()).await {
        if let Ok(cands) = res {
            for c in cands {
                add(&mut found, c);
            }
        }
    }
    set.abort_all();
    Ok(found.into_values().collect())
}

// ---------------------------------------------------------------- RTSP parsing

/// Parse a raw RTSP response (status line + headers).
pub fn parse_rtsp_response(raw: &str) -> Option<RtspInfo> {
    let mut lines = raw.lines();
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    if !parts.next()?.starts_with("RTSP/") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    let mut server = None;
    let mut www_auth = false;
    for l in lines {
        if l.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "server" => server = Some(v.trim().to_string()),
                "www-authenticate" => www_auth = true,
                _ => {}
            }
        }
    }
    Some(RtspInfo {
        status,
        server,
        requires_auth: status == 401 || www_auth,
    })
}

/// Extract the IPv4 hosts out of an ONVIF `XAddrs` list and a vendor hint
/// from the `onvif://www.onvif.org/(name|hardware)/...` scopes.
pub fn parse_onvif_response(xml: &str) -> Option<Candidate> {
    let xaddrs = between(xml, "XAddrs>", "</")?;
    let host = xaddrs.split_whitespace().find_map(|u| {
        let rest = u
            .strip_prefix("http://")
            .or_else(|| u.strip_prefix("https://"))?;
        let hp = rest.split('/').next()?;
        let h = hp.split(':').next()?;
        h.parse::<Ipv4Addr>().ok().map(|_| h.to_string())
    })?;
    let scopes = between(xml, "Scopes>", "</").unwrap_or("");
    let vendor = ["name", "hardware"].iter().find_map(|k| {
        let pat = format!("onvif://www.onvif.org/{k}/");
        scopes
            .split_whitespace()
            .find_map(|s| s.strip_prefix(pat.as_str()))
            .map(|v| v.replace("%20", " "))
    });
    Some(Candidate {
        host,
        port: 554,
        vendor,
        paths: vec![],
        requires_auth: false,
        source: "onvif".into(),
    })
}

fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = s.find(start)? + start.len();
    let j = s[i..].find(end)? + i;
    Some(s[i..j].trim())
}

// ---------------------------------------------------------------- real probe

pub struct RealProbe {
    pub connect_timeout: Duration,
    pub onvif_wait: Duration,
}

impl Default for RealProbe {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(600),
            onvif_wait: Duration::from_secs(3),
        }
    }
}

const ONVIF_PROBE: &str = r#"<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:84ede3de-7dec-11d0-c360-f01234567890</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>"#;

#[async_trait]
impl Probe for RealProbe {
    async fn onvif_ws_discovery(&self) -> Vec<Candidate> {
        let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await else {
            return vec![];
        };
        if sock
            .send_to(ONVIF_PROBE.as_bytes(), "239.255.255.250:3702")
            .await
            .is_err()
        {
            return vec![];
        }
        let end = Instant::now() + self.onvif_wait;
        let mut buf = vec![0u8; 16 * 1024];
        let mut out = vec![];
        while let Ok(Ok((n, _))) = tokio::time::timeout_at(end, sock.recv_from(&mut buf)).await {
            if let Some(c) = parse_onvif_response(&String::from_utf8_lossy(&buf[..n])) {
                out.push(c);
            }
        }
        out
    }

    async fn tcp_open(&self, ip: Ipv4Addr, port: u16) -> bool {
        matches!(
            tokio::time::timeout(self.connect_timeout, TcpStream::connect((ip, port))).await,
            Ok(Ok(_))
        )
    }

    async fn rtsp_fingerprint(&self, ip: Ipv4Addr, port: u16, path: &str) -> Option<RtspInfo> {
        let t = self.connect_timeout * 3;
        let mut s = tokio::time::timeout(t, TcpStream::connect((ip, port)))
            .await
            .ok()?
            .ok()?;
        let req = format!(
            "DESCRIBE rtsp://{ip}:{port}{path} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: cameraman\r\n\r\n"
        );
        tokio::time::timeout(t, s.write_all(req.as_bytes()))
            .await
            .ok()?
            .ok()?;
        let mut buf = vec![0u8; 4096];
        let n = tokio::time::timeout(t, s.read(&mut buf)).await.ok()?.ok()?;
        parse_rtsp_response(&String::from_utf8_lossy(&buf[..n]))
    }
}

// ---------------------------------------------------------------- fake probe

/// Test double: canned ONVIF hits, open ports and per-(host,port,path) responses.
#[derive(Default, Clone)]
pub struct FakeProbe {
    pub onvif: Vec<Candidate>,
    pub open: Vec<(Ipv4Addr, u16)>,
    pub rtsp: Vec<((Ipv4Addr, u16, String), RtspInfo)>,
}

#[async_trait]
impl Probe for FakeProbe {
    async fn onvif_ws_discovery(&self) -> Vec<Candidate> {
        self.onvif.clone()
    }
    async fn tcp_open(&self, ip: Ipv4Addr, port: u16) -> bool {
        self.open.contains(&(ip, port))
    }
    async fn rtsp_fingerprint(&self, ip: Ipv4Addr, port: u16, path: &str) -> Option<RtspInfo> {
        self.rtsp
            .iter()
            .find(|((i, p, pa), _)| *i == ip && *p == port && pa == path)
            .map(|(_, r)| r.clone())
    }
}

impl FakeProbe {
    /// The two cameras from CONTEXT.md (Tenda @ .38:554, YGTek @ .164:8554).
    pub fn lan_fixture() -> Self {
        let a = Ipv4Addr::new(192, 168, 1, 38);
        let b = Ipv4Addr::new(192, 168, 1, 164);
        let info = |status, server: &str, auth| RtspInfo {
            status,
            server: Some(server.into()),
            requires_auth: auth,
        };
        Self {
            onvif: vec![],
            open: vec![(a, 554), (b, 8554), (a, 80)],
            rtsp: vec![
                ((a, 554, "/".into()), info(404, "Tenda RTSP", false)),
                ((a, 554, "/stream1".into()), info(200, "Tenda RTSP", false)),
                (
                    (b, 8554, "/".into()),
                    info(401, "YGTek RTSP Server 2.0", true),
                ),
                (
                    (b, 8554, "/live".into()),
                    info(401, "YGTek RTSP Server 2.0", true),
                ),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(host: &str, port: u16, vendor: Option<&str>, src: &str) -> Candidate {
        Candidate {
            host: host.into(),
            port,
            vendor: vendor.map(Into::into),
            paths: vec![],
            requires_auth: false,
            source: src.into(),
        }
    }

    #[tokio::test]
    async fn acceptance_two_cameras_found() {
        let probe: Arc<dyn Probe> = Arc::new(FakeProbe::lan_fixture());
        let r = scan(probe, "192.168.1.0/24", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(r.len(), 2, "{r:?}");
        let a = r.iter().find(|c| c.host == "192.168.1.38").unwrap();
        assert_eq!(a.port, 554);
        assert_eq!(a.vendor.as_deref(), Some("Tenda RTSP"));
        assert_eq!(a.paths, vec!["/stream1"]);
        assert!(!a.requires_auth);
        let b = r.iter().find(|c| c.host == "192.168.1.164").unwrap();
        assert_eq!(b.port, 8554);
        assert_eq!(b.vendor.as_deref(), Some("YGTek RTSP Server 2.0"));
        assert_eq!(b.paths, vec!["/", "/live"]);
        assert!(b.requires_auth);
    }

    #[tokio::test]
    async fn dedup_merges_onvif_and_portscan() {
        let mut p = FakeProbe::lan_fixture();
        p.onvif = vec![
            cand("192.168.1.38", 554, Some("Tenda-ONVIF"), "onvif"),
            cand("192.168.1.38", 554, None, "onvif"),
            cand("192.168.1.99", 554, Some("Other"), "onvif"),
        ];
        let r = scan(Arc::new(p), "192.168.1.0/24", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(r.len(), 3, "{r:?}");
        let a = r.iter().find(|c| c.host == "192.168.1.38").unwrap();
        assert!(a.source.contains("onvif") && a.source.contains("portscan"));
        assert_eq!(a.paths, vec!["/stream1"]);
        assert!(r.iter().any(|c| c.host == "192.168.1.99"));
    }

    #[tokio::test]
    async fn empty_network_and_bad_cidr() {
        let r = scan(
            Arc::new(FakeProbe::default()),
            "10.0.0.0/30",
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(r.is_empty());
        for bad in ["nope", "10.0.0.0/8", "10.0.0.0/40", "10.0.0.300/24"] {
            assert!(
                scan(Arc::new(FakeProbe::default()), bad, Duration::from_secs(1))
                    .await
                    .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn cidr_expansion() {
        let h = cidr_hosts("192.168.1.0/24").unwrap();
        assert_eq!(h.len(), 254);
        assert_eq!(h[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(h[253], Ipv4Addr::new(192, 168, 1, 254));
        assert_eq!(cidr_hosts("10.0.0.5/32").unwrap().len(), 1);
        assert_eq!(cidr_hosts("10.0.0.0/31").unwrap().len(), 2);
    }

    #[test]
    fn rtsp_response_parsing() {
        let raw = "RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nServer: YGTek RTSP Server 2.0\r\nWWW-Authenticate: Digest realm=\"x\"\r\n\r\n";
        let i = parse_rtsp_response(raw).unwrap();
        assert_eq!(i.status, 401);
        assert_eq!(i.server.as_deref(), Some("YGTek RTSP Server 2.0"));
        assert!(i.requires_auth);
        let ok = parse_rtsp_response("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n").unwrap();
        assert!(!ok.requires_auth && ok.server.is_none());
        assert!(parse_rtsp_response("HTTP/1.1 200 OK\r\n\r\n").is_none());
    }

    #[test]
    fn onvif_response_parsing() {
        let xml = "<d:ProbeMatch><d:Scopes>onvif://www.onvif.org/name/Acme%20Cam onvif://www.onvif.org/hardware/X1</d:Scopes><d:XAddrs>http://192.168.1.50:80/onvif/device_service</d:XAddrs></d:ProbeMatch>";
        let c = parse_onvif_response(xml).unwrap();
        assert_eq!(c.host, "192.168.1.50");
        assert_eq!(c.vendor.as_deref(), Some("Acme Cam"));
        assert_eq!(c.source, "onvif");
        assert!(parse_onvif_response("<nothing/>").is_none());
    }
}
