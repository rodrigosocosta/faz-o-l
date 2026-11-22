fn main() {
    // Declara os comandos do app para gerar as permissões allow-<comando>,
    // usadas pela capability da página remota (o site do Faz o L).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_version",
            "update_status",
            "get_server",
            "set_server",
            "list_monitors",
            "list_windows",
            "gpu_encoder",
            "start_stream",
            "stop_stream",
            "set_mini_mode",
            "set_clip_hotkeys",
            "check_update",
        ]),
    ))
    .expect("falha ao rodar tauri-build");
}
