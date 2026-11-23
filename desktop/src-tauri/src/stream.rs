//! Sessão de transmissão: conecta no LiveKit com o token do servidor e publica
//! a tela (vídeo) e o áudio do sistema.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::Mutex;

#[derive(Deserialize, Clone)]
pub struct StartArgs {
    pub url: String,
    pub token: String,
    pub monitor: usize,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u64,
    pub codec: String,
    pub audio: bool,
    /// HWND da janela (jogo) a transmitir; vazio = monitor
    #[serde(default)]
    pub window: Option<String>,
    /// Esticar a parte 4:3 do centro para 16:9 (CS esticado)
    #[serde(default)]
    pub stretch: bool,
    /// "game" = só o som da janela escolhida; senão, o som do PC todo (menos o app)
    #[serde(default)]
    pub audio_mode: Option<String>,
    /// Tira o Discord do som da live e manda as vozes numa trilha à parte, que só
    /// entra nos clipes (padrão: sim)
    #[serde(default)]
    pub separate_voices: Option<bool>,
}

pub struct Session {
    pub room: Arc<Room>,
    pub video_track: LocalVideoTrack,
    stop: Arc<AtomicBool>,
    #[cfg(windows)]
    capture: Option<crate::capture::Control>,
    encoder_thread: Option<JoinHandle<()>>,
    audio_thread: Option<JoinHandle<()>>,
    voices_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct StreamState(Mutex<Option<Session>>);

impl StreamState {
    pub async fn is_active(&self) -> bool {
        self.0.lock().await.is_some()
    }
}

fn emit_state(app: &AppHandle, state: &str, message: Option<String>, encoder: Option<String>) {
    let _ = app.emit("stream-state", json!({ "state": state, "message": message, "encoder": encoder }));
}

fn codec_of(name: &str) -> (VideoCodec, &'static str) {
    match name {
        "av1" => (VideoCodec::AV1, "AV1"),
        "vp9" => (VideoCodec::VP9, "VP9"),
        "h264" => (VideoCodec::H264, "H.264"),
        // Padrão: VP8 (libvpx usa vários núcleos; o OpenH264 empaca em 1080p60)
        _ => (VideoCodec::VP8, "VP8"),
    }
}

pub async fn teardown(session: Session) {
    session.stop.store(true, Ordering::Relaxed);
    #[cfg(windows)]
    if let Some(control) = session.capture {
        let _ = control.stop();
    }
    for handle in [session.encoder_thread, session.audio_thread, session.voices_thread].into_iter().flatten() {
        let _ = tauri::async_runtime::spawn_blocking(move || handle.join()).await;
    }
    let _ = session.room.close().await;
}

/// Conecta, publica tela (+ áudio) e inicia a captura. Usado pelo app e pelo modo de teste.
pub async fn open_session(args: &StartArgs) -> Result<(Session, UnboundedReceiver<RoomEvent>, String), String> {
    let (room, events) = Room::connect(&args.url, &args.token, RoomOptions::default())
        .await
        .map_err(|e| format!("Não consegui conectar no servidor de vídeo: {e}"))?;
    let room = Arc::new(room);
    let stop = Arc::new(AtomicBool::new(false));

    // ---- vídeo ----
    let resolution = VideoResolution { width: args.width, height: args.height };
    #[cfg(windows)]
    let target = match args.window.as_deref().and_then(|w| w.parse::<isize>().ok()) {
        Some(hwnd) => crate::capture::Target::Window(hwnd),
        None => crate::capture::Target::Monitor(args.monitor),
    };
    #[cfg(windows)]
    let (width, height) = crate::capture::output_size(target, args.width, args.height, args.stretch);

    // Placa de vídeo: o H.264 sai pronto do hardware e o LiveKit só repassa
    #[cfg(windows)]
    let mut hardware = None;
    #[cfg(windows)]
    if args.codec == "gpu" {
        let source = NativeVideoSource::new_encoded(VideoResolution { width, height });
        match tauri::async_runtime::spawn_blocking({
            let source = source.clone();
            let stop = stop.clone();
            let (fps, bitrate) = (args.fps, args.bitrate.min(u32::MAX as u64) as u32);
            move || crate::hwenc::spawn(source, width, height, fps, bitrate, stop)
        })
        .await
        .map_err(|e| e.to_string())?
        {
            Ok(handle) => hardware = Some((source, handle)),
            Err(e) => log::warn!("{e} — usando VP8 por software"),
        }
    }

    #[cfg(windows)]
    let use_hardware = hardware.is_some();
    #[cfg(not(windows))]
    let use_hardware = false;

    let (video_source, codec, codec_name, encoder_backend, encoder_name) = if use_hardware {
        #[cfg(windows)]
        {
            let (source, handle) = hardware.as_ref().unwrap();
            (source.clone(), VideoCodec::H264, "H.264 (placa de vídeo)", VideoEncoderBackend::PreEncoded, handle.name.clone())
        }
        #[cfg(not(windows))]
        unreachable!()
    } else {
        let requested = if args.codec == "gpu" { "vp8" } else { args.codec.as_str() };
        let (codec, name) = codec_of(requested);
        (NativeVideoSource::new(resolution, true), codec, name, VideoEncoderBackend::Auto, "software".to_string())
    };

    let video_track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(video_source.clone()));
    let publish = room
        .local_participant()
        .publish_track(
            LocalTrack::Video(video_track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: codec,
                video_encoder: encoder_backend,
                video_encoding: Some(VideoEncoding { max_bitrate: args.bitrate, max_framerate: args.fps as f64 }),
                // Uma camada só: simulcast dobraria o trabalho de codificação
                simulcast: false,
                stream: "screen".into(),
                ..Default::default()
            },
        )
        .await;
    if let Err(e) = publish {
        let _ = room.close().await;
        return Err(format!("Falha ao publicar a tela: {e}"));
    }

