//! Atalhos globais de clipe (funcionam com o jogo em foco).
//!
//! Padrão: Ctrl+F9 = últimos 30 s, Ctrl+F10 = último 1 min, Ctrl+F11 = últimos 3 min.
//! A página pode trocar teclas e durações (`set_clip_hotkeys`); a escolha fica
//! salva no site e é reenviada toda vez que o app abre.
//! O app só avisa a página (evento "clip-hotkey" com os segundos); quem gera o
//! clipe é o site, igual ao botão ✂ Clipar.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const DEFAULTS: [(&str, u32); 3] = [("Ctrl+F9", 30), ("Ctrl+F10", 60), ("Ctrl+F11", 180)];

/// Atalho registrado (id do atalho) -> (texto do atalho, segundos)
#[derive(Default)]
pub struct HotkeyState(Mutex<HashMap<u32, (String, u32)>>);

#[derive(Deserialize)]
pub struct HotkeyConfig {
    pub shortcut: String,
    pub seconds: u32,
}

#[derive(Serialize)]
pub struct HotkeyResult {
    pub shortcut: String,
    pub ok: bool,
    pub error: Option<String>,
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let found = app
                .state::<HotkeyState>()
                .0
                .lock()
                .ok()
                .and_then(|map| map.get(&pressed.id()).cloned());
            if let Some((label, seconds)) = found {
                log::info!("atalho {label}: clipe de {seconds} s");
                let _ = app.emit("clip-hotkey", seconds);
            }
        })
        .build()
}

/// Troca todos os atalhos de clipe. Devolve, para cada um, se deu certo.
fn apply<R: Runtime>(app: &AppHandle<R>, list: &[(String, u32)]) -> Vec<HotkeyResult> {
    let state = app.state::<HotkeyState>();
    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let _ = app.global_shortcut().unregister_all();
    map.clear();

    list.iter()
        .map(|(text, seconds)| {
            let result = Shortcut::from_str(text)
                .map_err(|e| format!("atalho inválido: {e}"))
                .and_then(|sc| {
                    if map.contains_key(&sc.id()) {
                        return Err("repetido".into());
                    }
                    app.global_shortcut()
                        .register(sc)
                        .map_err(|_| "outro programa já usa esse atalho".to_string())?;
                    map.insert(sc.id(), (text.clone(), (*seconds).clamp(5, 180)));
                    Ok(())
                });
            if let Err(err) = &result {
                log::warn!("atalho {text}: {err}");
            }
            HotkeyResult { shortcut: text.clone(), ok: result.is_ok(), error: result.err() }
        })
        .collect()
}

/// Registra os atalhos padrão ao abrir o app (a página troca depois, se tiver outros salvos).
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    let list: Vec<(String, u32)> = DEFAULTS.iter().map(|(s, n)| (s.to_string(), *n)).collect();
    apply(app, &list);
}

#[tauri::command]
pub fn set_clip_hotkeys(app: AppHandle, _state: State<'_, HotkeyState>, hotkeys: Vec<HotkeyConfig>) -> Vec<HotkeyResult> {
    let list: Vec<(String, u32)> = hotkeys
        .into_iter()
        .filter(|h| !h.shortcut.trim().is_empty())
        .take(6)
        .map(|h| (h.shortcut.trim().to_string(), h.seconds))
        .collect();
    apply(&app, &list)
}
