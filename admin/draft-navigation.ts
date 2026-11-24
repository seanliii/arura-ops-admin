import { onBeforeUnmount } from 'vue'

type DraftGuard = { dirty: () => boolean; busy: () => boolean }
const guards = new Set<DraftGuard>()

/** One confirmation across admin navigation, logout and native refresh; no draft is stored in browser storage. */
export function useDraftNavigationGuard(dirty: () => boolean, busy: () => boolean) {
  const guard = { dirty, busy }
  guards.add(guard)
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty() || busy()) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', beforeUnload)
  onBeforeUnmount(() => {
    guards.delete(guard)
    window.removeEventListener('beforeunload', beforeUnload)
  })
}

export function allowAdminNavigation(): boolean {
  if ([...guards].some(guard => guard.busy())) return false
  return ![...guards].some(guard => guard.dirty()) ||
    window.confirm('有尚未保存的内容或主页修改。离开会放弃这些输入，已保存的剧目和文件不受影响。确定离开？')
}
