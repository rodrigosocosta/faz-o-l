//! Captura de um monitor ou da janela de um jogo com Windows Graphics Capture (GPU)
//! e envio dos quadros ao LiveKit.
//!
//! "Esticar 4:3": pega a parte 4:3 do centro da imagem (jogo em 4:3 com ou sem
//! faixas pretas) e estica pra 16:9, como o CS esticado aparece pra quem joga.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use crate::hwenc::Nv12Frame;
use std::time::{Duration, Instant};

use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Control = CaptureControl<ScreenHandler, BoxError>;

/// O que transmitir.
#[derive(Clone, Copy, Debug)]
pub enum Target {
    /// Índice do monitor (0 = principal)
    Monitor(usize),
    /// HWND da janela (jogo ou programa)
    Window(isize),
}

impl Target {
    fn window(hwnd: isize) -> Window {
        Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void)
    }

    fn monitor(index: usize) -> Result<Monitor, String> {
        (if index == 0 { Monitor::primary() } else { Monitor::from_index(index) }).map_err(|e| format!("Monitor não encontrado: {e}"))
    }

    /// Tamanho atual em pixels.
    pub fn size(&self) -> Option<(u32, u32)> {
        match *self {
            Target::Monitor(i) => {
                let m = Self::monitor(i).ok()?;
                Some((m.width().ok()?, m.height().ok()?))
            }
            Target::Window(hwnd) => {
                let w = Self::window(hwnd);
                Some((w.width().ok()?.max(2) as u32, w.height().ok()?.max(2) as u32))
            }
        }
    }

    /// PID do processo da janela (pra capturar só o som do jogo).
    pub fn process_id(&self) -> Option<u32> {
        match *self {
            Target::Window(hwnd) => Self::window(hwnd).process_id().ok(),
            Target::Monitor(_) => None,
        }
    }
}

/// Para onde vão os quadros capturados.
pub enum Sink {
    /// Codificação por software no libwebrtc (VP8/VP9/H.264/AV1)
    Raw(NativeVideoSource),
    /// Codificação na placa de vídeo (NV12 -> Media Foundation), num tamanho fixo
    Hardware { sender: SyncSender<Nv12Frame>, width: u32, height: u32 },
}

/// Maior tamanho (par) que cabe em max_w x max_h mantendo a proporção.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h {
        return (w.max(2) & !1, h.max(2) & !1);
    }
    let scale = f64::min(max_w as f64 / w as f64, max_h as f64 / h as f64);
    (((w as f64 * scale) as u32).max(2) & !1, ((h as f64 * scale) as u32).max(2) & !1)
}

/// Largura da parte 4:3 do centro (ou a imagem toda, se já for mais estreita).
fn crop_43(w: u32, h: u32) -> u32 {
    w.min(h * 4 / 3) & !1
}

/// Tamanho esticado pra 16:9 (sem aumentar a altura da fonte nem passar do limite).
fn stretch_169(h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let mut out_h = h.min(max_h);
    let mut out_w = out_h * 16 / 9;
    if out_w > max_w {
        out_w = max_w;
        out_h = out_w * 9 / 16;
    }
    (out_w.max(2) & !1, out_h.max(2) & !1)
}

/// Tamanho final dos quadros para o alvo, respeitando o limite pedido.
pub fn output_size(target: Target, max_width: u32, max_height: u32, stretch: bool) -> (u32, u32) {
    let (w, h) = target.size().unwrap_or((max_width, max_height));
    if stretch {
        stretch_169(h, max_width, max_height)
    } else {
        fit(w, h, max_width, max_height)
    }
}

pub struct Flags {
    pub sink: Sink,
    pub stop: Arc<AtomicBool>,
    /// Resolução máxima enviada (o quadro é reduzido se a fonte for maior)
    pub max_width: u32,
    pub max_height: u32,
    /// Esticar a parte 4:3 do centro para 16:9
    pub stretch: bool,
}

/// `Flags` + o intervalo mínimo entre quadros, quando o Windows não limita sozinho.
pub struct HandlerFlags {
    flags: Flags,
    throttle: Option<Duration>,
}

pub struct ScreenHandler {
    flags: Flags,
    started: Instant,
    throttle: Option<Duration>,
    last_frame: Option<Instant>,
}

