<script setup lang="ts">
/** @fileoverview Task status sub-navigation tabs (active, waiting, stopped). */
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { NIcon } from 'naive-ui'
import { PlayOutline, CheckmarkDoneOutline, ListOutline } from '@vicons/ionicons5'
import { type Component } from 'vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const items: { key: string; icon: Component; route: string }[] = [
  { key: 'all', icon: ListOutline, route: '/task/all' },
  { key: 'active', icon: PlayOutline, route: '/task/active' },
  { key: 'stopped', icon: CheckmarkDoneOutline, route: '/task/stopped' },
]

function nav(path: string) {
  router.push({ path }).catch(() => {
    /* duplicate navigation */
  })
}

function isActive(key: string) {
  return route.path.includes(key)
}
</script>

<template>
  <aside class="subnav" data-tauri-drag-region>
    <nav class="subnav-inner" data-tauri-drag-region>
      <h3>{{ t('subnav.task-list') || 'Tasks' }}</h3>
      <ul>
        <li v-for="item in items" :key="item.key">
          <button
            type="button"
            class="subnav-button"
            :class="{ active: isActive(item.key) }"
            :aria-current="isActive(item.key) ? 'page' : undefined"
            @click="nav(item.route)"
          >
            <NIcon :size="16" class="subnav-icon">
              <component :is="item.icon" />
            </NIcon>
            <span>{{ t('task.' + item.key) || item.key }}</span>
          </button>
        </li>
      </ul>
    </nav>
  </aside>
</template>

<style scoped>
.subnav {
  width: var(--subnav-width);
  height: 100%;
  background-color: var(--subnav-bg);
  color: var(--subnav-text);
  flex-shrink: 0;
  overflow-y: auto;
}
.subnav-inner {
  margin-top: var(--header-top-offset);
  padding: 0 16px;
  user-select: none;
}
.subnav-inner h3 {
  font-size: 16px;
  color: var(--subnav-title);
  font-weight: normal;
  line-height: 24px;
  margin: 0 0 20px;
}
.subnav-inner ul {
  list-style: none;
  padding: 0;
  margin: 0;
  cursor: default;
}
.subnav-inner li {
  margin-bottom: 8px;
}
.subnav-button {
  width: 100%;
  margin-bottom: 8px;
  padding: 8px 10px;
  font-size: 14px;
  line-height: 20px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  text-align: left;
  color: inherit;
  background: transparent;
  border: none;
}
.subnav-button:hover,
.subnav-button.active,
.subnav-button:focus-visible {
  background-color: var(--subnav-active-bg);
  outline: none;
}
.subnav-button:hover span,
.subnav-button:hover .subnav-icon,
.subnav-button.active span,
.subnav-button.active .subnav-icon,
.subnav-button:focus-visible span,
.subnav-button:focus-visible .subnav-icon {
  color: var(--subnav-active-text);
}
.subnav-button span,
.subnav-button .subnav-icon {
  transition: color 0.2s ease;
}
.subnav-icon {
  margin-right: 12px;
}
</style>