    #[cfg(windows)]
    let (sink, encoder_thread) = match hardware {
        Some((_, handle)) => (
            crate::capture::Sink::Hardware { sender: handle.sender, width, height },
            Some(handle.thread),
        ),
        None => (crate::capture::Sink::Raw(video_source), None),
    };

    #[cfg(windows)]
    let capture = match crate::capture::start(
        target,
        args.fps,
        crate::capture::Flags {
            sink,
            stop: stop.clone(),
            max_width: args.width,
            max_height: args.height,
            stretch: args.stretch,
        },
    ) {
        Ok(control) => Some(control),
        Err(e) => {
            let _ = room.close().await;
            return Err(e);
        }
    };

    // ---- áudio ----
    let mut audio_thread = None;
    let mut voices_thread = None;
    #[cfg(windows)]
    if args.audio {
        let separate = args.separate_voices.unwrap_or(true);
        let audio_source = new_audio_source();
        let audio_track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(audio_source.clone()));
        let published = room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(audio_track),
                TrackPublishOptions {
                    source: TrackSource::ScreenshareAudio,
                    dtx: false, // não corta silêncio (música e jogo)
                    red: false,
                    stream: "screen".into(),
                    ..Default::default()
                },
            )
            .await;
        match published {
            Ok(_) => {
                use crate::audio::Pick;
                let game = if args.audio_mode.as_deref() == Some("game") { target.process_id() } else { None };
                let pick = match (game, separate) {
                    (Some(pid), _) => Pick::Game(pid),
                    (None, true) => Pick::AllButDiscord,
                    (None, false) => Pick::All,
                };
                audio_thread = Some(crate::audio::spawn(audio_source, stop.clone(), pick));
            }
            Err(e) => log::warn!("sem áudio: {e}"),
        }

        // Vozes do Discord: trilha à parte com o nome "voices". O site não toca essa
        // trilha pra ninguém; o gravador mistura ela com a da live nos clipes.
        if separate && audio_thread.is_some() {
            let voices_source = new_audio_source();
            let voices_track = LocalAudioTrack::create_audio_track("voices", RtcAudioSource::Native(voices_source.clone()));
            let published = room
                .local_participant()
                .publish_track(
                    LocalTrack::Audio(voices_track),
                    TrackPublishOptions {
                        source: TrackSource::Unknown,
                        dtx: false, // sempre manda pacotes: o gravador espera as trilhas andarem juntas
                        red: false,
                        stream: "screen".into(),
                        ..Default::default()
                    },
                )
                .await;
            match published {
                Ok(_) => voices_thread = Some(crate::audio::spawn(voices_source, stop.clone(), crate::audio::Pick::Discord)),
                Err(e) => log::warn!("sem a trilha de vozes: {e}"),
            }
        }
    }

    #[cfg(not(windows))]
    let (width, height) = (args.width, args.height);
    let label = format!("{codec_name} • {width}x{height} {} fps • {encoder_name}", args.fps);
    let session = Session {
        room,
        video_track,
        stop,
        #[cfg(windows)]
        capture,
        #[cfg(windows)]
        encoder_thread,
        #[cfg(not(windows))]
        encoder_thread: None,
        audio_thread,
        voices_thread,
    };
    Ok((session, events, label))
}

#[cfg(windows)]
fn new_audio_source() -> NativeAudioSource {
    NativeAudioSource::new(
        AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false },
        crate::audio::SAMPLE_RATE,
        crate::audio::CHANNELS,
        100,
    )
}

/// Nome do codificador de hardware (placa de vídeo), se houver.
#[tauri::command]
pub fn gpu_encoder() -> Option<String> {
    #[cfg(windows)]
    {
        return crate::hwenc::probe();
    }
    #[allow(unreachable_code)]
    None
}

#[tauri::command]
pub fn list_monitors() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        return crate::capture::monitors().map(|m| json!(m));
    }
    #[allow(unreachable_code)]
    Err("Captura nativa disponível só no Windows por enquanto.".into())
}

/// Janelas abertas (jogos conhecidos primeiro).
#[tauri::command]
pub fn list_windows() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        return crate::capture::windows().map(|w| json!(w));
    }
    #[allow(unreachable_code)]
    Err("Captura nativa disponível só no Windows por enquanto.".into())
}

#[tauri::command]
pub async fn start_stream(app: AppHandle, state: State<'_, StreamState>, args: StartArgs) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Err("Já existe uma transmissão em andamento.".into());
    }

    let (session, mut events, label) = open_session(&args).await?;
    *guard = Some(session);
    drop(guard);

    emit_state(&app, "live", None, Some(label));

    // Se o servidor derrubar a conexão (ex.: vaga revogada), encerra tudo
    let app_events = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let RoomEvent::Disconnected { reason } = event {
                let state = app_events.state::<StreamState>();
                if let Some(session) = state.0.lock().await.take() {
                    teardown(session).await;
                    emit_state(&app_events, "error", Some(format!("desconectado ({reason:?})")), None);
                }
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_stream(app: AppHandle, state: State<'_, StreamState>) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.take() {
        teardown(session).await;
        emit_state(&app, "stopped", None, None);
    }
    Ok(())
}