impl GraphicsCaptureApiHandler for ScreenHandler {
    type Flags = HandlerFlags;
    type Error = BoxError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let HandlerFlags { flags, throttle } = ctx.flags;
        Ok(Self { flags, started: Instant::now(), throttle, last_frame: None })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.flags.stop.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }
        // Windows sem limite de intervalo (Windows 10): manda um quadro por atualização
        // da tela (144 Hz...); descarta o que passar do fps pedido
        if let Some(min) = self.throttle {
            let now = Instant::now();
            if self.last_frame.is_some_and(|t| now.duration_since(t) < min) {
                return Ok(());
            }
            self.last_frame = Some(now);
        }

        let src_w = frame.width() & !1;
        let src_h = frame.height() & !1;
        if src_w < 2 || src_h < 2 {
            return Ok(()); // janela minimizada
        }
        // Região usada da imagem: inteira, ou só o 4:3 do centro (esticar)
        let (width, height) = (if self.flags.stretch { crop_43(src_w, src_h) } else { src_w }, src_h);
        let crop_x = ((src_w - width) / 2) & !1;

        // Tamanho de saída: fixo pra placa de vídeo e no modo esticado; senão segue a fonte
        let (out_w, out_h) = match &self.flags.sink {
            Sink::Hardware { width, height, .. } => (*width, *height),
            Sink::Raw(_) if self.flags.stretch => stretch_169(height, self.flags.max_width, self.flags.max_height),
            Sink::Raw(_) => fit(width, height, self.flags.max_width, self.flags.max_height),
        };

        let timestamp_us = self.started.elapsed().as_micros() as i64;
        let mut buffer = frame.buffer()?;
        let src_pitch = buffer.row_pitch() as usize;
        let raw = buffer.as_raw_buffer();
        if raw.len() < src_pitch * height as usize {
            return Ok(()); // quadro incompleto (janela mudando de tamanho)
        }
        // Recorte do centro: copia só a faixa 4:3 numa imagem contínua (o libyuv
        // exige pitch * altura bytes; um slice deslocado faria o app abortar)
        let cropped;
        let (bgra, pitch): (&[u8], u32) = if crop_x > 0 {
            let row = (width * 4) as usize;
            let start = (crop_x * 4) as usize;
            let mut out = vec![0u8; row * height as usize];
            for (y, dst) in out.chunks_exact_mut(row).enumerate() {
                let s = y * src_pitch + start;
                dst.copy_from_slice(&raw[s..s + row]);
            }
            cropped = out;
            (&cropped, width * 4)
        } else {
            (raw, src_pitch as u32)
        };

        // Placa de vídeo sem redimensionar: BGRA -> NV12 direto, uma conversão só
        if let Sink::Hardware { sender, .. } = &self.flags.sink {
            if (out_w, out_h) == (width, height) {
                let mut data = vec![0u8; (width * height * 3 / 2) as usize];
                let (y, uv) = data.split_at_mut((width * height) as usize);
                yuv_helper::argb_to_nv12(bgra, pitch, y, width, uv, width, width as i32, height as i32);
                let _ = sender.try_send(Nv12Frame { data, timestamp_us }); // cheio = codificador ocupado: descarta
                return Ok(());
            }
        }

        // BGRA (que o libyuv chama de "ARGB") -> I420 (+ redimensiona/estica)
        let mut i420 = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = i420.strides();
        let (y, u, v) = i420.data_mut();
        yuv_helper::argb_to_i420(
            bgra, pitch, y, stride_y, u, stride_u, v, stride_v, width as i32, height as i32,
        );
        let mut i420 = if (out_w, out_h) != (width, height) { i420.scale(out_w as i32, out_h as i32) } else { i420 };

        match &self.flags.sink {
            Sink::Raw(source) => {
                let video_frame = VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us,
                    frame_metadata: None,
                    buffer: i420,
                };
                source.capture_frame(&video_frame);
            }
            Sink::Hardware { sender, .. } => {
                let (sy, su, sv) = i420.strides();
                let (y, u, v) = i420.data_mut();
                let mut data = vec![0u8; (out_w * out_h * 3 / 2) as usize];
                let (dy, duv) = data.split_at_mut((out_w * out_h) as usize);
                yuv_helper::i420_to_nv12(y, sy, u, su, v, sv, dy, out_w, duv, out_w, out_w as i32, out_h as i32);
                let _ = sender.try_send(Nv12Frame { data, timestamp_us });
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        log::info!("captura encerrada (janela fechada?)");
        Ok(())
    }
}

