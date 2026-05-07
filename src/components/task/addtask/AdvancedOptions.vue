<script setup lang="ts">
/** @fileoverview Advanced task options panel (UA, auth, referer, cookie, proxy checkbox). */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NFormItem, NInput, NCheckbox, NCollapseTransition, NButton, NRadioGroup, NRadio, NIcon } from 'naive-ui'
import { hasUnsafeHeaderChars, sanitizeHeaderValue } from '@shared/utils/headerSanitize'
import { useSystemProxyDetect } from '@/composables/useSystemProxyDetect'
import { useAppMessage } from '@/composables/useAppMessage'
import { SearchOutline } from '@vicons/ionicons5'

const { t } = useI18n()

const props = defineProps<{
  show: boolean
  userAgent: string
  authorization: string
  referer: string
  cookie: string
  /** Proxy mode: 'none' | 'global' | 'custom'. */
  proxyMode: 'none' | 'global' | 'custom'
  /** Custom proxy address when proxyMode is 'custom'. */
  customProxy: string
  /** Whether a usable global proxy is configured in Settings → Advanced. */
  globalProxyAvailable: boolean
  /** The global proxy server address (displayed as read-only hint). */
  globalProxyServer: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:userAgent': [value: string]
  'update:authorization': [value: string]
  'update:referer': [value: string]
  'update:cookie': [value: string]
  'update:proxyMode': [value: 'none' | 'global' | 'custom']
  'update:customProxy': [value: string]
}>()

const uaHasIssue = computed(() => !!props.userAgent && hasUnsafeHeaderChars(props.userAgent))

function cleanUserAgent() {
  emit('update:userAgent', sanitizeHeaderValue(props.userAgent))
}

const message = useAppMessage()
const { detecting: detectingProxy, detect: detectProxy } = useSystemProxyDetect({
  onSuccess(info) {
    emit('update:customProxy', info.server)
    message.success(t('preferences.proxy-detected-success'))
  },
  onSocks() {
    message.warning(t('preferences.proxy-system-socks-rejected'))
  },
  onNotFound() {
    message.info(t('preferences.proxy-system-not-detected'))
  },
  onError() {
    message.error(t('preferences.proxy-system-detect-failed'))
  },
})
</script>

<template>
  <NFormItem :show-label="false">
    <NCheckbox :checked="show" @update:checked="$emit('update:show', $event)">
      {{ t('task.show-advanced-options') }}
    </NCheckbox>
  </NFormItem>
  <NCollapseTransition :show="show">
    <div>
      <NFormItem :label="t('task.task-user-agent') + ':'">
        <div class="ua-field-wrapper">
          <NInput
            :value="userAgent"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 3 }"
            @update:value="$emit('update:userAgent', $event)"
          />
          <!-- UA sanitization hint — slides in via CSS Grid 0fr→1fr -->
          <div class="ua-warn-collapse" :class="{ 'ua-warn-collapse--open': uaHasIssue }">
            <div class="ua-warn-collapse__inner">
              <div class="ua-warn-bar">
                <span class="ua-warn-text">⚠ {{ t('preferences.ua-unsafe-chars-detected') }}</span>
                <NButton size="tiny" type="primary" ghost @click="cleanUserAgent">
                  {{ t('preferences.ua-sanitize') }}
                </NButton>
              </div>
            </div>
          </div>
        </div>
      </NFormItem>
      <NFormItem :label="t('task.task-authorization') + ':'">
        <NInput
          :value="authorization"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          @update:value="$emit('update:authorization', $event)"
        />
      </NFormItem>
      <NFormItem :label="t('task.task-referer') + ':'">
        <NInput
          :value="referer"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          @update:value="$emit('update:referer', $event)"
        />
      </NFormItem>
      <NFormItem :label="t('task.task-cookie') + ':'">
        <NInput
          :value="cookie"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          @update:value="$emit('update:cookie', $event)"
        />
      </NFormItem>
      <NFormItem :label="t('task.task-proxy-label') + ':'">
        <div class="proxy-radio-group">
          <NRadioGroup
            :value="proxyMode"
            name="add-task-proxy-mode"
            @update:value="$emit('update:proxyMode', $event as 'none' | 'global' | 'custom')"
          >
            <NRadio value="none">{{ t('task.proxy-mode-none') }}</NRadio>
            <NRadio v-if="globalProxyAvailable" value="global">
              {{ t('task.proxy-mode-global') }}
            </NRadio>
            <NRadio value="custom">{{ t('task.proxy-mode-custom') }}</NRadio>
          </NRadioGroup>
          <div class="proxy-hint-collapse" :class="{ 'proxy-hint-collapse--open': proxyMode === 'global' }">
            <div class="proxy-hint-collapse__inner">
              <div class="proxy-server-hint">{{ t('task.proxy-global-server') }} {{ globalProxyServer }}</div>
            </div>
          </div>
          <NCollapseTransition :show="proxyMode === 'custom'">
            <div class="custom-proxy-input">
              <NInput
                :value="customProxy"
                placeholder="http://host:port"
                @update:value="$emit('update:customProxy', $event)"
              />
              <NButton :loading="detectingProxy" size="small" @click="detectProxy">
                <template #icon>
                  <NIcon><SearchOutline /></NIcon>
                </template>
                {{ t('preferences.detect-system-proxy') }}
              </NButton>
            </div>
          </NCollapseTransition>
        </div>
      </NFormItem>
    </div>
  </NCollapseTransition>
</template>

<style scoped>
/* ── UA field wrapper — stacks textarea + warning ────────────────── */
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── UA warning — CSS Grid 0fr→1fr slide-in ──────────────────────── */
.ua-warn-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open {
  grid-template-rows: 1fr;
}
.ua-warn-collapse__inner {
  overflow: hidden;
}
.ua-warn-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-top: 6px;
  border-radius: var(--border-radius);
  background: var(--m3-error-container-bg);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open .ua-warn-bar {
  opacity: 1;
}
.ua-warn-text {
  font-size: var(--font-size-sm);
  color: var(--m3-error);
  flex: 1;
}

/* ── Proxy radio group ──────────────────────────────────────────── */
.proxy-radio-group {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.proxy-hint-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.proxy-hint-collapse--open {
  grid-template-rows: 1fr;
}
.proxy-hint-collapse__inner {
  overflow: hidden;
}
.proxy-server-hint {
  font-size: var(--font-size-sm);
  color: var(--n-text-color-3, #999);
  opacity: 0.8;
  user-select: all;
  padding: 4px 0 2px;
}
.custom-proxy-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.custom-proxy-input .n-button {
  align-self: flex-start;
}
</style>
