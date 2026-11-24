/** 只读取本地文件，不上传或改写；读不到时留空，不能把0秒当作实测。 */
export function readVideoDuration(file: File, timeoutMs = 8000): Promise<number | null> {
  return new Promise(resolve => {
    const video = document.createElement('video')
    let url: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false
    const finish = (seconds: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      if (url) URL.revokeObjectURL(url)
      resolve(seconds)
    }
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const value = video.duration
      finish(Number.isFinite(value) && value > 0 && value <= 86400 ? Math.round(value * 1000) / 1000 : null)
    }
    video.onerror = () => finish(null)
    timer = setTimeout(() => finish(null), timeoutMs)
    try { url = URL.createObjectURL(file); video.src = url }
    catch { finish(null) }
  })
}
