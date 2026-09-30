// Packs the generated icon PNGs (16/32/48/256) into a single .ico
// using PNG-compressed icon entries (supported since Windows Vista).
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'src-tauri', 'icons')

const sizes = [
  { s: 16, file: 'icon_16.png' },
  { s: 32, file: 'icon_32.png' },
  { s: 48, file: 'icon_48.png' },
  { s: 256, file: 'icon_256.png' },
]

const blobs = sizes.map(({ s, file }) => ({ s, data: readFileSync(join(iconDir, file)) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(blobs.length, 4)

const entries = Buffer.alloc(16 * blobs.length)
let offset = header.length + entries.length
blobs.forEach(({ s, data }, i) => {
  const e = i * 16
  entries[e] = s >= 256 ? 0 : s // width (0 = 256)
  entries[e + 1] = s >= 256 ? 0 : s
  entries[e + 2] = 0 // palette
  entries[e + 3] = 0 // reserved
  entries.writeUInt16LE(1, e + 4) // planes
  entries.writeUInt16LE(32, e + 6) // bpp
  entries.writeUInt32LE(data.length, e + 8)
  entries.writeUInt32LE(offset, e + 12)
  offset += data.length
})

const out = Buffer.concat([header, entries, ...blobs.map((b) => b.data)])
writeFileSync(join(iconDir, 'icon.ico'), out)
// a plain 128 png is used by the tray at runtime
writeFileSync(join(iconDir, 'icon.png'), readFileSync(join(iconDir, 'icon_256.png')))
writeFileSync(join(iconDir, '32x32.png'), readFileSync(join(iconDir, 'icon_32.png')))
console.log('icon.ico written,', out.length, 'bytes')
