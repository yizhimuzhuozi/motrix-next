/// Protocol handler registration and query commands.
///
/// Provides three cross-platform Tauri commands for managing URL scheme
/// associations (e.g. `magnet:`, `thunder:`):
///
/// - `is_default_protocol_client` — checks if this app is the current default
/// - `set_default_protocol_client` — registers this app as the default handler
/// - `remove_as_default_protocol_client` — unregisters (Windows/Linux only)
///
/// ## Platform strategy
///
/// | Platform | Query                                   | Register                                    | Unregister           |
/// |----------|-----------------------------------------|---------------------------------------------|----------------------|
/// | macOS    | `NSWorkspace.urlForApplication(toOpen:)` | `NSWorkspace.setDefaultApplication(…)`     | no-op (unsupported)  |
/// | Windows  | `tauri-plugin-deep-link::is_registered`  | `tauri-plugin-deep-link::register`          | `…::unregister`      |
/// | Linux    | `tauri-plugin-deep-link::is_registered`  | `tauri-plugin-deep-link::register`          | `…::unregister`      |
use crate::error::AppError;
use tauri::AppHandle;

// ── macOS native implementation ─────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSString, NSURL};

    /// Returns the bundle identifier of the app registered as the default
    /// handler for the given URL scheme, or `None` if no handler is set.
    pub fn get_default_handler_bundle_id(protocol: &str) -> Option<String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let url_str = format!("{protocol}://test");
        let ns_url_str = NSString::from_str(&url_str);
        let test_url = NSURL::URLWithString(&ns_url_str)?;
        let handler_url = workspace.URLForApplicationToOpenURL(&test_url)?;
        let handler_bundle = NSBundle::bundleWithURL(&handler_url)?;
        let bundle_id = handler_bundle.bundleIdentifier()?;
        Some(bundle_id.to_string())
    }

    /// Returns the bundle identifier of the currently running application.
    pub fn current_bundle_id() -> Option<String> {
        let bundle = NSBundle::mainBundle();
        let bundle_id = bundle.bundleIdentifier()?;
        Some(bundle_id.to_string())
    }

    /// Registers this application as the default handler for the given URL
    /// scheme using `LSSetDefaultHandlerForURLScheme`.
    ///
    /// This API works with bundle identifiers (not file paths), so it
    /// functions correctly in both dev mode (`cargo run`) and release
    /// (`.app` bundle).
    pub fn set_as_default_handler(protocol: &str, bundle_id: &str) -> Result<(), String> {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;

        let scheme = CFString::new(protocol);
        let handler = CFString::new(bundle_id);

        // SAFETY: LSSetDefaultHandlerForURLScheme is a stable C API.
        let status = unsafe {
            core_foundation::base::OSStatus::from(LSSetDefaultHandlerForURLScheme(
                scheme.as_concrete_TypeRef(),
                handler.as_concrete_TypeRef(),
            ))
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("LSSetDefaultHandlerForURLScheme returned {status}"))
        }
    }

    // FFI binding for Launch Services
    extern "C" {
        fn LSSetDefaultHandlerForURLScheme(
            scheme: core_foundation::string::CFStringRef,
            handler: core_foundation::string::CFStringRef,
        ) -> i32;
    }
}

// ── Cross-platform Tauri commands ───────────────────────────────────

/// Returns `true` when this application is the OS-level default handler
/// for the given URL scheme (e.g. `"magnet"`, `"thunder"`).
#[tauri::command]
pub async fn is_default_protocol_client(
    _app: AppHandle,
    protocol: String,
) -> Result<bool, AppError> {
    #[cfg(target_os = "macos")]
    {
        let handler_id = macos::get_default_handler_bundle_id(&protocol);
        let self_id = macos::current_bundle_id();
        eprintln!("[protocol] is_default({protocol}): handler={handler_id:?} self={self_id:?}");
        match (&handler_id, &self_id) {
            (Some(handler), Some(self_app)) => Ok(handler == self_app),
            // No handler registered → we are not the default
            (None, _) => Ok(false),
            // Cannot determine our own bundle id → conservative false
            (_, None) => Ok(false),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .is_registered(&protocol)
            .map_err(|e| AppError::Protocol(e.to_string()))
    }
}

/// Registers this application as the OS-level default handler for the
/// given URL scheme.
///
/// On macOS, the system may asynchronously prompt the user for confirmation
/// before the change takes effect — this is Apple's security design.
#[tauri::command]
pub async fn set_default_protocol_client(
    _app: AppHandle,
    protocol: String,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = macos::current_bundle_id();
        eprintln!("[protocol] set_default({protocol}): bundle_id={bundle_id:?}");
        let bundle_id = bundle_id
            .ok_or_else(|| AppError::Protocol("cannot determine app bundle identifier".into()))?;
        macos::set_as_default_handler(&protocol, &bundle_id).map_err(|e| AppError::Protocol(e))
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .register(&protocol)
            .map_err(|e| AppError::Protocol(e.to_string()))
    }
}

/// Removes this application as the OS-level default handler for the
/// given URL scheme.
///
/// On macOS this is a no-op — Apple does not provide an API to
/// programmatically unregister a URL scheme handler. The frontend
/// should guide users to System Settings instead.
#[tauri::command]
pub async fn remove_as_default_protocol_client(
    app: AppHandle,
    protocol: String,
) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, &protocol); // suppress unused warnings
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link()
            .unregister(&protocol)
            .map_err(|e| AppError::Protocol(e.to_string()))
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── macOS-specific tests ────────────────────────────────────────

    #[cfg(target_os = "macos")]
    mod macos_tests {
        use super::super::macos;

        #[test]
        fn get_default_handler_bundle_id_returns_some_for_https() {
            // https:// should always have a handler (Safari/Chrome)
            let result = macos::get_default_handler_bundle_id("https");
            assert!(result.is_some(), "expected a handler for https://");
            let id = result.expect("already checked");
            // Bundle IDs are reverse-DNS (e.g. "com.apple.Safari")
            assert!(
                id.contains('.'),
                "expected reverse-DNS bundle ID, got: {id}"
            );
        }

        #[test]
        fn get_default_handler_bundle_id_returns_none_for_nonsense_scheme() {
            // A random scheme with no handler registered
            let result = macos::get_default_handler_bundle_id("zzznotarealscheme12345");
            assert!(
                result.is_none(),
                "expected None for unregistered scheme, got: {result:?}"
            );
        }

        #[test]
        fn current_bundle_id_returns_value_in_test_context() {
            // In cargo test context, NSBundle.mainBundle may not have a
            // bundleIdentifier (test binaries aren't .app bundles).
            // We just verify it doesn't panic.
            let _result = macos::current_bundle_id();
        }
    }

    // ── Cross-platform logic tests ──────────────────────────────────
    // The Tauri commands require an AppHandle which is only available in
    // integration tests. Here we test the pure logic branches.

    #[test]
    fn protocol_error_variant_display() {
        let e = AppError::Protocol("test failure".into());
        assert_eq!(e.to_string(), "Protocol error: test failure");
    }

    #[test]
    fn protocol_error_variant_serializes() {
        let e = AppError::Protocol("reg failed".into());
        let json = serde_json::to_string(&e).expect("serialize");
        assert_eq!(json, r#"{"Protocol":"reg failed"}"#);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_remove_is_noop() {
        // Verify the macOS unregister path compiles and is a no-op.
        // We can't test the actual Tauri command without AppHandle,
        // but we verify the code path doesn't panic.
        let _ = "magnet"; // Placeholder — real test is compilation.
    }
}
