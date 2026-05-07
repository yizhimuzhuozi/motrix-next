#!/usr/bin/env python3
"""Batch-update 26 locale files with auto-shutdown i18n keys.

Adds keys to both preferences.js and app.js for each locale directory.
All values are native translations; single quotes in values are escaped.
"""
import os
import re

LOCALES_DIR = "src/shared/locales"

# ── preferences.js: shutdown-when-complete label ─────────────────────
PREF_TRANSLATIONS = {
    "ar":    "إيقاف التشغيل بعد اكتمال جميع التنزيلات",
    "bg":    "Изключване след завършване на всички изтегляния",
    "ca":    "Apagar després de completar totes les descàrregues",
    "de":    "Nach Abschluss aller Downloads herunterfahren",
    "el":    "Τερματισμός μετά την ολοκλήρωση όλων των λήψεων",
    "en-US": "Shut down after all downloads complete",
    "es":    "Apagar después de completar todas las descargas",
    "fa":    "خاموش شدن پس از اتمام همه دانلودها",
    "fr":    "Éteindre après la fin de tous les téléchargements",
    "hu":    "Leállítás az összes letöltés befejezése után",
    "id":    "Matikan setelah semua unduhan selesai",
    "it":    "Spegni dopo il completamento di tutti i download",
    "ja":    "すべてのダウンロード完了後にシャットダウン",
    "ko":    "모든 다운로드 완료 후 종료",
    "nb":    "Slå av etter at alle nedlastinger er ferdige",
    "nl":    "Afsluiten na voltooiing van alle downloads",
    "pl":    "Wyłącz po zakończeniu wszystkich pobierań",
    "pt-BR": "Desligar após concluir todos os downloads",
    "ro":    "Oprire după finalizarea tuturor descărcărilor",
    "ru":    "Выключить после завершения всех загрузок",
    "th":    "ปิดเครื่องหลังดาวน์โหลดทั้งหมดเสร็จสิ้น",
    "tr":    "Tüm indirmeler tamamlandıktan sonra kapat",
    "uk":    "Вимкнути після завершення всіх завантажень",
    "vi":    "Tắt máy sau khi tải xong tất cả",
    "zh-CN": "所有下载完成后自动关机",
    "zh-TW": "所有下載完成後自動關機",
}

