//! Modo de teste sem janela: transmite e imprime as estatísticas do codificador.
//!
//! Uso:
//!   faz-o-l-desktop --test-stream <url wss> <token> [segundos=30] [codec=vp8]
//!                   [fps=60] [largura=1920] [altura=1080] [bitrate=10000000] [audio=1]
//!
//! Serve pra medir, sem login nem interface, o que realmente importa:
//! fps entregue, resolução, codificador usado e se a CPU/banda está limitando.

use std::time::{Duration, Instant};

use livekit::webrtc::stats::RtcStats;

use crate::stream::{open_session, teardown, StartArgs};

fn arg<T: std::str::FromStr>(args: &[String], i: usize, default: T) -> T {
    args.get(i).and_then(|v| v.parse().ok()).unwrap_or(default)
}

struct StderrLog;
impl log::Log for StderrLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info && m.target().starts_with("faz_o_l_desktop")
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{}] {}", r.level(), r.args());
        }
    }
    fn flush(&self) {}
}

pub fn run(args: &[String]) -> i32 {
    // Logs do app (áudio, captura) no terminal
    let _ = log::set_logger(&StderrLog).map(|()| log::set_max_level(log::LevelFilter::Info));
    if args.len() < 4 {
        eprintln!("uso: --test-stream <url> <token> [segundos] [codec] [fps] [largura] [altura] [bitrate] [audio]");
        return 2;
    }
    let seconds: u64 = arg(args, 4, 30);
    let start = StartArgs {
        url: args[2].clone(),
        token: args[3].clone(),
        monitor: 0,
        codec: arg(args, 5, "vp8".to_string()),
        fps: arg(args, 6, 60),
        width: arg(args, 7, 1920),
        height: arg(args, 8, 1080),
        bitrate: arg(args, 9, 10_000_000),
        audio: arg::<u8>(args, 10, 1) == 1,
        window: None,
        stretch: false,
        audio_mode: None,
        separate_voices: None,
    };

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    // A captura de áudio e o teardown usam o runtime do Tauri: aponta pro nosso
    tauri::async_runtime::set(runtime.handle().clone());

    runtime.block_on(async move {
        println!("conectando em {} ...", start.url);
        let (session, _events, label) = match open_session(&start).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("ERRO: {e}");
                return 1;
            }
        };
        println!("AO VIVO: {label} (áudio: {})", if start.audio { "sim" } else { "não" });
        println!("{:>4} | {:>9} | {:>6} | {:>9} | {:>8} | {:>9} | encoder", "t(s)", "resolução", "fps", "kbps", "enc ms/q", "limitação");

        let started = Instant::now();
        let (mut last_bytes, mut last_frames, mut last_encode, mut last_t) = (0u64, 0u32, 0f64, Instant::now());
        while started.elapsed() < Duration::from_secs(seconds) {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let stats = match session.video_track.get_stats().await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("sem estatísticas: {e}");
                    continue;
                }
            };
            for stat in stats {
                if let RtcStats::OutboundRtp(s) = stat {
                    if s.stream.kind != "video" {
                        continue;
                    }
                    let dt = last_t.elapsed().as_secs_f64().max(0.001);
                    let o = &s.outbound;
                    let kbps = (s.sent.bytes_sent.saturating_sub(last_bytes)) as f64 * 8.0 / dt / 1000.0;
                    let frames = o.frames_encoded.saturating_sub(last_frames);
                    let enc_ms = if frames > 0 { (o.total_encode_time - last_encode) * 1000.0 / frames as f64 } else { 0.0 };
                    println!(
                        "{:>4} | {:>9} | {:>6.1} | {:>9.0} | {:>8.2} | {:>9} | {}",
                        started.elapsed().as_secs(),
                        format!("{}x{}", o.frame_width, o.frame_height),
                        o.frames_per_second,
                        kbps,
                        enc_ms,
                        format!("{:?}", o.quality_limitation_reason),
                        o.encoder_implementation,
                    );
                    last_bytes = s.sent.bytes_sent;
                    last_frames = o.frames_encoded;
                    last_encode = o.total_encode_time;
                    last_t = Instant::now();
                }
            }
        }

        println!("encerrando...");
        teardown(session).await;
        println!("FIM");
        0
    })
}
