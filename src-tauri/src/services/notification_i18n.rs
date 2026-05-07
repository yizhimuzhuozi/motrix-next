//! Localised strings for Rust-side task notifications.
//!
//! This table intentionally owns the small subset of notification strings
//! required while the WebView is destroyed.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskNotificationTexts {
    pub download_complete_title: &'static str,
    pub download_complete_body: &'static str,
    pub bt_complete_title: &'static str,
    pub bt_complete_body: &'static str,
    pub download_failed_title: &'static str,
    pub download_failed_body: &'static str,
    pub error_unknown: &'static str,
}

const EN_US_TEXTS: TaskNotificationTexts = TaskNotificationTexts {
    download_complete_title: "Download Complete",
    download_complete_body: "Saved: {taskName}",
    bt_complete_title: "BT Download Complete",
    bt_complete_body: "Seeding started: {taskName}",
    download_failed_title: "Download Failed",
    download_failed_body: "{taskName}: {reason}",
    error_unknown: "Unknown error",
};

#[cfg(test)]
const SUPPORTED_LOCALES: &[&str] = &[
    "ar", "bg", "ca", "de", "el", "en-US", "es", "fa", "fr", "hu", "id", "it", "ja", "ko", "nb",
    "nl", "pl", "pt-BR", "ro", "ru", "th", "tr", "uk", "vi", "zh-CN", "zh-TW",
];

pub fn resolve_supported_locale(raw_locale: &str) -> &'static str {
    let locale = raw_locale.trim();
    if locale.is_empty() || locale == "auto" {
        return "en-US";
    }

    match locale {
        "ar" => "ar",
        "bg" => "bg",
        "ca" => "ca",
        "de" => "de",
        "el" => "el",
        "en-US" => "en-US",
        "es" => "es",
        "fa" => "fa",
        "fr" => "fr",
        "hu" => "hu",
        "id" => "id",
        "it" => "it",
        "ja" => "ja",
        "ko" => "ko",
        "nb" => "nb",
        "nl" => "nl",
        "pl" => "pl",
        "pt-BR" => "pt-BR",
        "ro" => "ro",
        "ru" => "ru",
        "th" => "th",
        "tr" => "tr",
        "uk" => "uk",
        "vi" => "vi",
        "zh-CN" => "zh-CN",
        "zh-TW" => "zh-TW",
        _ if locale.starts_with("ar") => "ar",
        _ if locale.starts_with("de") => "de",
        _ if locale.starts_with("en") => "en-US",
        _ if locale.starts_with("es") => "es",
        _ if locale.starts_with("fr") => "fr",
        _ if locale.starts_with("it") => "it",
        _ if locale.starts_with("pt") => "pt-BR",
        "zh-HK" => "zh-TW",
        _ if locale.starts_with("zh") => "zh-CN",
        _ => "en-US",
    }
}

