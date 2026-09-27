// Serialise a laid-out ecosystem map page into a standalone SVG.
//
// The HTML page stays the layout engine: flexbox wraps the sections and the
// A4 page fits itself to the sheet. Once the browser has laid it out,
// serialiseMap() runs inside the page and redraws every box, ring, icon and
// line of text as native SVG at the position the browser gave it: rects,
// circles, <text> with the page's fonts embedded, and each icon's own vector
// inlined. No <foreignObject>, so the file renders anywhere SVG does.
//
// It is passed to page.evaluate(), so it must not reference anything outside
// its own body.

export function serialiseMap({ fontFaces }) {
  const map = document.querySelector('.map')
  const origin = map.getBoundingClientRect()
  const W = origin.width
  const H = origin.height
  const out = []
  const defs = []
  let ids = 0

  const n = (v) => +v.toFixed(2)
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
  }

  // Computed colours come back as rgb(), rgba() or, from color-mix(),
  // color(srgb r g b / a). SVG wants a plain colour and a separate opacity.
  function colour(css) {
    let parts
    let m = css.match(/^rgba?\((.+)\)$/)
    if (m) parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    else if ((m = css.match(/^color\(srgb (.+)\)$/))) {
      parts = m[1].split(/[\s/]+/).filter(Boolean).map(Number)
      parts = [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts[3]]
    } else if (css === 'transparent') return { hex: '#000000', a: 0 }
    else throw new Error(`map-svg: cannot read colour "${css}"`)
    const hex = '#' + parts.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
    return { hex, a: parts[3] ?? 1 }
  }
  const paint = (attr, css) => {
    const { hex, a } = colour(css)
    return `${attr}="${hex}"${a < 1 ? ` ${attr}-opacity="${n(a)}"` : ''}`
  }
  const visible = (css) => colour(css).a > 0

  function radius(el, b) {
    const r = getComputedStyle(el).borderTopLeftRadius
    const v = r.endsWith('%') ? (parseFloat(r) / 100) * Math.min(b.w, b.h) : parseFloat(r) || 0
    return Math.min(v, b.w / 2, b.h / 2)
  }

  // Background, border and outline of an element's box.
  function drawBox(el) {
    const cs = getComputedStyle(el)
    const b = box(el)
    const r = radius(el, b)
    if (visible(cs.backgroundColor))
      out.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(r)}" ${paint('fill', cs.backgroundColor)}/>`)
    if (cs.backgroundImage.startsWith('radial-gradient')) drawGradientDisc(el, b, cs)
    const bw = parseFloat(cs.borderTopWidth)
    if (bw && cs.borderTopStyle !== 'none' && visible(cs.borderTopColor))
      out.push(
        `<rect x="${n(b.x + bw / 2)}" y="${n(b.y + bw / 2)}" width="${n(b.w - bw)}" height="${n(b.h - bw)}" rx="${n(Math.max(r - bw / 2, 0))}" fill="none" ${paint('stroke', cs.borderTopColor)} stroke-width="${n(bw)}"/>`,
      )
    const ow = parseFloat(cs.outlineWidth)
    if (ow && cs.outlineStyle !== 'none' && visible(cs.outlineColor)) drawOutline(b, r, cs, ow)
  }

  // Outlines here only ever ring circles (the tile icons and legend keys).
  // Dashes and dots are spaced so a whole number of them closes the ring.
  function drawOutline(b, r, cs, ow) {
    const off = parseFloat(cs.outlineOffset) || 0
    const rr = b.w / 2 + off + ow / 2
    const c = 2 * Math.PI * rr
    let dash = ''
    if (cs.outlineStyle === 'dashed') {
      const seg = c / Math.max(4, Math.round(c / (ow * 3.5)))
      dash = ` stroke-dasharray="${n(seg * 0.6)} ${n(seg * 0.4)}"`
    } else if (cs.outlineStyle === 'dotted') {
      const seg = c / Math.max(4, Math.round(c / (ow * 2)))
      dash = ` stroke-dasharray="0 ${n(seg)}" stroke-linecap="round"`
    }
    if (r < b.w / 2 - 0.5) throw new Error('map-svg: outlines are only drawn on circles')
    out.push(
      `<circle cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" r="${n(rr)}" fill="none" ${paint('stroke', cs.outlineColor)} stroke-width="${n(ow)}"${dash}/>`,
    )
  }

  // The monogram disc: a two-stop radial gradient lit from the top left.
  function drawGradientDisc(el, b, cs) {
    const stops = [...cs.backgroundImage.matchAll(/(rgba?\([^)]*\)|color\(srgb[^)]*\))/g)].map((m) => m[1])
    if (stops.length < 2) return
    const id = `g${ids++}`
    defs.push(
      `<radialGradient id="${id}" cx="0.3" cy="0.25" r="0.9"><stop offset="0" ${paint('stop-color', stops[0]).replace('stop-color-opacity', 'stop-opacity')}/><stop offset="1" ${paint('stop-color', stops[1]).replace('stop-color-opacity', 'stop-opacity')}/></radialGradient>`,
    )
    out.push(`<circle cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" r="${n(b.w / 2)}" fill="url(#${id})"/>`)
  }

  // Distance from the top of a line box's content area to the baseline, as a
  // fraction of font size, measured once per font.
  const ascents = new Map()
  function ascent(cs) {
    const key = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontVariationSettings}`
    if (ascents.has(key)) return ascents.get(key)
    const probe = document.createElement('div')
    probe.style.cssText = `position:absolute;left:-9999px;top:0;white-space:nowrap;line-height:normal;font-size:100px;font-family:${cs.fontFamily};font-weight:${cs.fontWeight};font-variation-settings:${cs.fontVariationSettings}`
    probe.innerHTML = 'Hg<span style="display:inline-block;width:0;height:0"></span>'
    document.body.append(probe)
    const range = document.createRange()
    range.selectNodeContents(probe.firstChild)
    const a = (probe.lastChild.getBoundingClientRect().bottom - range.getBoundingClientRect().top) / 100
    probe.remove()
    ascents.set(key, a)
    return a
  }

  // One <text> per rendered line of a text node, found by grouping its words
  // by the line box the browser put them on.
  function drawText(node) {
    const el = node.parentElement
    const cs = getComputedStyle(el)
    const data = node.data
    const range = document.createRange()
    const lines = []
    for (const m of data.matchAll(/\S+/g)) {
      range.setStart(node, m.index)
      range.setEnd(node, m.index + m[0].length)
      const rect = range.getClientRects()[0]
      if (!rect) continue
      const line = lines.at(-1)
      if (line && Math.abs(line.top - rect.top) < 1) line.words.push(m[0])
      else lines.push({ top: rect.top, left: rect.left, words: [m[0]] })
    }
    const size = parseFloat(cs.fontSize)
    const upper = cs.textTransform === 'uppercase'
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing)
    const fvs = cs.fontVariationSettings === 'normal' ? '' : ` style="font-variation-settings:${esc(cs.fontVariationSettings)}"`
    for (const line of lines) {
      const text = line.words.join(' ')
      out.push(
        `<text x="${n(line.left - origin.left)}" y="${n(line.top - origin.top + ascent(cs) * size)}" font-family="${esc(cs.fontFamily)}" font-size="${n(size)}" font-weight="${cs.fontWeight}"${ls ? ` letter-spacing="${n(ls)}"` : ''} ${paint('fill', cs.color)}${fvs}>${esc(upper ? text.toUpperCase() : text)}</text>`,
      )
    }
  }

  // Give an inlined SVG's ids a unique prefix so icons cannot collide.
  function scopeIds(svg) {
    const prefix = `i${ids++}-`
    return svg.replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`).replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`)
  }

  // Nest an SVG (inline in the page, or an icon file) at the box it occupies.
  function nestSvg(source, b, extra = '') {
    const clean = source.replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '').trim()
    const place = `x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}"`
    out.push(
      scopeIds(
        clean.replace(/<svg\b[^>]*>/, (tag) => {
          const kept = tag.replace(/\s(class|width|height|x|y|aria-[a-z]+|role|style)="[^"]*"/g, '')
          return kept.replace('<svg', `<svg ${place}${extra}`)
        }),
      ),
    )
  }

  function drawSvg(el) {
    const clone = el.cloneNode(true)
    // Shapes styled by the page's stylesheet (the medal) carry their colours
    // over as attributes.
    const src = [el, ...el.querySelectorAll('*')]
    const dst = [clone, ...clone.querySelectorAll('*')]
    src.forEach((s, i) => {
      if (s.tagName === 'svg' || s.hasAttribute('fill')) return
      const cs = getComputedStyle(s)
      dst[i].setAttribute('fill', cs.fill)
      if (cs.stroke !== 'none') {
        dst[i].setAttribute('stroke', cs.stroke)
        dst[i].setAttribute('stroke-width', cs.strokeWidth)
      }
    })
    nestSvg(clone.outerHTML, box(el), ` color="${colour(getComputedStyle(el).color).hex}"`)
  }

  function drawImg(el) {
    const b = box(el)
    const svg = el.src.match(/^data:image\/svg\+xml;base64,(.+)$/)
    if (svg) nestSvg(new TextDecoder().decode(Uint8Array.from(atob(svg[1]), (c) => c.charCodeAt(0))), b)
    else out.push(`<image x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" href="${el.src}"/>`)
  }

  // Paint in the page's order: an element's box, then its in-flow children,
  // then its absolutely positioned children (the section chips and medals),
  // which the browser paints on top.
  function walk(el) {
    if (el instanceof SVGSVGElement) return drawSvg(el)
    if (el.tagName === 'IMG') return drawImg(el)
    if (el !== map) drawBox(el)
    const later = []
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.data.trim()) drawText(child)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (getComputedStyle(child).position === 'absolute') later.push(child)
        else walk(child)
      }
    }
    later.forEach(walk)
  }

  // The page background, with the screen map's two soft glows.
  const bg = getComputedStyle(map).backgroundColor
  out.push(`<rect width="${n(W)}" height="${n(H)}" ${paint('fill', bg)}/>`)
  if (map.classList.contains('screen')) {
    const glow = (cx, cy, rx, ry, rgb, a) => {
      const id = `g${ids++}`
      defs.push(
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(cx)}" cy="${n(cy)}" r="${rx}" gradientTransform="translate(${n(cx)} ${n(cy)}) scale(1 ${n(ry / rx)}) translate(${n(-cx)} ${n(-cy)})"><stop offset="0" stop-color="${rgb}" stop-opacity="${a}"/><stop offset="0.6" stop-color="${rgb}" stop-opacity="0"/></radialGradient>`,
      )
      out.push(`<rect width="${n(W)}" height="${n(H)}" fill="url(#${id})"/>`)
    }
    glow(W * 0.15, H * -0.1, 1200, 600, '#e8a838', 0.14)
    glow(W, H, 900, 700, '#4a9eff', 0.1)
  }
  walk(map)

  const title = document.title
  const a4 = map.classList.contains('a4')
  const size = a4 ? 'width="210mm" height="297mm"' : `width="${n(W)}" height="${n(H)}"`
  return `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${n(W)} ${n(H)}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs>
<style>${fontFaces}</style>
${defs.join('\n')}
</defs>
${out.join('\n')}
</svg>
`
}
