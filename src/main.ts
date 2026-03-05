import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18n } from './composables/useLocale'
import { usePreferenceStore } from './stores/preference'
import { useTaskStore } from './stores/task'
import { useAppStore } from './stores/app'
import aria2Api, { initClient } from './api/aria2'
import { ENGINE_RPC_PORT } from '@shared/constants'
import App from './App.vue'
import 'virtual:uno.css'
import './styles/variables.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { nextTick } from 'vue'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(i18n)

app.mount('#app')

nextTick(() => {
    setTimeout(() => {
        getCurrentWindow().show()
    }, 50)
})

const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const appStore = useAppStore()

async function waitForEngine(port: number, secret: string, maxRetries = 15): Promise<boolean> {
    const { Aria2 } = await import('@shared/aria2')
    for (let i = 0; i < maxRetries; i++) {
        try {
            const probe = new Aria2({ host: '127.0.0.1', port, secret })
            await probe.open()
            await probe.call('getVersion')
            await probe.close()
            return true
        } catch {
            await new Promise((r) => setTimeout(r, 500))
        }
    }
    return false
}

async function autoCheckForUpdate() {
    const config = (preferenceStore.config || {}) as Record<string, unknown>
    if (config.autoCheckUpdate === false) return

    const lastCheck = (config.lastCheckUpdateTime as number) || 0
    const intervalMs = ((config.autoCheckUpdateInterval as number) || 24) * 3_600_000
    if (Date.now() - lastCheck < intervalMs) return

    try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        preferenceStore.updateAndSave({ lastCheckUpdateTime: Date.now() })
        if (update?.available) {
            appStore.pendingUpdate = update
        }
    } catch (e) {
        console.warn('[updater] auto check failed:', e)
    }
}

preferenceStore.loadPreference().then(async () => {
    let locale = preferenceStore.locale
    if (!locale) {
        // First launch: detect system language via Tauri native API
        // navigator.language is unreliable in WebView2 (Windows) and webkit2gtk (Linux)
        try {
            const { locale: osLocale } = await import('@tauri-apps/plugin-os')
            const sysLang = (await osLocale()) || 'en-US' // e.g. 'zh-CN', 'en-US', 'ja-JP'
            const available = Object.keys(i18n.global.messages)
            // Exact match first (e.g. 'zh-CN' → 'zh-CN')
            if (available.includes(sysLang)) {
                locale = sysLang
            } else {
                // Prefix match (e.g. 'zh' → 'zh-CN', 'pt' → 'pt-BR', 'ja-JP' → 'ja')
                const prefix = sysLang.split('-')[0]
                locale = available.find(l => l === prefix || l.startsWith(prefix + '-')) || 'en-US'
            }
        } catch {
            locale = 'en-US'
        }
        preferenceStore.updateAndSave({ locale })
    }
    if (locale && i18n.global.locale) {
        (i18n.global.locale as any).value = locale
    }

    const config = preferenceStore.config || {}
    const port = (config.rpcListenPort as number) || ENGINE_RPC_PORT
    let secret = (config.rpcSecret as string) || ''

    if (!secret) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        const values = crypto.getRandomValues(new Uint8Array(16))
        secret = Array.from(values, (v) => chars[v % chars.length]).join('')
        await preferenceStore.updateAndSave({ rpcSecret: secret })
    }

    taskStore.setApi(aria2Api as any)

    try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('save_system_config', {
            config: { 'rpc-secret': secret, 'rpc-listen-port': String(port) },
        })
        await invoke('start_engine_command')
    } catch (e) {
        console.error('[aria2] Failed to start engine:', e)
    }

    const ready = await waitForEngine(port, secret)
    if (!ready) {
        console.error('[aria2] Engine did not become ready after retries')
    }

    try {
        await initClient({ port, secret })
        console.log('[aria2] RPC client connected via WebSocket on port', port)
    } catch (e) {
        console.warn('[aria2] WebSocket failed, using HTTP fallback:', e)
    }

    try {
        const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
        const startUrls = await getCurrent()
        if (startUrls && startUrls.length > 0) {
            appStore.handleDeepLinkUrls(startUrls)
        }
        await onOpenUrl((urls) => {
            appStore.handleDeepLinkUrls(urls)
        })
    } catch (e) {
        console.warn('[deep-link] setup failed:', e)
    }

    autoCheckForUpdate()

    let lastClipboardText = ''
    getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
        if (!focused) return
        if (appStore.addTaskVisible) return
        try {
            const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
            const text = (await readText() || '').trim()
            if (!text || text === lastClipboardText) return
            const { detectResource } = await import('@shared/utils')
            if (detectResource(text)) {
                lastClipboardText = text
                appStore.addTaskUrl = text
                appStore.showAddTaskDialog('uri')
            }
        } catch { }
    })
})

