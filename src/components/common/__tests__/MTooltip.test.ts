/**
 * @fileoverview Tests for MTooltip — the project's tooltip wrapper component.
 *
 * MTooltip wraps Naive UI's NTooltip with a fixed delay (500 ms by default),
 * ensuring consistent tooltip timing across the entire application.
 *
 * HONESTY NOTE: These tests exercise the real delay logic.  NTooltip is mocked
 * at the module level because JSDOM can't render Naive UI's popover layer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'

// ── Mock naive-ui — factory must be self-contained (vi.mock is hoisted) ─
vi.mock('naive-ui', async () => {
  const { defineComponent, h: hh } = await import('vue')
  return {
    NTooltip: defineComponent({
      name: 'NTooltip',
      props: {
        delay: { type: Number, default: undefined },
        placement: { type: String, default: undefined },
        disabled: { type: Boolean, default: undefined },
        duration: { type: Number, default: undefined },
      },
      emits: ['update:show'],
      setup(_props, { slots }) {
        return () => hh('div', { class: 'mock-tooltip' }, [slots.trigger?.(), slots.default?.()])
      },
    }),
  }
})

import { TOOLTIP_DEFAULTS } from '@/components/common/MTooltip.vue'
import MTooltip from '@/components/common/MTooltip.vue'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MTooltip', () => {
  // ── Mount helper ────────────────────────────────────────────────
  function mountMTooltip(props: Record<string, unknown> = {}, slots?: Record<string, () => unknown>) {
    return mount(MTooltip, {
      props,
      slots: slots ?? {
        trigger: () => h('button', 'hover me'),
        default: () => 'tooltip text',
      },
    })
  }

  /** Find the inner mocked NTooltip component */
  function findInnerTooltip(wrapper: ReturnType<typeof mountMTooltip>) {
    return wrapper.findComponent({ name: 'NTooltip' })
  }

  // ── Constants ────────────────────────────────────────────────────
  describe('TOOLTIP_DEFAULTS export', () => {
    it('exports default delay of 500ms', () => {
      expect(TOOLTIP_DEFAULTS.delay).toBe(500)
    })
  })

  // ── Default delay ───────────────────────────────────────────────
  describe('default delay', () => {
    it('passes delay=500 to NTooltip when no delay prop is specified', () => {
      const wrapper = mountMTooltip()

      const inner = findInnerTooltip(wrapper)
      expect(inner.exists()).toBe(true)
      expect(inner.props('delay')).toBe(500)
    })

    it('allows overriding delay via prop', () => {
      const wrapper = mountMTooltip({ delay: 300 })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('delay')).toBe(300)
    })

    it('allows setting delay to 0 (instant) when explicitly passed', () => {
      const wrapper = mountMTooltip({ delay: 0 })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('delay')).toBe(0)
    })
  })

  // ── Prop passthrough ────────────────────────────────────────────
  describe('prop passthrough', () => {
    it('passes placement to NTooltip', () => {
      const wrapper = mountMTooltip({ placement: 'right' })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('placement')).toBe('right')
    })

    it('passes disabled to NTooltip', () => {
      const wrapper = mountMTooltip({ disabled: true })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('disabled')).toBe(true)
    })

    it('passes duration to NTooltip', () => {
      const wrapper = mountMTooltip({ duration: 2000 })

      const inner = findInnerTooltip(wrapper)
      expect(inner.props('duration')).toBe(2000)
    })
  })

  // ── Slot passthrough ────────────────────────────────────────────
  describe('slot passthrough', () => {
    it('renders trigger slot content', () => {
      const wrapper = mountMTooltip(
        {},
        {
          trigger: () => h('button', { id: 'my-btn' }, 'click'),
          default: () => 'tooltip info',
        },
      )

      expect(wrapper.find('#my-btn').exists()).toBe(true)
      expect(wrapper.find('#my-btn').text()).toBe('click')
    })

    it('renders default slot text content', () => {
      const wrapper = mountMTooltip(
        {},
        {
          trigger: () => h('button', 'btn'),
          default: () => h('span', { class: 'tip-body' }, 'useful info'),
        },
      )

      expect(wrapper.find('.tip-body').exists()).toBe(true)
      expect(wrapper.find('.tip-body').text()).toBe('useful info')
    })
  })

  // ── Fixed delay (no state machine) ──────────────────────────────
  describe('fixed delay behavior', () => {
    it('always uses props.delay regardless of mount/unmount cycles', () => {
      const w1 = mountMTooltip()
      expect(findInnerTooltip(w1).props('delay')).toBe(500)
      w1.unmount()

      const w2 = mountMTooltip()
      expect(findInnerTooltip(w2).props('delay')).toBe(500)
    })
  })
})
