/// Network utility commands: remote file fetching and filename resolution.
///
/// `fetch_remote_bytes` — Downloads raw bytes (e.g. `.torrent` files) for
/// the browser extension deep-link flow.
///
/// `resolve_filename` — Compensates for aria2's filename resolution gap:
/// aria2 only uses `Content-Disposition` and the URL path to determine
/// filenames, but never falls back to `Content-Type` MIME mapping.  Many
/// CDNs (Twitter/X, Discord, Reddit) serve media from extensionless URL
/// paths with the format info in query parameters or Content-Type headers.
/// This command performs a lightweight HEAD request and resolves the correct
/// filename using the same three-level fallback browsers use:
///   1. Content-Disposition → filename (RFC 6266)
///   2. Redirect target URL → path extension
///   3. Content-Type MIME → extension via `mime2ext` (embeds mime-db)
use crate::error::AppError;

const MAX_TORRENT_SIZE: usize = 16 * 1024 * 1024; // 16 MiB — generous for any .torrent

/// Timeout for HEAD requests in `resolve_filename`.  Short enough to avoid
/// blocking the UI, long enough for CDN edge nodes to respond.
pub(crate) const HEAD_TIMEOUT_SECS: u64 = 5;

// ── Filename resolution ─────────────────────────────────────────────────

/// Sends a HEAD request to `url` and infers the correct filename (with
/// extension) when the URL path segment has none.
///
/// Returns `Ok(Some("filename.ext"))` on successful inference, `Ok(None)`
/// when the URL already has an extension (no work needed) or inference
/// fails (graceful degradation — aria2 saves the file as-is).
///
/// The frontend calls this for each extensionless URL before `aria2.addUri`,
/// setting the returned name as the aria2 `out` option.
#[tauri::command]
pub async fn resolve_filename(url: String) -> Result<Option<String>, AppError> {
    // 1. Extract basename from the URL path
    let basename = extract_basename(&url);
    if basename.is_empty() || has_extension(&basename) {
        return Ok(None); // aria2 can handle this natively
    }

    log::debug!("resolve_filename: basename={basename:?} has no extension, sending HEAD");

    // 2. HEAD request (follows redirects)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HEAD_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AppError::Io(format!("HEAD client init failed: {e}")))?;

    let resp = client
        .head(&url)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("HEAD request failed: {e}")))?;

    // 3a. Level 1 — Content-Disposition filename
    if let Some(cd) = resp.headers().get(reqwest::header::CONTENT_DISPOSITION) {
        if let Some(name) = parse_cd_filename(cd.to_str().unwrap_or("")) {
            if has_extension(&name) {
                log::debug!("resolve_filename: resolved via Content-Disposition → {name}");
                return Ok(Some(name));
            }
        }
    }

    // 3b. Level 2 — Redirect target URL path extension
    let final_basename = extract_basename(resp.url().as_str());
    if has_extension(&final_basename) {
        if let Some(ext) = final_basename.rsplit('.').next() {
            let resolved = format!("{basename}.{ext}");
            log::debug!("resolve_filename: resolved via redirect URL → {resolved}");
            return Ok(Some(resolved));
        }
    }

    // 3c. Level 3 — Content-Type MIME → extension via mime2ext
    if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
        let mime_str = ct.to_str().unwrap_or("");
        // Strip parameters: "image/jpeg; charset=utf-8" → "image/jpeg"
        let mime_core = mime_str.split(';').next().unwrap_or("").trim();
        if let Some(ext) = mime2ext::mime2ext(mime_core) {
            let resolved = format!("{basename}.{ext}");
            log::debug!("resolve_filename: resolved via Content-Type ({mime_core}) → {resolved}");
            return Ok(Some(resolved));
        }
    }

    log::debug!("resolve_filename: no extension inferred for {url}");
    Ok(None) // Inference failed — graceful degradation
}

/// Extracts the last non-empty path segment from a URL, percent-decoded.
///
/// Returns an empty string for URLs without a usable path (bare domain,
/// trailing slash, data URIs, etc.).
pub(crate) fn extract_basename(url: &str) -> String {
    let pathname = match url::Url::parse(url) {
        Ok(parsed) => parsed.path().to_string(),
        Err(_) => url.split('?').next().unwrap_or("").to_string(),
    };
    let raw = pathname
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or("");

    // Percent-decode (e.g. "%E4%B8%AD" → "中")
    match urlencoding::decode(raw) {
        Ok(decoded) => decoded.to_string(),
        Err(_) => raw.to_string(),
    }
}

/// Returns true if `name` contains a commonly-recognized file extension.
///
/// Uses a simple heuristic: a dot followed by 1–10 alphanumeric characters
/// at the end of the string.  This covers all standard extensions without
/// false-positive matching on filenames like "v1.2" (which would need two
/// consecutive dot-segments — extremely rare for actual filenames).
pub(crate) fn has_extension(name: &str) -> bool {
    // Find the last dot — must not be the first character (dotfiles like
    // .gitignore are hidden files, not extensions)
    if let Some(dot_pos) = name.rfind('.') {
        if dot_pos == 0 {
            return false; // Dotfile, not an extension
        }
        let ext = &name[dot_pos + 1..];
        // Extension must be 1–10 chars, all alphanumeric
        !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric())
    } else {
        false
    }
}

