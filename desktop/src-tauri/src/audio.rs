//! Áudio do sistema (WASAPI loopback por processo), em duas trilhas:
//!
//! - **live**: o som do PC que quem assiste escuta. Sem o Faz o L (pra não voltar o som
//!   de outra live aberta no app) e sem o Discord (quem assiste já está na call e ouviria
//!   as vozes duas vezes). Com "só o som do jogo", só o processo da janela escolhida.
//! - **vozes**: só o Discord. Ninguém escuta essa trilha ao vivo; o gravador junta ela
//!   com a da live na hora de clipar, pra as vozes ficarem no clipe.
//!
//! O Windows só deixa *excluir* um processo por captura. Então é ao contrário: a cada
//! 2 s lista os programas que têm som (sessões de áudio), abre uma captura "incluir"
//! pra cada um que passa no filtro e mistura tudo em quadros de 10 ms, no ritmo do relógio.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use wasapi::{AudioCaptureClient, AudioClient, Direction, Handle, SampleType, StreamMode, WaveFormat};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
const SAMPLES_PER_CHANNEL: usize = (SAMPLE_RATE / 100) as usize; // 10 ms
const SAMPLES_PER_FRAME: usize = SAMPLES_PER_CHANNEL * CHANNELS as usize;
const BYTES_PER_FRAME: usize = SAMPLES_PER_FRAME * 4; // f32
/// Folga antes de usar uma captura (absorve pacotes que chegam fora do ritmo)
const PRIME_BYTES: usize = BYTES_PER_FRAME * 2;
/// Mais que isso na fila é atraso acumulado: joga fora o mais velho
const MAX_QUEUE_BYTES: usize = BYTES_PER_FRAME * 20;
const REFRESH_EVERY: Duration = Duration::from_secs(2);
const RETRY_AFTER: Duration = Duration::from_secs(10);

const DISCORD_EXES: [&str; 4] = ["discord.exe", "discordptb.exe", "discordcanary.exe", "discorddevelopment.exe"];

/// Que programas entram na trilha.
#[derive(Clone, Copy, Debug)]
pub enum Pick {
    /// Tudo menos o Faz o L e o Discord
    AllButDiscord,
    /// Tudo menos o Faz o L (com o Discord junto; o jeito antigo)
    All,
    /// Só o Discord (as vozes da call)
    Discord,
    /// Só o processo do jogo (e filhos)
    Game(u32),
}

pub fn spawn(source: NativeAudioSource, stop: Arc<AtomicBool>, pick: Pick) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("fazol-audio-{pick:?}"))
        .spawn(move || {
            let _ = wasapi::initialize_mta().ok();
            let result = match pick {
                Pick::All => run_single(&source, &stop, std::process::id(), false),
                Pick::Game(pid) => run_single(&source, &stop, pid, true),
                _ => run_mixer(&source, &stop, pick),
            };
            if let Err(err) = result {
                log::error!("captura de áudio ({pick:?}) falhou: {err}");
            }
        })
        .expect("não consegui criar a thread de áudio")
}

fn format() -> WaveFormat {
    WaveFormat::new(32, 32, SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None)
}

fn send(source: &NativeAudioSource, samples: Vec<i16>) {
    let frame = AudioFrame {
        data: samples.into(),
        sample_rate: SAMPLE_RATE,
        num_channels: CHANNELS,
        samples_per_channel: SAMPLES_PER_CHANNEL as u32,
    };
    let _ = tauri::async_runtime::block_on(source.capture_frame(&frame));
}

fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

/// Uma captura só (incluir o jogo, ou excluir o próprio app), repassando o que chega.
fn run_single(source: &NativeAudioSource, stop: &AtomicBool, pid: u32, include_tree: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = AudioClient::new_application_loopback_client(pid, include_tree)?;
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    client.initialize_client(&format(), Direction::Capture, mode, None)?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;

    let mut queue: VecDeque<u8> = VecDeque::with_capacity(BYTES_PER_FRAME * 20);
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(100).is_err() {
            continue; // sem som tocando: nada chega, só checa o stop de novo
        }
        capture.read_from_device_to_deque(&mut queue)?;
        while queue.len() >= BYTES_PER_FRAME {
            let bytes: Vec<u8> = queue.drain(..BYTES_PER_FRAME).collect();
            let samples = bytes.chunks_exact(4).map(|b| to_i16(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))).collect();
            send(source, samples);
        }
    }
    client.stop_stream().ok();
    Ok(())
}