pub fn texts_for_locale(locale: &str) -> TaskNotificationTexts {
    match resolve_supported_locale(locale) {
        "ar" => TaskNotificationTexts {
            download_complete_title: "اكتمل التنزيل",
            download_complete_body: "تم حفظ الملف: {taskName}",
            bt_complete_title: "اكتمل تنزيل BT",
            bt_complete_body: "بدأت المشاركة: {taskName}",
            download_failed_title: "فشل التنزيل",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "bg" => TaskNotificationTexts {
            download_complete_title: "Изтеглянето е завършено",
            download_complete_body: "Файлът е запазен: {taskName}",
            bt_complete_title: "BT изтеглянето е завършено",
            bt_complete_body: "Споделянето започна: {taskName}",
            download_failed_title: "Изтеглянето е неуспешно",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "ca" => TaskNotificationTexts {
            download_complete_title: "Descàrrega completada",
            download_complete_body: "Fitxer desat: {taskName}",
            bt_complete_title: "Descàrrega BT completada",
            bt_complete_body: "S\'ha iniciat la compartició: {taskName}",
            download_failed_title: "Descàrrega fallida",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "de" => TaskNotificationTexts {
            download_complete_title: "Download abgeschlossen",
            download_complete_body: "Datei gespeichert: {taskName}",
            bt_complete_title: "BT-Download abgeschlossen",
            bt_complete_body: "Seeding gestartet: {taskName}",
            download_failed_title: "Download fehlgeschlagen",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "el" => TaskNotificationTexts {
            download_complete_title: "Η λήψη ολοκληρώθηκε",
            download_complete_body: "Το αρχείο αποθηκεύτηκε: {taskName}",
            bt_complete_title: "Η BT λήψη ολοκληρώθηκε",
            bt_complete_body: "Ξεκίνησε η διαμοίραση: {taskName}",
            download_failed_title: "Η λήψη απέτυχε",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "es" => TaskNotificationTexts {
            download_complete_title: "Descarga completada",
            download_complete_body: "Archivo guardado: {taskName}",
            bt_complete_title: "Descarga BT completada",
            bt_complete_body: "Seeding iniciado: {taskName}",
            download_failed_title: "Descarga fallida",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "fa" => TaskNotificationTexts {
            download_complete_title: "دانلود تکمیل شد",
            download_complete_body: "فایل ذخیره شد: {taskName}",
            bt_complete_title: "دانلود BT تکمیل شد",
            bt_complete_body: "اشتراک‌گذاری آغاز شد: {taskName}",
            download_failed_title: "دانلود ناموفق بود",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "fr" => TaskNotificationTexts {
            download_complete_title: "Téléchargement terminé",
            download_complete_body: "Fichier enregistré : {taskName}",
            bt_complete_title: "Téléchargement BT terminé",
            bt_complete_body: "Partage démarré : {taskName}",
            download_failed_title: "Échec du téléchargement",
            download_failed_body: "{taskName} : {reason}",
            error_unknown: "Unknown error",
        },
        "hu" => TaskNotificationTexts {
            download_complete_title: "Letöltés befejezve",
            download_complete_body: "Fájl mentve: {taskName}",
            bt_complete_title: "BT letöltés befejezve",
            bt_complete_body: "Megosztás elindult: {taskName}",
            download_failed_title: "Letöltés sikertelen",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "id" => TaskNotificationTexts {
            download_complete_title: "Unduhan selesai",
            download_complete_body: "File disimpan: {taskName}",
            bt_complete_title: "Unduhan BT selesai",
            bt_complete_body: "Seeding dimulai: {taskName}",
            download_failed_title: "Unduhan gagal",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "it" => TaskNotificationTexts {
            download_complete_title: "Download completato",
            download_complete_body: "File salvato: {taskName}",
            bt_complete_title: "Download BT completato",
            bt_complete_body: "Condivisione avviata: {taskName}",
            download_failed_title: "Download non riuscito",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "ja" => TaskNotificationTexts {
            download_complete_title: "ダウンロード完了",
            download_complete_body: "ファイルを保存しました：{taskName}",
            bt_complete_title: "BT ダウンロード完了",
            bt_complete_body: "シードを開始しました：{taskName}",
            download_failed_title: "ダウンロード失敗",
            download_failed_body: "{taskName}：{reason}",
            error_unknown: "不明なエラー",
        },
        "ko" => TaskNotificationTexts {
            download_complete_title: "다운로드 완료",
            download_complete_body: "파일 저장됨: {taskName}",
            bt_complete_title: "BT 다운로드 완료",
            bt_complete_body: "시딩 시작됨: {taskName}",
            download_failed_title: "다운로드 실패",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "알 수 없는 오류",
        },
        "nb" => TaskNotificationTexts {
            download_complete_title: "Nedlasting fullført",
            download_complete_body: "Fil lagret: {taskName}",
            bt_complete_title: "BT-nedlasting fullført",
            bt_complete_body: "Deling startet: {taskName}",
            download_failed_title: "Nedlasting mislyktes",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "nl" => TaskNotificationTexts {
            download_complete_title: "Download voltooid",
            download_complete_body: "Bestand opgeslagen: {taskName}",
            bt_complete_title: "BT-download voltooid",
            bt_complete_body: "Seeden gestart: {taskName}",
            download_failed_title: "Download mislukt",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "pl" => TaskNotificationTexts {
            download_complete_title: "Pobieranie ukończone",
            download_complete_body: "Plik zapisany: {taskName}",
            bt_complete_title: "Pobieranie BT ukończone",
            bt_complete_body: "Udostępnianie rozpoczęte: {taskName}",
            download_failed_title: "Pobieranie nie powiodło się",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "pt-BR" => TaskNotificationTexts {
            download_complete_title: "Download concluído",
            download_complete_body: "Arquivo salvo: {taskName}",
            bt_complete_title: "Download BT concluído",
            bt_complete_body: "Semeadura iniciada: {taskName}",
            download_failed_title: "Download falhou",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "ro" => TaskNotificationTexts {
            download_complete_title: "Descărcare finalizată",
            download_complete_body: "Fișier salvat: {taskName}",
            bt_complete_title: "Descărcare BT finalizată",
            bt_complete_body: "Distribuirea a început: {taskName}",
            download_failed_title: "Descărcarea a eșuat",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "ru" => TaskNotificationTexts {
            download_complete_title: "Загрузка завершена",
            download_complete_body: "Файл сохранён: {taskName}",
            bt_complete_title: "BT-загрузка завершена",
            bt_complete_body: "Раздача началась: {taskName}",
            download_failed_title: "Загрузка не удалась",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "th" => TaskNotificationTexts {
            download_complete_title: "ดาวน์โหลดเสร็จสิ้น",
            download_complete_body: "บันทึกไฟล์แล้ว: {taskName}",
            bt_complete_title: "ดาวน์โหลด BT เสร็จสิ้น",
            bt_complete_body: "เริ่ม seeding แล้ว: {taskName}",
            download_failed_title: "ดาวน์โหลดไม่สำเร็จ",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "tr" => TaskNotificationTexts {
            download_complete_title: "İndirme tamamlandı",
            download_complete_body: "Dosya kaydedildi: {taskName}",
            bt_complete_title: "BT indirmesi tamamlandı",
            bt_complete_body: "Paylaşım başladı: {taskName}",
            download_failed_title: "İndirme başarısız",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "uk" => TaskNotificationTexts {
            download_complete_title: "Завантаження завершено",
            download_complete_body: "Файл збережено: {taskName}",
            bt_complete_title: "BT-завантаження завершено",
            bt_complete_body: "Роздачу розпочато: {taskName}",
            download_failed_title: "Завантаження не вдалося",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "vi" => TaskNotificationTexts {
            download_complete_title: "Tải xuống hoàn thành",
            download_complete_body: "Đã lưu tệp: {taskName}",
            bt_complete_title: "Tải BT hoàn thành",
            bt_complete_body: "Đã bắt đầu seeding: {taskName}",
            download_failed_title: "Tải xuống thất bại",
            download_failed_body: "{taskName}: {reason}",
            error_unknown: "Unknown error",
        },
        "zh-CN" => TaskNotificationTexts {
            download_complete_title: "下载完成",
            download_complete_body: "文件已保存：{taskName}",
            bt_complete_title: "BT 下载完成",
            bt_complete_body: "已开始做种：{taskName}",
            download_failed_title: "下载失败",
            download_failed_body: "{taskName}：{reason}",
            error_unknown: "未知错误",
        },
        "zh-TW" => TaskNotificationTexts {
            download_complete_title: "下載完成",
            download_complete_body: "檔案已儲存：{taskName}",
            bt_complete_title: "BT 下載完成",
            bt_complete_body: "已開始做種：{taskName}",
            download_failed_title: "下載失敗",
            download_failed_body: "{taskName}：{reason}",
            error_unknown: "未知錯誤",
        },
        _ => EN_US_TEXTS,
    }
}

pub fn format_task_message(template: &str, task_name: &str) -> String {
    template.replace("{taskName}", task_name)
}

pub fn format_error_message(template: &str, task_name: &str, reason: &str) -> String {
    template
        .replace("{taskName}", task_name)
        .replace("{reason}", reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_explicit_supported_locale() {
        assert_eq!(resolve_supported_locale("zh-CN"), "zh-CN");
    }

    #[test]
    fn resolves_language_prefix_locale() {
        assert_eq!(resolve_supported_locale("zh-Hans-CN"), "zh-CN");
        assert_eq!(resolve_supported_locale("en-AU"), "en-US");
        assert_eq!(resolve_supported_locale("pt-PT"), "pt-BR");
    }

    #[test]
    fn falls_back_to_en_us_for_auto_or_unknown_locale() {
        assert_eq!(resolve_supported_locale("auto"), "en-US");
        assert_eq!(resolve_supported_locale("xx-YY"), "en-US");
    }

    #[test]
    fn all_supported_locales_have_notification_texts() {
        assert_eq!(SUPPORTED_LOCALES.len(), 26);
        for locale in SUPPORTED_LOCALES {
            let texts = texts_for_locale(locale);
            assert!(
                !texts.download_complete_title.is_empty(),
                "empty complete title for {locale}"
            );
            assert!(
                texts.download_complete_body.contains("{taskName}"),
                "complete body lacks placeholder for {locale}"
            );
            assert!(
                !texts.bt_complete_title.is_empty(),
                "empty BT title for {locale}"
            );
            assert!(
                texts.bt_complete_body.contains("{taskName}"),
                "BT body lacks placeholder for {locale}"
            );
            assert!(
                !texts.download_failed_title.is_empty(),
                "empty failed title for {locale}"
            );
            assert!(
                texts.download_failed_body.contains("{taskName}"),
                "failed body lacks placeholder for {locale}"
            );
            assert!(
                texts.download_failed_body.contains("{reason}"),
                "failed body lacks reason placeholder for {locale}"
            );
            assert!(
                !texts.error_unknown.is_empty(),
                "empty unknown error for {locale}"
            );
        }
    }

    #[test]
    fn localises_download_complete_texts() {
        let texts = texts_for_locale("en-US");
        assert_eq!(texts.download_complete_title, "Download Complete");
        assert_eq!(
            format_task_message(texts.download_complete_body, "file.zip"),
            "Saved: file.zip"
        );
    }

    #[test]
    fn localises_bt_complete_texts() {
        let texts = texts_for_locale("en-US");
        assert_eq!(texts.bt_complete_title, "BT Download Complete");
        assert_eq!(
            format_task_message(texts.bt_complete_body, "file.zip"),
            "Seeding started: file.zip"
        );
    }

    #[test]
    fn localises_error_texts() {
        let texts = texts_for_locale("en-US");
        assert_eq!(
            format_error_message(texts.download_failed_body, "file.zip", "Network error"),
            "file.zip: Network error"
        );
    }
}
