//! Log do app num arquivo: `%LOCALAPPDATA%\Faz o L\fazol.log`.
//!
//! Serve pra descobrir o que aconteceu numa transmissão (que programas entraram no
//! som, o que falhou) sem precisar de terminal. Passou de 2 MB, recomeça do zero.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

struct FileLog(Mutex<File>);

impl log::Log for FileLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        // Nosso código: tudo a partir de info. Bibliotecas (LiveKit, WebRTC): só avisos e erros.
        if m.target().starts_with("faz_o_l_desktop") {
            m.level() <= log::Level::Info
        } else {
            m.level() <= log::Level::Warn
        }
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        // Hora UTC (hh:mm:ss) é o bastante pra casar com os logs do servidor
        let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
        if let Ok(mut f) = self.0.lock() {
            let _ = writeln!(f, "{h:02}:{m:02}:{s:02} {:<5} {}", r.level(), r.args());
        }
    }

    fn flush(&self) {
        if let Ok(mut f) = self.0.lock() {
            let _ = f.flush();
        }
    }
}

pub fn path() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("Faz o L").join("fazol.log"))
}

/// Liga o log no arquivo (se não der pra abrir, o app segue sem log).
pub fn init() {
    let Some(path) = path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let too_big = std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
    let file = if too_big {
        File::create(&path)
    } else {
        OpenOptions::new().create(true).append(true).open(&path)
    };
    let Ok(file) = file else { return };
    let logger = Box::leak(Box::new(FileLog(Mutex::new(file))));
    if log::set_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
        log::info!("Faz o L {} iniciou", env!("CARGO_PKG_VERSION"));
    }
}