// ---------------------------------------------------------------------------
// Mistura de várias capturas (uma por programa)
// ---------------------------------------------------------------------------

struct Capture {
    client: AudioClient,
    capture: AudioCaptureClient,
    _event: Handle,
    queue: VecDeque<u8>,
    primed: bool,
}

impl Capture {
    fn open(pid: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let mut client = AudioClient::new_application_loopback_client(pid, true)?;
        // 100 ms de buffer: a mistura lê a cada ~10-15 ms sem esperar evento
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 1_000_000 };
        client.initialize_client(&format(), Direction::Capture, mode, None)?;
        let event = client.set_get_eventhandle()?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        Ok(Self { client, capture, _event: event, queue: VecDeque::with_capacity(MAX_QUEUE_BYTES), primed: false })
    }

    /// Lê tudo o que chegou (cada leitura traz um pacote só).
    fn drain(&mut self) -> Result<(), wasapi::WasapiError> {
        for _ in 0..64 {
            let before = self.queue.len();
            self.capture.read_from_device_to_deque(&mut self.queue)?;
            if self.queue.len() == before {
                break;
            }
        }
        Ok(())
    }

    /// Soma até 10 ms desta captura em `mix`.
    fn mix_into(&mut self, mix: &mut [f32]) {
        if !self.primed {
            if self.queue.len() < PRIME_BYTES {
                return;
            }
            self.primed = true;
        }
        let n = self.queue.len().min(BYTES_PER_FRAME) / 8 * 8; // quadros estéreo inteiros
        let bytes: Vec<u8> = self.queue.drain(..n).collect();
        for (acc, b) in mix.iter_mut().zip(bytes.chunks_exact(4)) {
            *acc += f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        }
        if n < BYTES_PER_FRAME {
            self.primed = false; // acabou o som (ou atrasou): espera juntar de novo
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.client.stop_stream().ok();
    }
}

