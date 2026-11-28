//! Qual servidor do Faz o L o app abre.
//!
//! Ordem: o que o usuário salvou > FAZOL_SERVER_URL definido na compilação >
//! página local pedindo o endereço.

use std::fs;
use std::path::PathBuf;

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// Servidor padrão embutido na compilação (ex.: FAZOL_SERVER_URL=https://live.exemplo.com)
const DEFAULT_SERVER: Option<&str> = option_env!("FAZOL_SERVER_URL");

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("server.txt"))
}

fn saved_server(app: &AppHandle) -> Option<String> {
    config_file(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| DEFAULT_SERVER.map(str::to_string))
}

/// Aceita "live.exemplo.com" ou "https://live.exemplo.com/qualquer" e devolve só a origem.
fn normalize(input: &str) -> Result<Url, String> {
    let input = input.trim();
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let url = Url::parse(&with_scheme).map_err(|_| "Endereço inválido.".to_string())?;
    let host = url.host_str().ok_or("Endereço inválido.")?.to_string();
    let local = host == "localhost" || host == "127.0.0.1";
    if url.scheme() != "https" && !(local && url.scheme() == "http") {
        return Err("O servidor precisa usar https://".into());
    }
    Url::parse(&url.origin().ascii_serialization()).map_err(|e| e.to_string())
}

/// Libera os comandos nativos de transmissão só para o site do servidor escolhido.
fn allow_remote(app: &AppHandle, origin: &Url) {
    let pattern = format!("{}/*", origin.as_str().trim_end_matches('/'));
    let capability = CapabilityBuilder::new("remote-server")
        .remote(pattern)
        .window("main")
        .permission("core:event:default")
        .permission("allow-list-monitors")
        .permission("allow-list-windows")
        .permission("allow-gpu-encoder")
        .permission("allow-app-version")
        .permission("allow-update-status")
        .permission("allow-start-stream")
        .permission("allow-stop-stream")
        .permission("allow-set-mini-mode")
        .permission("allow-set-clip-hotkeys")
        .permission("allow-check-update")
        .permission("core:window:allow-start-dragging");
    if let Err(err) = app.add_capability(capability) {
        log::warn!("capability remota já registrada ou inválida: {err}");
    }
}

pub fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let target = match saved_server(app).and_then(|s| normalize(&s).ok()) {
        Some(origin) => {
            allow_remote(app, &origin);
            WebviewUrl::External(origin)
        }
        None => WebviewUrl::App("index.html".into()),
    };

    WebviewWindowBuilder::new(app, "main", target)
        .title(format!("Faz o L {}", app.package_info().version))
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 560.0)
        .build()?;
    Ok(())
}

/// Versão do app (mostrada no painel do site, junto com a versão do site)
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    // Vem do tauri.conf.json, que o workflow de release preenche com a versão da tag
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_server(app: AppHandle) -> Option<String> {
    saved_server(&app)
}

#[tauri::command]
pub fn set_server(app: AppHandle, url: String) -> Result<(), String> {
    let origin = normalize(&url)?;
    let path = config_file(&app).ok_or("Não achei a pasta de configuração.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, origin.as_str()).map_err(|e| e.to_string())?;

    allow_remote(&app, &origin);
    let window = app.get_webview_window("main").ok_or("Janela principal não encontrada.")?;
    window.navigate(origin).map_err(|e| e.to_string())
}