# ── app.js: shutdown countdown dialog keys ───────────────────────────
APP_TRANSLATIONS = {
    "ar":    {
        "shutdown-countdown-title": "إيقاف تشغيل تلقائي",
        "shutdown-countdown-message": "اكتملت جميع التنزيلات. سيتم إيقاف تشغيل النظام خلال {seconds} ثانية.",
        "shutdown-failed": "فشل في إيقاف تشغيل النظام",
    },
    "bg":    {
        "shutdown-countdown-title": "Автоматично изключване",
        "shutdown-countdown-message": "Всички изтегляния са завършени. Системата ще се изключи след {seconds} секунди.",
        "shutdown-failed": "Неуспешно изключване на системата",
    },
    "ca":    {
        "shutdown-countdown-title": "Apagada automàtica",
        "shutdown-countdown-message": "Totes les descàrregues s\\'han completat. El sistema s\\'apagarà en {seconds} segons.",
        "shutdown-failed": "No s\\'ha pogut apagar el sistema",
    },
    "de":    {
        "shutdown-countdown-title": "Automatisches Herunterfahren",
        "shutdown-countdown-message": "Alle Downloads abgeschlossen. System wird in {seconds} Sekunden heruntergefahren.",
        "shutdown-failed": "System konnte nicht heruntergefahren werden",
    },
    "el":    {
        "shutdown-countdown-title": "Αυτόματος τερματισμός",
        "shutdown-countdown-message": "Όλες οι λήψεις ολοκληρώθηκαν. Το σύστημα θα τερματιστεί σε {seconds} δευτερόλεπτα.",
        "shutdown-failed": "Αποτυχία τερματισμού του συστήματος",
    },
    "en-US": {
        "shutdown-countdown-title": "Auto Shutdown",
        "shutdown-countdown-message": "All downloads complete. System will shut down in {seconds}s.",
        "shutdown-failed": "Failed to shut down the system",
    },
    "es":    {
        "shutdown-countdown-title": "Apagado automático",
        "shutdown-countdown-message": "Todas las descargas completadas. El sistema se apagará en {seconds} segundos.",
        "shutdown-failed": "No se pudo apagar el sistema",
    },
    "fa":    {
        "shutdown-countdown-title": "خاموش شدن خودکار",
        "shutdown-countdown-message": "همه دانلودها کامل شد. سیستم در {seconds} ثانیه خاموش می‌شود.",
        "shutdown-failed": "خاموش کردن سیستم ناموفق بود",
    },
    "fr":    {
        "shutdown-countdown-title": "Arrêt automatique",
        "shutdown-countdown-message": "Tous les téléchargements sont terminés. Le système s\\'éteindra dans {seconds} secondes.",
        "shutdown-failed": "Impossible d\\'éteindre le système",
    },
    "hu":    {
        "shutdown-countdown-title": "Automatikus leállítás",
        "shutdown-countdown-message": "Minden letöltés befejeződött. A rendszer {seconds} másodperc múlva leáll.",
        "shutdown-failed": "Nem sikerült leállítani a rendszert",
    },
    "id":    {
        "shutdown-countdown-title": "Matikan Otomatis",
        "shutdown-countdown-message": "Semua unduhan selesai. Sistem akan dimatikan dalam {seconds} detik.",
        "shutdown-failed": "Gagal mematikan sistem",
    },
    "it":    {
        "shutdown-countdown-title": "Spegnimento automatico",
        "shutdown-countdown-message": "Tutti i download completati. Il sistema si spegnerà tra {seconds} secondi.",
        "shutdown-failed": "Impossibile spegnere il sistema",
    },
    "ja":    {
        "shutdown-countdown-title": "自動シャットダウン",
        "shutdown-countdown-message": "すべてのダウンロードが完了しました。{seconds}秒後にシステムをシャットダウンします。",
        "shutdown-failed": "システムのシャットダウンに失敗しました",
    },
    "ko":    {
        "shutdown-countdown-title": "자동 종료",
        "shutdown-countdown-message": "모든 다운로드가 완료되었습니다. {seconds}초 후에 시스템이 종료됩니다.",
        "shutdown-failed": "시스템 종료에 실패했습니다",
    },
    "nb":    {
        "shutdown-countdown-title": "Automatisk avslutning",
        "shutdown-countdown-message": "Alle nedlastinger er fullført. Systemet slås av om {seconds} sekunder.",
        "shutdown-failed": "Kunne ikke slå av systemet",
    },
    "nl":    {
        "shutdown-countdown-title": "Automatisch afsluiten",
        "shutdown-countdown-message": "Alle downloads voltooid. Systeem wordt afgesloten over {seconds} seconden.",
        "shutdown-failed": "Kan het systeem niet afsluiten",
    },
    "pl":    {
        "shutdown-countdown-title": "Automatyczne wyłączenie",
        "shutdown-countdown-message": "Wszystkie pobierania zakończone. System wyłączy się za {seconds} sekund.",
        "shutdown-failed": "Nie udało się wyłączyć systemu",
    },
    "pt-BR": {
        "shutdown-countdown-title": "Desligamento automático",
        "shutdown-countdown-message": "Todos os downloads foram concluídos. O sistema será desligado em {seconds} segundos.",
        "shutdown-failed": "Falha ao desligar o sistema",
    },
    "ro":    {
        "shutdown-countdown-title": "Oprire automată",
        "shutdown-countdown-message": "Toate descărcările sunt complete. Sistemul se va opri în {seconds} secunde.",
        "shutdown-failed": "Nu s-a putut opri sistemul",
    },
    "ru":    {
        "shutdown-countdown-title": "Автовыключение",
        "shutdown-countdown-message": "Все загрузки завершены. Система выключится через {seconds} сек.",
        "shutdown-failed": "Не удалось выключить систему",
    },
    "th":    {
        "shutdown-countdown-title": "ปิดเครื่องอัตโนมัติ",
        "shutdown-countdown-message": "ดาวน์โหลดทั้งหมดเสร็จสิ้น ระบบจะปิดใน {seconds} วินาที",
        "shutdown-failed": "ไม่สามารถปิดระบบได้",
    },
    "tr":    {
        "shutdown-countdown-title": "Otomatik Kapatma",
        "shutdown-countdown-message": "Tüm indirmeler tamamlandı. Sistem {seconds} saniye içinde kapanacak.",
        "shutdown-failed": "Sistem kapatılamadı",
    },
    "uk":    {
        "shutdown-countdown-title": "Автовимкнення",
        "shutdown-countdown-message": "Усі завантаження завершено. Система вимкнеться через {seconds} сек.",
        "shutdown-failed": "Не вдалося вимкнути систему",
    },
    "vi":    {
        "shutdown-countdown-title": "Tự động tắt máy",
        "shutdown-countdown-message": "Tất cả tải xuống đã hoàn tất. Hệ thống sẽ tắt sau {seconds} giây.",
        "shutdown-failed": "Không thể tắt hệ thống",
    },
    "zh-CN": {
        "shutdown-countdown-title": "自动关机",
        "shutdown-countdown-message": "所有下载已完成。系统将在 {seconds} 秒后关机。",
        "shutdown-failed": "关机失败",
    },
    "zh-TW": {
        "shutdown-countdown-title": "自動關機",
        "shutdown-countdown-message": "所有下載已完成。系統將在 {seconds} 秒後關機。",
        "shutdown-failed": "關機失敗",
    },
}


def escape_js(value: str) -> str:
    """Escape single quotes for JS string literals."""
    return value.replace("'", "\\'")


def add_key_to_js_file(filepath: str, key: str, value: str) -> None:
    """Insert a key-value pair before the closing `}` in a JS locale file."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    escaped = escape_js(value)
    new_entry = f"  '{key}': '{escaped}',"

    # Check if key already exists
    if f"'{key}'" in content:
        print(f"  SKIP {filepath} — key '{key}' already exists")
        return

    # Insert before the final closing brace
    # Match the last `}` that closes `export default {`
    content = re.sub(
        r"(\n)\}(\s*)$",
        rf"\1{new_entry}\n}}\2",
        content,
    )

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)


def main() -> None:
    updated = 0

    for locale, pref_value in sorted(PREF_TRANSLATIONS.items()):
        pref_path = os.path.join(LOCALES_DIR, locale, "preferences.js")
        if os.path.exists(pref_path):
            add_key_to_js_file(pref_path, "shutdown-when-complete", pref_value)
            updated += 1
        else:
            print(f"  WARN: {pref_path} not found")

    for locale, app_keys in sorted(APP_TRANSLATIONS.items()):
        app_path = os.path.join(LOCALES_DIR, locale, "app.js")
        if os.path.exists(app_path):
            for key, value in app_keys.items():
                add_key_to_js_file(app_path, key, value)
            updated += 1
        else:
            print(f"  WARN: {app_path} not found")

    print(f"\nDone — updated {updated} files across 26 locales.")


if __name__ == "__main__":
    main()
