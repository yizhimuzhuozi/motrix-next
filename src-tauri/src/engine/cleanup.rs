/// Determines whether a process command name is an aria2c process.
///
/// Used by `cleanup_port` (Unix) to verify that only aria2c processes are
/// killed when reclaiming the RPC port — never arbitrary processes that
/// happen to occupy the same port.
///
/// Matches both `aria2c` and `motrixnext-aria2c` (the namespaced sidecar name).
///
/// On Windows, the equivalent check is inlined via `tasklist` CSV output
/// (see the `#[cfg(windows)]` block in `cleanup_port`).
#[cfg(any(unix, test))]
fn is_aria2c_process(comm: &str) -> bool {
    comm.contains("aria2c")
}

/// Kill only aria2c processes occupying the given port, so a new aria2c can bind to it.
/// Non-aria2c processes on the same port are left untouched to prevent accidental kills.
pub(crate) fn cleanup_port(port: &str) {
    // Validate port is a legal u16 — rejects injection payloads,
    // out-of-range values, and non-numeric strings at the gate.
    if port.parse::<u16>().is_err() {
        log::warn!("cleanup_port: rejected invalid port value: {:?}", port);
        return;
    }

    #[cfg(unix)]
    {
        // Direct command invocation — no shell interpolation.
        // The port value is validated as numeric-only above.
        let output = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .stderr(std::process::Stdio::null())
            .output();

        if let Ok(out) = output {
            let pids = String::from_utf8_lossy(&out.stdout);
            let pids = pids.trim();
            if !pids.is_empty() {
                let mut killed_any = false;
                for pid in pids.lines() {
                    let pid = pid.trim();
                    if pid.is_empty() {
                        continue;
                    }
                    // Verify the process is aria2c before killing
                    let check = std::process::Command::new("ps")
                        .args(["-p", pid, "-o", "comm="])
                        .stderr(std::process::Stdio::null())
                        .output();
                    if let Ok(check_out) = check {
                        let comm = String::from_utf8_lossy(&check_out.stdout);
                        let comm = comm.trim();
                        if is_aria2c_process(comm) {
                            log::debug!(
                                "killing leftover aria2c process on port {}: PID {}",
                                port,
                                pid
                            );
                            let _ = std::process::Command::new("kill")
                                .args(["-9", pid])
                                .stderr(std::process::Stdio::null())
                                .status();
                            killed_any = true;
                        } else {
                            log::debug!(
                                "port {} occupied by non-aria2c process '{}' (PID {}), skipping",
                                port,
                                comm,
                                pid
                            );
                        }
                    }
                }
                // Brief wait for OS to release the port — only needed when we killed something
                if killed_any {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // Port value is validated as u16 at function entry.
        // cmd /C is required for the netstat | findstr pipeline syntax —
        // this cannot be expressed as a single Command::new() call.
        // The interpolated port is guaranteed numeric-only by the guard.
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = std::process::Command::new("cmd")
            .args(["/C", &format!("netstat -ano | findstr :{}", port)])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut killed_any = false;
            for line in text.lines() {
                if let Some(pid) = line.split_whitespace().last() {
                    if pid.parse::<u32>().is_ok() {
                        // Verify the process is aria2c before killing
                        let check = std::process::Command::new("cmd")
                            .args([
                                "/C",
                                &format!("tasklist /FI \"PID eq {}\" /NH /FO CSV 2>NUL", pid),
                            ])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                        let is_aria2c = check
                            .map(|o| {
                                let s = String::from_utf8_lossy(&o.stdout);
                                s.to_lowercase().contains("aria2c")
                            })
                            .unwrap_or(false);
                        if is_aria2c {
                            log::debug!(
                                "killing leftover aria2c process on port {}: PID {}",
                                port,
                                pid
                            );
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/PID", pid])
                                .creation_flags(CREATE_NO_WINDOW)
                                .status();
                            killed_any = true;
                        } else {
                            log::debug!(
                                "port {} occupied by non-aria2c process (PID {}), skipping",
                                port,
                                pid
                            );
                        }
                    }
                }
            }
            // Brief wait for OS to release the port — only needed when we killed something
            if killed_any {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_aria2c_process_matches_aria2c() {
        assert!(is_aria2c_process("aria2c"));
    }

    #[test]
    fn is_aria2c_process_matches_namespaced_sidecar() {
        assert!(is_aria2c_process("motrixnext-aria2c"));
    }

    #[test]
    fn is_aria2c_process_matches_full_path() {
        assert!(is_aria2c_process("/usr/local/bin/aria2c"));
    }

    #[test]
    fn is_aria2c_process_rejects_other_processes() {
        assert!(!is_aria2c_process("nginx"));
        assert!(!is_aria2c_process("node"));
        assert!(!is_aria2c_process("python3"));
        assert!(!is_aria2c_process(""));
    }

    // ── Port validation tests (code review fix) ──────────────────

    #[test]
    fn cleanup_port_rejects_shell_injection_attempts() {
        // These must NOT panic AND must NOT execute any shell command.
        // The u16 parse guard should reject all of these at the gate.
        cleanup_port("16800; rm -rf /");
        cleanup_port("16800 && echo pwned");
        cleanup_port("$(whoami)");
        cleanup_port("16800|cat /etc/passwd");
    }

    #[test]
    fn cleanup_port_rejects_non_numeric_input() {
        cleanup_port("");
        cleanup_port("abc");
        cleanup_port("port");
        cleanup_port("   ");
    }

    #[test]
    fn cleanup_port_rejects_out_of_u16_range() {
        // u16::MAX is 65535 — anything above must be rejected
        cleanup_port("65536");
        cleanup_port("99999");
        cleanup_port("100000");
    }

    #[test]
    fn cleanup_port_accepts_valid_port_numbers() {
        // These should not panic. They may fail to find any process
        // listening on these ports — that's fine, the test verifies
        // the validation layer lets them through.
        cleanup_port("1");
        cleanup_port("16800");
        cleanup_port("65535");
    }

    // ── Source-level structural assertion ──────────────────────────

    #[test]
    fn cleanup_port_source_does_not_use_sh_c_for_port_interpolation() {
        // Read our own source file and extract only the PRODUCTION code
        // (everything before #[cfg(test)]) to avoid false positives
        // from comments in the test module itself.
        let source = include_str!("cleanup.rs");
        let test_boundary = source.find("#[cfg(test)]").unwrap_or(source.len());
        let production_code = &source[..test_boundary];

        let fn_start = production_code
            .find("fn cleanup_port")
            .expect("cleanup_port function must exist in cleanup.rs");
        let _fn_body = &production_code[fn_start..];

        // On Unix, the old pattern was:
        //   Command::new("sh").args(["-c", &format!("lsof -ti:{}", port)])
        // The fix replaces this with direct Command::new("lsof").
        #[cfg(unix)]
        {
            assert!(
                !_fn_body.contains(r#"Command::new("sh")"#),
                "Unix cleanup_port must not use sh -c — use direct Command::new instead"
            );
        }
    }
}
