// Renders the Maris mark to PNG/ICO icons. Run with: npx electron scripts/make-icons.cjs
// 16 and 32 px (the tray and the small ICO entries) come from hand-placed pixels; every other size is the vector.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { markSvg, traySvg } = require('./maris-mark.cjs')

const out = path.join(__dirname, '..', 'resources')
fs.mkdirSync(out, { recursive: true })

const art = (size) => (size === 16 || size === 32 ? traySvg(size) : markSvg(size))

// Rasterise through a canvas in the page (capturePage is unreliable for hidden windows).
async function render(win, size, svg) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode();
    const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
    c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = []
  for (const size of sizes) pngs.push({ size, data: await render(win, size, art(size)) })
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs))
  fs.writeFileSync(path.join(out, 'icon.png'), await render(win, 512, markSvg(512)))
  fs.writeFileSync(path.join(out, 'tray.png'), await render(win, 16, traySvg(16)))
  fs.writeFileSync(path.join(out, 'tray@2x.png'), await render(win, 32, traySvg(32)))
  console.log('icons written to', out)
  app.quit()
})
