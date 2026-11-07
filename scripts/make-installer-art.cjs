// Renders the installer artwork (24-bit BMPs that NSIS requires).
// Run with: npx electron scripts/make-installer-art.cjs
//   resources/installerSidebar.bmp  164×314  welcome and finish pages
//   resources/installerHeader.bmp   150×57   header of the other pages
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const { markSvg: mark } = require('./maris-mark.cjs')

const out = path.join(__dirname, '..', 'resources')

/** Draw in the page and return raw RGBA pixels. */
async function paint(win, w, h, script) {
  const data = await win.webContents.executeJavaScript(`(async () => {
    const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
    const g = c.getContext('2d');
    const img = async (svg) => { const i = new Image(); i.src = 'data:image/svg+xml;base64,' + btoa(svg); await i.decode(); return i };
    ${script}
    return Array.from(g.getImageData(0, 0, ${w}, ${h}).data);
  })()`)
  return Uint8Array.from(data)
}

/** 24-bit bottom-up BMP, rows padded to 4 bytes. */
function bmp(w, h, rgba) {
  const row = Math.ceil((w * 3) / 4) * 4
  const size = 54 + row * h
  const b = Buffer.alloc(size)
  b.write('BM', 0)
  b.writeUInt32LE(size, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(w, 18)
  b.writeInt32LE(h, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  b.writeUInt32LE(row * h, 34)
  b.writeInt32LE(2835, 38)
  b.writeInt32LE(2835, 42)
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      b[dst + x * 3] = rgba[s + 2]
      b[dst + x * 3 + 1] = rgba[s + 1]
      b[dst + x * 3 + 2] = rgba[s]
    }
  }
  return b
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 400 })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const font = JSON.stringify('"Segoe UI Variable Display", "Segoe UI", sans-serif')

  // Sidebar: the night-violet field of the app's dark theme, a bloom of light behind the mark.
  const sidebar = await paint(
    win,
    164,
    314,
    `
    g.fillStyle = '#15131f'; g.fillRect(0, 0, 164, 314);
    let r = g.createRadialGradient(82, 118, 4, 82, 118, 150);
    r.addColorStop(0, 'rgba(139,118,255,0.55)'); r.addColorStop(0.45, 'rgba(139,118,255,0.14)'); r.addColorStop(1, 'rgba(139,118,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 164, 314);
    r = g.createRadialGradient(150, 320, 2, 150, 320, 120);
    r.addColorStop(0, 'rgba(242,181,68,0.30)'); r.addColorStop(1, 'rgba(242,181,68,0)');
    g.fillStyle = r; g.fillRect(0, 0, 164, 314);
    g.drawImage(await img(${JSON.stringify(mark(84))}), 40, 76, 84, 84);
    g.fillStyle = '#ecebf6'; g.textAlign = 'center';
    g.font = '300 30px ' + ${font}; g.fillText('Maris', 82, 206);
    g.fillStyle = '#a9a5c0'; g.font = '400 11.5px ' + ${font};
    g.fillText('A private AI', 82, 230); g.fillText('that runs on this PC', 82, 245);
    g.strokeStyle = 'rgba(167,163,191,0.18)'; g.beginPath(); g.moveTo(52, 268); g.lineTo(112, 268); g.stroke();
    `
  )
  fs.writeFileSync(path.join(out, 'installerSidebar.bmp'), bmp(164, 314, sidebar))

  // Header: quiet white strip with the mark, as Windows installers expect.
  const header = await paint(
    win,
    150,
    57,
    `
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 150, 57);
    g.drawImage(await img(${JSON.stringify(mark(38))}), 104, 9, 38, 38);
    `
  )
  fs.writeFileSync(path.join(out, 'installerHeader.bmp'), bmp(150, 57, header))
  console.log('installer art written to', out)
  app.quit()
})