pub fn start(target: Target, fps: u32, flags: Flags) -> Result<Control, String> {
    let interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
    // Opções que só existem em versões mais novas do Windows (tirar a borda amarela,
    // limitar o intervalo, ligar o cursor): sem suporte, fica o padrão do sistema em
    // vez de a captura falhar inteira
    let supported = |check: fn() -> Result<bool, windows_capture::graphics_capture_api::Error>| check().unwrap_or(false);
    let cursor = if supported(GraphicsCaptureApi::is_cursor_settings_supported) {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::Default
    };
    let border = if supported(GraphicsCaptureApi::is_border_settings_supported) {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    let (min_interval, throttle) = if supported(GraphicsCaptureApi::is_minimum_update_interval_supported) {
        (MinimumUpdateIntervalSettings::Custom(interval), None)
    } else {
        // Folga de 10%: um quadro que chega um pouco adiantado não é descartado
        (MinimumUpdateIntervalSettings::Default, Some(interval * 9 / 10))
    };
    log::info!("captura: cursor {cursor:?}, borda {border:?}, intervalo {min_interval:?}");
    let flags = HandlerFlags { flags, throttle };
    macro_rules! run {
        ($item:expr) => {
            ScreenHandler::start_free_threaded(Settings::new(
                $item,
                cursor,
                border,
                SecondaryWindowSettings::Default,
                min_interval,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            ))
            .map_err(|e| format!("Falha ao iniciar a captura: {e}"))
        };
    }
    match target {
        Target::Monitor(index) => run!(Target::monitor(index)?),
        Target::Window(hwnd) => {
            let window = Target::window(hwnd);
            if !window.is_valid() {
                return Err("A janela escolhida não existe mais. Atualize a lista e escolha de novo.".into());
            }
            run!(window)
        }
    }
}

#[derive(serde::Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

pub fn monitors() -> Result<Vec<MonitorInfo>, String> {
    let primary = Monitor::primary().ok().and_then(|m| m.index().ok());
    let list = Monitor::enumerate().map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .filter_map(|m| {
            let index = m.index().ok()?;
            Some(MonitorInfo {
                index,
                name: m.name().unwrap_or_else(|_| format!("Monitor {index}")),
                width: m.width().unwrap_or(0),
                height: m.height().unwrap_or(0),
                primary: Some(index) == primary,
            })
        })
        .collect())
}

/// Jogos conhecidos (aparecem primeiro na lista, com nome bonito).
const KNOWN_GAMES: &[(&str, &str)] = &[
    ("cs2.exe", "Counter-Strike 2"),
    ("csgo.exe", "Counter-Strike"),
    ("valorant-win64-shipping.exe", "VALORANT"),
    ("league of legends.exe", "League of Legends"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("fortniteclient-win64-shipping.exe", "Fortnite"),
    ("dota2.exe", "Dota 2"),
    ("gta5.exe", "GTA V"),
    ("gta5_enhanced.exe", "GTA V"),
    ("rocketleague.exe", "Rocket League"),
    ("overwatch.exe", "Overwatch 2"),
    ("minecraft.exe", "Minecraft"),
    ("javaw.exe", "Minecraft (Java)"),
    ("eldenring.exe", "Elden Ring"),
    ("rainbowsix.exe", "Rainbow Six Siege"),
    ("tslgame.exe", "PUBG"),
    ("cod.exe", "Call of Duty"),
    ("fc25.exe", "EA FC"),
    ("fc26.exe", "EA FC"),
];

/// Processos que não fazem sentido transmitir (janelas do sistema).
const IGNORED: &[&str] = &["textinputhost.exe", "applicationframehost.exe", "shellexperiencehost.exe", "searchhost.exe", "startmenuexperiencehost.exe", "systemsettings.exe", "lockapp.exe"];

#[derive(serde::Serialize)]
pub struct WindowInfo {
    /// HWND (como texto: o JavaScript não guarda inteiros de 64 bits com segurança)
    pub id: String,
    pub title: String,
    pub process: String,
    /// Nome do jogo, se for um jogo conhecido
    pub game: Option<String>,
    pub width: i32,
    pub height: i32,
}

pub fn windows() -> Result<Vec<WindowInfo>, String> {
    let own_pid = std::process::id();
    let mut list: Vec<WindowInfo> = Window::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|w| {
            if w.process_id().ok()? == own_pid {
                return None;
            }
            let title = w.title().ok()?.trim().to_string();
            let process = exe_name(w.process_id().ok()?).or_else(|| w.process_name().ok()).unwrap_or_default();
            let lower = process.to_lowercase();
            if title.is_empty() || IGNORED.contains(&lower.as_str()) {
                return None;
            }
            let (width, height) = (w.width().ok()?, w.height().ok()?);
            if width < 160 || height < 120 {
                return None;
            }
            let game = KNOWN_GAMES.iter().find(|(exe, _)| *exe == lower).map(|(_, name)| name.to_string());
            Some(WindowInfo { id: (w.as_raw_hwnd() as isize).to_string(), title, process, game, width, height })
        })
        .collect();
    list.sort_by_key(|w| (w.game.is_none(), w.title.to_lowercase()));
    Ok(list)
}

/// Nome do executável do processo. Usa a consulta "limitada", que funciona até com
/// jogos protegidos por anti-cheat (Vanguard, EAC), onde ler o módulo é negado.
fn exe_name(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(|c| c == '\\' || c == '/').next().map(str::to_string)
    }
}
