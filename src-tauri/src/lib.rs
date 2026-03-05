mod commands;
mod engine;
mod menu;
mod tray;

use engine::EngineState;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("single-instance-triggered", &argv);
            if let Some(w) = app.get_webview_window("main") {
                let _: Result<(), _> = w.show();
                let _: Result<(), _> = w.set_focus();
            }
        }));
    }

    builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
        .manage(EngineState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::save_preference,
            commands::get_system_config,
            commands::save_system_config,
            commands::start_engine_command,
            commands::stop_engine_command,
            commands::restart_engine_command,
            commands::factory_reset,
            commands::update_tray_title,
        ])
        .setup(|app| {
            let handle = app.handle();
            let m = menu::build_menu(handle)?;
            app.set_menu(m)?;
            tray::setup_tray(handle)?;

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "new-task" => {
                    let _ = app.emit("menu-event", "new-task");
                }
                "open-torrent" => {
                    let _ = app.emit("menu-event", "open-torrent");
                }
                "preferences" => {
                    let _ = app.emit("menu-event", "preferences");
                }
                "release-notes" => {
                    let _ = app.emit("menu-event", "release-notes");
                }
                "report-issue" => {
                    let _ = app.emit("menu-event", "report-issue");
                }
                _ => {}
            });

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                let _ = app_handle.emit("deep-link-open", &urls);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = engine::stop_engine(app);
            }
        });
}
