// The shared step descriptions ask the preload bridge for the computer's system; in the terminal there
// is no bridge, so say it here (imported first by main.ts).
;(globalThis as { maris?: { platform: string } }).maris = { platform: process.platform }