/// Parses the `filename` or `filename*` parameter from a Content-Disposition
/// header value.
///
/// Supports two formats per RFC 6266:
///   - `filename="report.pdf"` (quoted)
///   - `filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf` (encoded)
///
/// `filename*` takes precedence over `filename` when both are present.
pub(crate) fn parse_cd_filename(header: &str) -> Option<String> {
    let mut filename: Option<String> = None;
    let mut filename_star: Option<String> = None;

    for part in header.split(';') {
        let part = part.trim();

        if let Some(value) = part.strip_prefix("filename*=") {
            // RFC 5987: charset'language'value — we only handle UTF-8
            if let Some(encoded) = value.split("''").nth(1) {
                if let Ok(decoded) = urlencoding::decode(encoded) {
                    filename_star = Some(decoded.to_string());
                }
            }
        } else if let Some(value) = part.strip_prefix("filename=") {
            // Strip surrounding quotes
            let trimmed = value.trim_matches('"').trim_matches('\'');
            if !trimmed.is_empty() {
                filename = Some(trimmed.to_string());
            }
        }
    }

    // filename* takes precedence per RFC 6266 §4.3
    filename_star.or(filename)
}

// ── Remote byte fetching ────────────────────────────────────────────────

#[tauri::command]
pub async fn fetch_remote_bytes(url: String) -> Result<Vec<u8>, AppError> {
    log::info!("fetch_remote_bytes: url={url:?}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AppError::Io(format!("HTTP client init failed: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("HTTP request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Io(format!("HTTP {}", resp.status())));
    }

    // Check Content-Length header upfront to reject oversized responses early
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_TORRENT_SIZE {
            return Err(AppError::Io(format!(
                "Response too large: {len} bytes (max {MAX_TORRENT_SIZE})"
            )));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Io(format!("Failed to read response body: {e}")))?;

    if bytes.len() > MAX_TORRENT_SIZE {
        return Err(AppError::Io(format!(
            "Response too large: {} bytes (max {MAX_TORRENT_SIZE})",
            bytes.len()
        )));
    }

    log::info!("fetch_remote_bytes: downloaded {} bytes", bytes.len());
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_torrent_size_is_16_mib() {
        assert_eq!(MAX_TORRENT_SIZE, 16 * 1024 * 1024);
    }

    // ── extract_basename ────────────────────────────────────────────

    #[test]
    fn extract_basename_normal_url() {
        assert_eq!(
            extract_basename("https://example.com/path/file.zip"),
            "file.zip"
        );
    }

    #[test]
    fn extract_basename_strips_query() {
        assert_eq!(
            extract_basename(
                "https://pbs.twimg.com/media/HCo_0zsbkAEov7s?format=jpg&name=4096x4096"
            ),
            "HCo_0zsbkAEov7s"
        );
    }

    #[test]
    fn extract_basename_encoded() {
        assert_eq!(
            extract_basename("https://example.com/%E4%B8%AD%E6%96%87.pdf"),
            "中文.pdf"
        );
    }

    #[test]
    fn extract_basename_trailing_slash() {
        assert_eq!(extract_basename("https://example.com/"), "");
    }

    #[test]
    fn extract_basename_bare_domain() {
        assert_eq!(extract_basename("https://example.com"), "");
    }

    // ── has_extension ───────────────────────────────────────────────

    #[test]
    fn has_extension_with_ext() {
        assert!(has_extension("file.jpg"));
        assert!(has_extension("archive.tar.gz"));
        assert!(has_extension("report.PDF"));
    }

    #[test]
    fn has_extension_without_ext() {
        assert!(!has_extension("HCo_0zsbkAEov7s"));
        assert!(!has_extension("noext"));
        assert!(!has_extension(""));
    }

    #[test]
    fn has_extension_dot_only() {
        assert!(!has_extension("file."));
        assert!(!has_extension("."));
    }

    #[test]
    fn has_extension_hidden_file() {
        assert!(!has_extension(".gitignore")); // Unix hidden file, not an extension
    }

    // ── parse_cd_filename ───────────────────────────────────────────

    #[test]
    fn parse_cd_filename_quoted() {
        assert_eq!(
            parse_cd_filename("attachment; filename=\"report.pdf\""),
            Some("report.pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_unquoted() {
        assert_eq!(
            parse_cd_filename("attachment; filename=report.pdf"),
            Some("report.pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_star_utf8() {
        assert_eq!(
            parse_cd_filename("attachment; filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf"),
            Some("報告.pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_star_takes_precedence() {
        let cd = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf";
        assert_eq!(parse_cd_filename(cd), Some("報告.pdf".into()));
    }

    #[test]
    fn parse_cd_filename_missing() {
        assert_eq!(parse_cd_filename("inline"), None);
    }

    #[test]
    fn parse_cd_filename_empty() {
        assert_eq!(parse_cd_filename(""), None);
    }

    // ── has_extension edge cases for .gitignore-style ────────────────

    #[test]
    fn has_extension_rejects_too_long_ext() {
        assert!(!has_extension("file.abcdefghijk")); // 11 chars
    }

    #[test]
    fn has_extension_accepts_max_length() {
        assert!(has_extension("file.abcdefghij")); // 10 chars
    }

    // ── mime2ext integration ────────────────────────────────────────

    #[test]
    fn mime2ext_resolves_common_types() {
        // mime-db maps image/jpeg → "jpg" (the preferred short form)
        assert_eq!(mime2ext::mime2ext("image/jpeg"), Some("jpg"));
        assert_eq!(mime2ext::mime2ext("image/png"), Some("png"));
        assert_eq!(mime2ext::mime2ext("video/mp4"), Some("mp4"));
        assert_eq!(mime2ext::mime2ext("application/pdf"), Some("pdf"));
    }

    #[test]
    fn mime2ext_returns_none_for_unknown() {
        assert_eq!(mime2ext::mime2ext("application/x-unknown-test"), None);
    }
}
