//! Faz o L — app desktop.
//!
//! A janela abre o site do servidor do Faz o L (o mesmo que roda no navegador).
//! Quando a página está dentro do app, o botão "Transmitir" chama os comandos
//! nativos daqui: captura de tela pela GPU, áudio do sistema sem o som do próprio
//! app e envio direto para o LiveKit.

mod headless;
mod hotkeys;
mod logfile;
mod log_queue;
mod mini;
mod server;
mod stream;
mod updater;

/// Modo de teste sem janela (`--test-stream`). Retorna o código de saída.
pub fn run_test_stream(args: &[String]) -> i32 {
    headless::run(args)
}

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod hwenc;

pub fn run() {
    logfile::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(hotkeys::plugin())
        .manage(stream::StreamState::default())
        .manage(updater::UpdateState::default())
        .manage(mini::MiniState::default())
        .manage(hotkeys::HotkeyState::default())
        .invoke_handler(tauri::generate_handler![
            server::app_version,
            logfile::take_client_logs,
            updater::update_status,
            updater::check_update,
            server::get_server,
            server::set_server,
            stream::list_monitors,
            stream::list_windows,
            stream::gpu_encoder,
            stream::start_stream,
            stream::stop_stream,
            mini::set_mini_mode,
            hotkeys::set_clip_hotkeys,
        ])
        .setup(|app| {
            server::open_main_window(app.handle())?;
            let _ = updater::spawn(app.handle().clone());
            hotkeys::register(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Faz o L");
}
