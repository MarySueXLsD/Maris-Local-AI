// The Maris mark: a violet game cartridge with a pixel M on its label, a gold star seal and gold contacts.
// Used by make-icons.cjs and make-installer-art.cjs. src/renderer/src/components/MarisMark.tsx draws the
// same shapes with theme colours, so keep the geometry of the two in step.

const COLORS = {
  face: '#6a4fe0', // --petal in the light theme
  shade: '#523cb0', // face mixed 70/30 with #1a1040, like --mark-shade
  ridge: '#5f46ca', // 86/14
  deep: '#3a2980', // 40/60: connector and seal outline
  label: '#f7f5ff',
  gold: '#f2b544', // --pollen in the dark theme
  light: '#9784e9' // face with 30% white: the top-left highlight
}

// Geometry in a 64×64 box. Light comes from the top left, so the body's shade sits 3.4 down and right.
const FACE = 'M16 5H23.8A8.5 8.5 0 0 0 36.8 5H44.6A6 6 0 0 1 50.6 11V37.2A6 6 0 0 1 44.6 43.2H16A6 6 0 0 1 10 37.2V11A6 6 0 0 1 16 5Z'
const CONNECTOR = 'M15.8 45.6H44.8V54.6A3 3 0 0 1 41.8 57.6H18.8A3 3 0 0 1 15.8 54.6Z'
const PINS = [17.5, 23.1, 28.7, 34.3, 39.9]
const RIDGES = 'M15.4 10.6H21.7M15.4 13.6H21.7M38.9 10.6H45.2M38.9 13.6H45.2'
const HIGHLIGHT = 'M11.6 37V11A4.4 4.4 0 0 1 16 6.6H21.9M38.7 6.6H44.6'
const PIXEL_M = 'M22.8 21.5h3v15h-3zM34.8 21.5h3v15h-3zM25.8 24.5h3v3h-3zM31.8 24.5h3v3h-3zM28.8 27.5h3v3h-3z'
const SEAL =
  '45.3 12.7 46.18 15.38 48.69 14.11 47.42 16.62 50.1 17.5 47.42 18.38 48.69 20.89 46.18 19.62 45.3 22.3 44.42 19.62 41.91 20.89 43.18 18.38 40.5 17.5 43.18 16.62 41.91 14.11 44.42 15.38'

/** The vector mark at any size, for a canvas or an <img>. */
function markSvg(size) {
  const c = COLORS
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<path d="${FACE}" transform="translate(3.4 3.4)" fill="${c.shade}"/>` +
    `<path d="${CONNECTOR}" fill="${c.deep}"/>` +
    PINS.map((x) => `<rect x="${x}" y="49.2" width="3.2" height="6.4" rx="0.8" fill="${c.gold}"/>`).join('') +
    `<path d="${FACE}" fill="${c.face}"/>` +
    `<path d="${RIDGES}" stroke="${c.ridge}" stroke-width="1.3" stroke-linecap="round"/>` +
    `<path d="${HIGHLIGHT}" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="1.4" stroke-linecap="round"/>` +
    `<rect x="15.3" y="17.5" width="30" height="23" rx="3" fill="${c.label}"/>` +
    `<path d="${PIXEL_M}" fill="${c.face}"/>` +
    `<polygon points="${SEAL}" fill="${c.gold}" stroke="${c.deep}" stroke-width="0.9" stroke-linejoin="round"/>` +
    `</svg>`
  )
}

// The tray icons and the 16/32 px icon entries are placed by hand, pixel by pixel, so they stay sharp.
// B face · H highlight · S shade · R ridge · L label · M letter · G gold · C connector
const PIXELS = { B: COLORS.face, H: COLORS.light, S: COLORS.shade, R: COLORS.ridge, L: COLORS.label, M: COLORS.face, G: COLORS.gold, C: COLORS.deep }
const TRAY = {
  16: [
    '..HHHH...HHHH...',
    '.HBBBBBBBBBBBB..',
    '.HBBBBBBBBBGGBS.',
    '.HBLLLLLLLLGGBS.',
    '.HBLLMLLLMLLBBS.',
    '.HBLLMMLMMLLBBS.',
    '.HBLLMLMLMLLBBS.',
    '.HBLLMLLLMLLBBS.',
    '.HBLLMLLLMLLBBS.',
    '.HBLLLLLLLLLBBS.',
    '..BBBBBBBBBBBSS.',
    '...SSSSSSSSSSS..',
    '...CCCCCCCCC....',
    '...CGCGCGCGC....',
    '...CGCGCGCGC....',
    '....CCCCCCC.....'
  ],
  32: [
    '................................',
    '................................',
    '.....HHHHHHH......HHHHHHH.......',
    '....HBBBBBBBB....BBBBBBBBB......',
    '...HBBBBBBBBBBBBBBBBBBBBBBB.....',
    '...HBBBBRRRRRRRRRRRRRRBBBBBS....',
    '...HBBBBBBBBBBBBBBBBBBBBBBBSS...',
    '...HBBBBRRRRRRRRRRRRRRBBBBBSS...',
    '...HBBBBBBBBBBBBBBBBBBGBGBGSS...',
    '...HBBBLLLLLLLLLLLLLLLLGGGBSS...',
    '...HBBLLLLLLLLLLLLLLLLGGGGGSS...',
    '...HBBLLLLMMLLLLLLMMLLLGGGBSS...',
    '...HBBLLLLMMMLLLLMMMLLGLGBGSS...',
    '...HBBLLLLMMMMLLMMMMLLLLBBBSS...',
    '...HBBLLLLMMLMMMMLMMLLLLBBBSS...',
    '...HBBLLLLMMLLMMLLMMLLLLBBBSS...',
    '...HBBLLLLMMLLLLLLMMLLLLBBBSS...',
    '...HBBLLLLMMLLLLLLMMLLLLBBBSS...',
    '...HBBLLLLLLLLLLLLLLLLLLBBBSS...',
    '...HBBBLLLLLLLLLLLLLLLLBBBBSS...',
    '....BBBBBBBBBBBBBBBBBBBBBBSSS...',
    '.....BBBBBBBBBBBBBBBBBBBBSSSS...',
    '......SSSSSSSSSSSSSSSSSSSSSS....',
    '.......SSSSSSSSSSSSSSSSSSSS.....',
    '.......CCCCCCCCCCCCCCCC.........',
    '.......CGGCCGGCCGGCCGGC.........',
    '.......CGGCCGGCCGGCCGGC.........',
    '.......CGGCCGGCCGGCCGGC.........',
    '.......CGGCCGGCCGGCCGGC.........',
    '........CCCCCCCCCCCCCC..........',
    '................................',
    '................................'
  ]
}

/** A pixel-exact icon from the hand-placed maps (16 or 32 px). */
function traySvg(size) {
  const rows = TRAY[size]
  if (!rows) throw new Error(`no pixel map for ${size} px`)
  let body = ''
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      let end = x
      while (row[end + 1] === row[x]) end++
      const fill = PIXELS[row[x]]
      if (fill) body += `<rect x="${x}" y="${y}" width="${end - x + 1}" height="1" fill="${fill}"/>`
      x = end + 1
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">${body}</svg>`
}

module.exports = { COLORS, markSvg, traySvg }
