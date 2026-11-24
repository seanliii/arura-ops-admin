import { computed, onBeforeUnmount, reactive, watch } from 'vue'

/** 每个计时器独立核对；一项恢复不能替另一项解除切换保护。 */
export function useDeliveryWorkLocks(changed: (locked: boolean) => void) {
  const pending = reactive(new Set<string>())
  const locked = computed(() => pending.size > 0)
  function setLocked(key: string, value: boolean) {
    if (value) pending.add(key)
    else pending.delete(key)
  }
  watch(locked, changed, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => changed(false))
  return { locked, setLocked }
}
