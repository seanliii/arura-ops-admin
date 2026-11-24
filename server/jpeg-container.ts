/**
 * 返回第一幅完整 JPEG 的结束位置，不解码像素。
 * 按段长度和扫描数据查找 EOI，不能把 EXIF/APP 元数据中的 FFD9 当成结尾。
 * 上传可去掉此位置之后的导出软件附加数据；严格导出仍要求它等于文件大小。
 */
export function jpegImageEnd(bytes: Buffer): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2, frame = false, scan = false
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9) return frame && scan ? offset : null
    if (marker === undefined || marker === 0 || marker === 0xd8 || offset + 2 > bytes.length) return null
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (size < 8 || !bytes.readUInt16BE(offset + 3) || !bytes.readUInt16BE(offset + 5)) return null
      frame = true
    }
    offset += size
    if (marker === 0xda) {
      if (!frame || size < 6) return null
      scan = true
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue }
        if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; continue }
        break
      }
    }
  }
  return null
}