fn run_mixer(source: &NativeAudioSource, stop: &AtomicBool, pick: Pick) -> Result<(), Box<dyn std::error::Error>> {
    let own = std::process::id();
    let mut captures: HashMap<u32, Capture> = HashMap::new();
    let mut failed: HashMap<u32, Instant> = HashMap::new();
    let mut last_refresh: Option<Instant> = None;
    let start = Instant::now();
    let mut emitted: u64 = 0;

    while !stop.load(Ordering::Relaxed) {
        if last_refresh.map_or(true, |t| t.elapsed() >= REFRESH_EVERY) {
            last_refresh = Some(Instant::now());
            match wanted(pick, own) {
                Ok(want) => {
                    captures.retain(|pid, _| want.contains(pid));
                    failed.retain(|_, at| at.elapsed() < RETRY_AFTER);
                    for pid in want {
                        if captures.contains_key(&pid) || failed.contains_key(&pid) {
                            continue;
                        }
                        match Capture::open(pid) {
                            Ok(c) => {
                                log::info!("áudio ({pick:?}): capturando o processo {pid}");
                                captures.insert(pid, c);
                            }
                            Err(e) => {
                                log::warn!("áudio ({pick:?}): processo {pid} sem captura: {e}");
                                failed.insert(pid, Instant::now());
                            }
                        }
                    }
                }
                Err(e) => log::warn!("áudio ({pick:?}): não consegui listar os programas com som: {e}"),
            }
        }

        captures.retain(|pid, c| match c.drain() {
            Ok(_) => {
                if c.queue.len() > MAX_QUEUE_BYTES {
                    let extra = (c.queue.len() - MAX_QUEUE_BYTES) / 8 * 8;
                    c.queue.drain(..extra);
                }
                true
            }
            Err(e) => {
                log::info!("áudio ({pick:?}): processo {pid} parou: {e}");
                false
            }
        });

        // Um quadro de 10 ms por 10 ms de relógio (mesmo em silêncio: a trilha nunca para)
        let due = (start.elapsed().as_millis() / 10) as u64;
        if due > emitted + 20 {
            emitted = due - 1; // a thread travou: não tenta recuperar o atraso todo
        }
        while emitted < due {
            let mut mix = vec![0f32; SAMPLES_PER_FRAME];
            for c in captures.values_mut() {
                c.mix_into(&mut mix);
            }
            send(source, mix.into_iter().map(to_i16).collect());
            emitted += 1;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Programas com som e a árvore de processos
// ---------------------------------------------------------------------------

struct Proc {
    parent: u32,
    exe: String,
}

/// Processos que devem entrar na trilha agora.
fn wanted(pick: Pick, own: u32) -> windows::core::Result<HashSet<u32>> {
    let procs = processes();
    let sessions = session_pids()?;
    let candidates: HashSet<u32> = sessions
        .into_iter()
        .filter(|&pid| {
            if in_tree(&procs, pid, own) {
                return false;
            }
            let discord = is_discord(&procs, pid);
            match pick {
                Pick::AllButDiscord | Pick::All => !discord,
                Pick::Discord => discord,
                Pick::Game(game) => in_tree(&procs, pid, game),
            }
        })
        .collect();
    // A captura "incluir" já pega os filhos: tira quem tem um ancestral na lista
    Ok(candidates
        .iter()
        .copied()
        .filter(|&pid| !ancestors(&procs, pid).any(|a| candidates.contains(&a)))
        .collect())
}

fn ancestors(procs: &HashMap<u32, Proc>, pid: u32) -> impl Iterator<Item = u32> + '_ {
    let mut seen = HashSet::new();
    let mut current = pid;
    std::iter::from_fn(move || {
        let parent = procs.get(&current)?.parent;
        if parent == 0 || !seen.insert(parent) || !procs.contains_key(&parent) {
            return None;
        }
        current = parent;
        Some(parent)
    })
    .take(32)
}

fn in_tree(procs: &HashMap<u32, Proc>, pid: u32, root: u32) -> bool {
    pid == root || ancestors(procs, pid).any(|a| a == root)
}

fn is_discord(procs: &HashMap<u32, Proc>, pid: u32) -> bool {
    let named = |p: u32| procs.get(&p).is_some_and(|x| DISCORD_EXES.contains(&x.exe.as_str()));
    named(pid) || ancestors(procs, pid).any(named)
}

fn processes() -> HashMap<u32, Proc> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            map.insert(entry.th32ProcessID, Proc { parent: entry.th32ParentProcessID, exe });
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    map
}

/// Processos com sessão de áudio em qualquer saída de som ativa.
fn session_pids() -> windows::core::Result<HashSet<u32>> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    let mut pids = HashSet::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let Ok(device) = devices.Item(i) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = manager.GetSessionEnumerator() else { continue };
            for j in 0..list.GetCount().unwrap_or(0) {
                let Ok(control) = list.GetSession(j) else { continue };
                if control.GetState().map_or(true, |s| s == AudioSessionStateExpired) {
                    continue;
                }
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                if let Ok(pid) = control2.GetProcessId() {
                    if pid != 0 {
                        pids.insert(pid);
                    }
                }
            }
        }
    }
    Ok(pids)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mostra quem entra em cada trilha e o pico de som de 2 s de cada programa.
    #[test]
    #[ignore] // depende dos programas abertos no PC
    fn lista_programas_com_som() {
        let _ = wasapi::initialize_mta().ok();
        let procs = processes();
        let name = |p: &u32| procs.get(p).map(|x| x.exe.clone()).unwrap_or_default();
        for pick in [Pick::AllButDiscord, Pick::Discord] {
            let mut caps: Vec<(u32, Capture)> = wanted(pick, std::process::id())
                .unwrap()
                .into_iter()
                .filter_map(|p| Capture::open(p).ok().map(|c| (p, c)))
                .collect();
            std::thread::sleep(Duration::from_secs(2));
            println!("{pick:?}:");
            for (p, c) in caps.iter_mut() {
                let _ = c.drain();
                let bytes: Vec<u8> = c.queue.iter().copied().collect();
                let peak = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]).abs()).fold(0f32, f32::max);
                println!("  {p} ({}): {} bytes, pico {peak:.3}", name(p), c.queue.len());
            }
        }
    }
}
