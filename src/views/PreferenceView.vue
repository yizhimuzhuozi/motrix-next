<script setup lang="ts">
/** @fileoverview Preference settings view with 5-tab sub-routes. */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

const { t } = useI18n()
const route = useRoute()

const tabKey = computed(() => {
  const path = route.path
  if (path.includes('downloads')) return 'downloads'
  if (path.includes('bt')) return 'bt'
  if (path.includes('network')) return 'network'
  if (path.includes('advanced')) return 'advanced'
  return 'general'
})
</script>

<template>
  <div class="preference-view">
    <header class="panel-header" data-tauri-drag-region>
      <h4>{{ t('preferences.' + tabKey) || 'Settings' }}</h4>
    </header>
    <div class="panel-body">
      <router-view v-slot="{ Component, route: innerRoute }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" :key="innerRoute.path" />
        </Transition>
      </router-view>
    </div>
  </div>
</template>

<style scoped>
.preference-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.panel-header {
  padding: var(--header-top-offset) 0 12px;
  margin: 0 36px;
  border-bottom: 2px solid var(--panel-border);
  user-select: none;
}
.panel-header h4 {
  margin: 0;
  color: var(--panel-title);
  font-size: 16px;
  font-weight: normal;
  line-height: 24px;
}
.panel-body {
  flex: 1;
  overflow-y: auto;
}
</style>
