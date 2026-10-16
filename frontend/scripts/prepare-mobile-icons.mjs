// Derive platform-sized PNG assets from the supplied master without redrawing it.
// Run manually when replacing the master; generated assets are committed.
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const master = readFileSync(
  new URL('../public/assets/roisey-else-app-v1.png', import.meta.url),
)
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
    : {}),
})
try {
  const page = await browser.newPage()
  for (const [size, path] of [
    [180, '../public/apple-touch-icon.png'],
    [167, '../public/assets/roisey-else-app-167-v2.png'],
    [152, '../public/assets/roisey-else-app-152-v2.png'],
    [192, '../public/assets/roisey-else-app-192-v2.png'],
    [512, '../public/assets/roisey-else-app-512-v2.png'],
  ]) {
    const encoded = await page.evaluate(
      async ({ source, size }) => {
        const image = new Image()
        image.src = `data:image/png;base64,${source}`
        await image.decode()
        if (image.naturalWidth !== 2048 || image.naturalHeight !== 2048)
          throw new Error('Unexpected master dimensions')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        const context = canvas.getContext('2d')
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(image, 0, 0, size, size)
        return canvas.toDataURL('image/png').split(',')[1]
      },
      { source: master.toString('base64'), size },
    )
    writeFileSync(
      new URL(path, import.meta.url),
      Buffer.from(encoded, 'base64'),
      { mode: 0o644 },
    )
    console.log(`Prepared ${size}×${size} mobile icon`)
  }
} finally {
  await browser.close()
}
