// Current public lab uses the shared cinematic player. Retain the immutable
// v1 fallback's historical qualification under its explicit --bundle option.
if (process.argv.includes('--bundle')) {
  await import('./media-lab-legacy-public-browser.mjs');
} else {
  if (!process.argv.includes('--url')) process.argv.push('--url', 'https://forgesworn.dev/media-lab.html');
  await import('./media-showcase-browser.mjs');
}
