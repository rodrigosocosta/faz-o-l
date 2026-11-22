//! Atualização automática.
//!
//! Toda vez que o app abre, ele olha o `latest.json` da última Release do
//! GitHub. Se tiver versão nova: baixa em segundo plano, espera a transmissão
//! acabar (se tiver uma), instala sem perguntar e o app reabre sozinho.
//! O pacote vem assinado; o app só instala se a assinatura bater com a chave
//! pública em tauri.conf.json.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::stream::StreamState;

#[derive(Clone, Default, Serialize)]
pub struct UpdateStatus {
    /// "checking", "none", "downloading", "waiting" (live em andamento), "installing", "error"
    pub state: String,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct UpdateState(Mutex<UpdateStatus>);

fn set(app: &AppHandle, state: &str, version: Option<&str>, message: Option<String>) {
    let status = UpdateStatus {
        state: state.into(),
        version: version.map(str::to_string),
        message,
    };
    if let Ok(mut current) = app.state::<UpdateState>().0.lock() {
        *current = status.clone();
    }
    let _ = app.emit("update-state", status);
}

/// Uma verificação por vez (a automática ao abrir ou a do botão "Procurar atualização")
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Procura e instala atualização em segundo plano. Devolve false se já tiver uma em andamento.
pub fn spawn(app: AppHandle) -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(&app).await {
            log::warn!("atualização falhou: {err}");
            set(&app, "error", None, Some(err.to_string()));
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    true
}

/// Botão "Procurar atualização" nas configurações: verifica agora e instala se tiver versão nova.
#[tauri::command]
pub fn check_update(app: AppHandle) -> bool {
    spawn(app)
}

async fn run(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    set(app, "checking", None, None);
    // Sem o padrão do plugin (que fecha as janelas antes de abrir o instalador): se o
    // Windows barrar o instalador (Smart App Control, antivírus), o app continua aberto
    // em vez de ficar rodando escondido. Se o instalador abrir, o processo sai sozinho.
    let updater = app
        .updater_builder()
        .on_before_exit(|| log::info!("abrindo o instalador da atualização"))
        .build()?;
    let Some(update) = updater.check().await? else {
        set(app, "none", None, None);
        return Ok(());
    };
    let version = update.version.clone();
    log::info!("versão nova {version}, baixando");
    set(app, "downloading", Some(&version), None);
    let bytes = update.download(|_, _| {}, || {}).await?;

    // Não derruba a live de ninguém: instala só quando não estiver transmitindo
    while app.state::<StreamState>().is_active().await {
        set(app, "waiting", Some(&version), None);
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    set(app, "installing", Some(&version), None);
    // No Windows o instalador assume daqui: fecha o app, instala e reabre
    if let Err(err) = update.install(bytes) {
        log::warn!("instalador não abriu: {err}");
        return Err(format!(
            "O Windows não deixou instalar a versão {version}. Baixe e instale pelo GitHub."
        )
        .into());
    }
    app.restart();
}

/// Estado da atualização (a página pode carregar depois do evento ter saído)
#[tauri::command]
pub fn update_status(state: tauri::State<'_, UpdateState>) -> UpdateStatus {
    state.0.lock().map(|s| s.clone()).unwrap_or_default()
}
