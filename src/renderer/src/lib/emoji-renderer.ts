import {
  DEFAULT_EMOJI_RENDER_SETTINGS,
  type EmojiRenderSettings,
  type EmojiStyle,
  type EmotionId
} from '../../../shared/types'
import type { EmojiSpec } from './text-analysis'

interface Palette {
  background: string
  secondary: string
  face: string
  ink: string
  paper: string
  accent: string
}

const PALETTES: Record<EmojiStyle, Palette> = {
  classic: {
    background: '#fff1b8',
    secondary: '#f5c84b',
    face: '#ffd84f',
    ink: '#29271f',
    paper: '#fffdf6',
    accent: '#ed6a5a'
  },
  cute: {
    background: '#ffe8ec',
    secondary: '#f6a6b4',
    face: '#ffd968',
    ink: '#35282c',
    paper: '#fffaf9',
    accent: '#e85d83'
  },
  deadpan: {
    background: '#e8e6df',
    secondary: '#9b9a92',
    face: '#f2ce58',
    ink: '#34332f',
    paper: '#fbfaf6',
    accent: '#6f7d80'
  },
  office: {
    background: '#dfeee6',
    secondary: '#6ea98b',
    face: '#f5cf54',
    ink: '#27302b',
    paper: '#fbfdfb',
    accent: '#4f7895'
  },
  sarcastic: {
    background: '#e7eee1',
    secondary: '#8ba679',
    face: '#f6d052',
    ink: '#302c27',
    paper: '#fffdf5',
    accent: '#8d5b9f'
  },
  spectator: {
    background: '#fff0d8',
    secondary: '#e89559',
    face: '#ffd454',
    ink: '#302921',
    paper: '#fffaf2',
    accent: '#4e9868'
  },
  chaos: {
    background: '#2b2925',
    secondary: '#ef745f',
    face: '#f6c943',
    ink: '#241f1c',
    paper: '#fff6db',
    accent: '#ef5c4b'
  }
}

class Random {
  private value: number

  constructor(seed: number) {
    this.value = seed || 1
  }

  next(): number {
    this.value ^= this.value << 13
    this.value ^= this.value >>> 17
    this.value ^= this.value << 5
    return (this.value >>> 0) / 4294967296
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next()
  }

  pick<T>(values: T[]): T {
    return values[Math.floor(this.next() * values.length)]
  }
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function line(
  context: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  color: string,
  width: number
): void {
  context.beginPath()
  context.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) context.lineTo(x, y)
  context.strokeStyle = color
  context.lineWidth = width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.stroke()
}

function drawSparkle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  line(context, [[x, y - size], [x, y + size]], color, Math.max(5, size * 0.22))
  line(context, [[x - size, y], [x + size, y]], color, Math.max(5, size * 0.22))
}

function drawWatermelon(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  ink: string
): void {
  context.save()
  context.translate(x, y)
  context.rotate(-0.18)
  context.scale(scale, scale)
  context.beginPath()
  context.moveTo(-42, 17)
  context.quadraticCurveTo(0, -48, 42, 17)
  context.closePath()
  context.fillStyle = '#ed6a67'
  context.fill()
  context.strokeStyle = ink
  context.lineWidth = 7
  context.lineJoin = 'round'
  context.stroke()
  line(context, [[-39, 14], [39, 14]], '#4f9c66', 12)
  line(context, [[-38, 10], [38, 10]], '#d8efb0', 5)
  for (const [seedX, seedY] of [[-17, -2], [0, -14], [18, -1]] as const) {
    context.beginPath()
    context.ellipse(seedX, seedY, 3.5, 7, -0.15, 0, Math.PI * 2)
    context.fillStyle = ink
    context.fill()
  }
  context.restore()
}

function drawBackground(
  context: CanvasRenderingContext2D,
  palette: Palette,
  style: EmojiStyle,
  random: Random
): void {
  context.fillStyle = palette.background
  context.fillRect(0, 0, 640, 640)

  context.globalAlpha = style === 'chaos' ? 0.9 : 0.55
  for (let index = 0; index < 12; index += 1) {
    const x = random.between(24, 616)
    const y = random.between(24, 450)
    const size = random.between(5, 15)
    context.fillStyle = index % 3 === 0 ? palette.accent : palette.secondary
    if (index % 2 === 0) {
      context.beginPath()
      context.arc(x, y, size, 0, Math.PI * 2)
      context.fill()
    } else {
      context.save()
      context.translate(x, y)
      context.rotate(random.between(-0.7, 0.7))
      context.fillRect(-size, -3, size * 2, 6)
      context.restore()
    }
  }
  context.globalAlpha = 1

  if (style === 'chaos') {
    for (let index = 0; index < 5; index += 1) {
      const y = 55 + index * 72 + random.between(-10, 10)
      line(context, [[20, y], [76, y - 25], [116, y + 12]], palette.accent, 9)
    }
  }
}

function drawFaceBase(
  context: CanvasRenderingContext2D,
  palette: Palette,
  style: EmojiStyle,
  random: Random
): { centerX: number; centerY: number; radius: number } {
  const centerX = 320 + random.between(-12, 12)
  const centerY = 270 + random.between(-8, 8)
  const radius = style === 'cute' ? 172 : random.between(163, 177)

  context.save()
  context.translate(centerX, centerY)
  context.rotate(random.between(-0.035, 0.035))
  context.beginPath()
  context.arc(0, 0, radius, 0, Math.PI * 2)
  context.fillStyle = palette.face
  context.fill()
  context.strokeStyle = palette.ink
  context.lineWidth = 15
  context.stroke()

  context.globalAlpha = 0.25
  context.beginPath()
  context.ellipse(-55, -78, 53, 25, -0.5, 0, Math.PI * 2)
  context.fillStyle = '#ffffff'
  context.fill()
  context.restore()

  return { centerX, centerY, radius }
}

function eye(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  ink: string
): void {
  context.beginPath()
  context.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2)
  context.fillStyle = ink
  context.fill()
}

function drawSpiralEye(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  ink: string
): void {
  context.beginPath()
  for (let angle = 0; angle < Math.PI * 4; angle += 0.2) {
    const radius = angle * 2
    const pointX = x + Math.cos(angle) * radius
    const pointY = y + Math.sin(angle) * radius
    if (angle === 0) context.moveTo(pointX, pointY)
    else context.lineTo(pointX, pointY)
  }
  context.strokeStyle = ink
  context.lineWidth = 8
  context.lineCap = 'round'
  context.stroke()
}

function drawExpression(
  context: CanvasRenderingContext2D,
  emotion: EmotionId,
  palette: Palette,
  centerX: number,
  centerY: number,
  random: Random
): void {
  const leftX = centerX - 63
  const rightX = centerX + 63
  const eyeY = centerY - 30
  const mouthY = centerY + 70
  context.strokeStyle = palette.ink
  context.fillStyle = palette.ink
  context.lineWidth = 12
  context.lineCap = 'round'
  context.lineJoin = 'round'

  if (emotion === 'happy') {
    context.beginPath()
    context.arc(leftX, eyeY + 8, 29, Math.PI * 1.1, Math.PI * 1.9)
    context.stroke()
    context.beginPath()
    context.arc(rightX, eyeY + 8, 29, Math.PI * 1.1, Math.PI * 1.9)
    context.stroke()
    context.beginPath()
    context.arc(centerX, mouthY - 18, 65, 0.08, Math.PI - 0.08)
    context.quadraticCurveTo(centerX, mouthY + 87, centerX - 65, mouthY - 12)
    context.fill()
    context.fillStyle = '#ef7567'
    context.beginPath()
    context.ellipse(centerX, mouthY + 41, 37, 18, 0, 0, Math.PI)
    context.fill()
  } else if (emotion === 'sad') {
    line(context, [[leftX - 27, eyeY - 27], [leftX + 23, eyeY - 42]], palette.ink, 11)
    line(context, [[rightX - 23, eyeY - 42], [rightX + 27, eyeY - 27]], palette.ink, 11)
    eye(context, leftX, eyeY, 13, 19, palette.ink)
    eye(context, rightX, eyeY, 13, 19, palette.ink)
    context.beginPath()
    context.arc(centerX, mouthY + 35, 54, Math.PI * 1.15, Math.PI * 1.85)
    context.stroke()
    context.fillStyle = '#6fadd0'
    context.beginPath()
    context.moveTo(leftX - 8, eyeY + 20)
    context.quadraticCurveTo(leftX - 31, eyeY + 68, leftX, eyeY + 79)
    context.quadraticCurveTo(leftX + 25, eyeY + 63, leftX - 8, eyeY + 20)
    context.fill()
  } else if (emotion === 'angry') {
    line(context, [[leftX - 34, eyeY - 45], [leftX + 28, eyeY - 20]], palette.ink, 13)
    line(context, [[rightX - 28, eyeY - 20], [rightX + 34, eyeY - 45]], palette.ink, 13)
    eye(context, leftX, eyeY, 12, 16, palette.ink)
    eye(context, rightX, eyeY, 12, 16, palette.ink)
    context.beginPath()
    context.arc(centerX, mouthY + 36, 57, Math.PI * 1.17, Math.PI * 1.83)
    context.stroke()
    line(context, [[centerX - 142, centerY - 78], [centerX - 183, centerY - 106]], palette.accent, 10)
    line(context, [[centerX + 142, centerY - 78], [centerX + 183, centerY - 106]], palette.accent, 10)
  } else if (emotion === 'speechless') {
    eye(context, leftX, eyeY, 12, 16, palette.ink)
    eye(context, rightX, eyeY, 12, 16, palette.ink)
    line(context, [[centerX - 48, mouthY], [centerX + 48, mouthY]], palette.ink, 12)
    for (let index = 0; index < 3; index += 1) {
      eye(context, centerX + 112 + index * 22, centerY + 12, 5, 5, palette.ink)
    }
  } else if (emotion === 'tired') {
    line(context, [[leftX - 31, eyeY], [leftX + 31, eyeY + 4]], palette.ink, 11)
    line(context, [[rightX - 31, eyeY + 4], [rightX + 31, eyeY]], palette.ink, 11)
    context.globalAlpha = 0.32
    line(context, [[leftX - 28, eyeY + 24], [leftX + 26, eyeY + 29]], palette.ink, 7)
    line(context, [[rightX - 26, eyeY + 29], [rightX + 28, eyeY + 24]], palette.ink, 7)
    context.globalAlpha = 1
    context.beginPath()
    context.ellipse(centerX, mouthY + 3, 31, 23, 0, 0, Math.PI * 2)
    context.fill()
  } else if (emotion === 'surprised') {
    context.fillStyle = '#fffdf6'
    context.beginPath()
    context.ellipse(leftX, eyeY, 30, 40, 0, 0, Math.PI * 2)
    context.ellipse(rightX, eyeY, 30, 40, 0, 0, Math.PI * 2)
    context.fill()
    eye(context, leftX + random.between(-4, 4), eyeY, 13, 20, palette.ink)
    eye(context, rightX + random.between(-4, 4), eyeY, 13, 20, palette.ink)
    context.fillStyle = palette.ink
    context.beginPath()
    context.ellipse(centerX, mouthY + 5, 36, 48, 0, 0, Math.PI * 2)
    context.fill()
  } else if (emotion === 'awkward') {
    eye(context, leftX, eyeY, 12, 15, palette.ink)
    eye(context, rightX, eyeY + 8, 16, 20, palette.ink)
    line(
      context,
      [[centerX - 52, mouthY + 8], [centerX - 15, mouthY - 3], [centerX + 19, mouthY + 10], [centerX + 52, mouthY]],
      palette.ink,
      11
    )
    context.fillStyle = '#64a9ca'
    context.beginPath()
    context.moveTo(centerX + 128, centerY - 82)
    context.quadraticCurveTo(centerX + 161, centerY - 32, centerX + 118, centerY - 17)
    context.quadraticCurveTo(centerX + 91, centerY - 41, centerX + 128, centerY - 82)
    context.fill()
  } else if (emotion === 'smug') {
    line(context, [[leftX - 30, eyeY - 24], [leftX + 30, eyeY - 32]], palette.ink, 11)
    line(context, [[rightX - 28, eyeY - 31], [rightX + 30, eyeY - 18]], palette.ink, 11)
    eye(context, leftX, eyeY, 12, 17, palette.ink)
    context.beginPath()
    context.arc(rightX, eyeY + 8, 28, Math.PI * 1.08, Math.PI * 1.92)
    context.stroke()
    context.beginPath()
    context.moveTo(centerX - 50, mouthY)
    context.quadraticCurveTo(centerX + 18, mouthY + 38, centerX + 67, mouthY - 19)
    context.stroke()
  } else {
    drawSpiralEye(context, leftX, eyeY, palette.ink)
    drawSpiralEye(context, rightX, eyeY, palette.ink)
    context.beginPath()
    context.moveTo(centerX - 65, mouthY - 11)
    context.quadraticCurveTo(centerX, mouthY + 83, centerX + 65, mouthY - 11)
    context.closePath()
    context.fill()
    context.strokeStyle = '#fffdf6'
    context.lineWidth = 7
    for (let index = -2; index <= 2; index += 1) {
      line(context, [[centerX + index * 22, mouthY + 1], [centerX + index * 19, mouthY + 27]], '#fffdf6', 5)
    }
  }
}

function drawStyleDetails(
  context: CanvasRenderingContext2D,
  style: EmojiStyle,
  palette: Palette,
  centerX: number,
  centerY: number,
  random: Random,
  embedCaption = true
): void {
  if (style === 'cute') {
    context.globalAlpha = 0.55
    context.fillStyle = '#ef7190'
    context.beginPath()
    context.ellipse(centerX - 112, centerY + 43, 28, 15, -0.2, 0, Math.PI * 2)
    context.ellipse(centerX + 112, centerY + 43, 28, 15, 0.2, 0, Math.PI * 2)
    context.fill()
    context.globalAlpha = 1
    for (const side of [-1, 1]) {
      const x = centerX + side * 184
      const y = centerY - 87 + random.between(-10, 10)
      context.fillStyle = palette.accent
      context.beginPath()
      context.arc(x - 9, y, 11, 0, Math.PI * 2)
      context.arc(x + 9, y, 11, 0, Math.PI * 2)
      context.lineTo(x, y + 27)
      context.closePath()
      context.fill()
    }
  }

  if (style === 'deadpan') {
    context.save()
    context.globalAlpha = 0.24
    context.fillStyle = palette.accent
    context.beginPath()
    context.ellipse(centerX - 63, centerY + 3, 39, 16, 0.08, 0, Math.PI * 2)
    context.ellipse(centerX + 63, centerY + 3, 39, 16, -0.08, 0, Math.PI * 2)
    context.fill()
    context.restore()
    line(context, [[centerX - 92, centerY - 82], [centerX - 37, centerY - 79]], palette.ink, 8)
    line(context, [[centerX + 37, centerY - 79], [centerX + 92, centerY - 82]], palette.ink, 8)
  }

  if (style === 'office') {
    roundedRect(context, centerX - 118, centerY + 140, 236, 86, 10)
    context.fillStyle = '#6688a0'
    context.fill()
    context.strokeStyle = palette.ink
    context.lineWidth = 12
    context.stroke()
    roundedRect(context, centerX - 96, centerY + 158, 192, 41, 5)
    context.fillStyle = '#d9e8ef'
    context.fill()
    if (embedCaption) {
      context.fillStyle = palette.ink
      context.font = '700 19px "Microsoft YaHei", sans-serif'
      context.textAlign = 'center'
      context.fillText('今天也要努力工作', centerX, centerY + 186)
    }
  }

  if (style === 'sarcastic') {
    line(context, [[centerX - 98, centerY - 88], [centerX - 38, centerY - 103]], palette.ink, 9)
    line(context, [[centerX + 39, centerY - 83], [centerX + 94, centerY - 78]], palette.ink, 8)
    drawSparkle(context, centerX + 176, centerY - 112, 22, palette.accent)
    drawSparkle(context, centerX + 205, centerY - 76, 10, palette.secondary)
  }

  if (style === 'spectator') {
    drawWatermelon(context, centerX + 148, centerY + 127, 0.92, palette.ink)
    drawSparkle(context, centerX - 182, centerY - 92, 14, palette.accent)
  }

  if (style === 'chaos') {
    context.strokeStyle = palette.accent
    context.lineWidth = 9
    for (let index = 0; index < 8; index += 1) {
      const angle = (Math.PI * 2 * index) / 8 + random.between(-0.12, 0.12)
      const inner = 188
      const outer = 223 + random.between(-8, 12)
      line(
        context,
        [
          [centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner],
          [centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer]
        ],
        palette.accent,
        9
      )
    }
  }
}

function drawCompactStyleDetails(
  context: CanvasRenderingContext2D,
  style: EmojiStyle,
  palette: Palette,
  centerX: number,
  centerY: number,
  random: Random
): void {
  if (style === 'cute') {
    context.save()
    context.globalAlpha = 0.58
    context.fillStyle = '#ef7190'
    context.beginPath()
    context.ellipse(centerX - 112, centerY + 43, 28, 15, -0.2, 0, Math.PI * 2)
    context.ellipse(centerX + 112, centerY + 43, 28, 15, 0.2, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }

  if (style === 'deadpan') {
    context.save()
    context.globalAlpha = 0.22
    context.fillStyle = palette.accent
    context.beginPath()
    context.ellipse(centerX - 63, centerY + 3, 38, 15, 0.08, 0, Math.PI * 2)
    context.ellipse(centerX + 63, centerY + 3, 38, 15, -0.08, 0, Math.PI * 2)
    context.fill()
    context.restore()
    line(context, [[centerX - 90, centerY - 80], [centerX - 38, centerY - 78]], palette.ink, 7)
    line(context, [[centerX + 38, centerY - 78], [centerX + 90, centerY - 80]], palette.ink, 7)
  }

  if (style === 'office') {
    context.save()
    context.globalAlpha = 0.2
    context.fillStyle = '#587e9c'
    context.beginPath()
    context.ellipse(centerX - 63, centerY + 2, 38, 15, 0.08, 0, Math.PI * 2)
    context.ellipse(centerX + 63, centerY + 2, 38, 15, -0.08, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }

  if (style === 'sarcastic') {
    line(context, [[centerX - 96, centerY - 87], [centerX - 39, centerY - 100]], palette.ink, 8)
    line(context, [[centerX + 40, centerY - 82], [centerX + 92, centerY - 77]], palette.ink, 7)
    drawSparkle(context, centerX + 166, centerY - 103, 18, palette.accent)
  }

  if (style === 'spectator') {
    drawWatermelon(context, centerX + 132, centerY + 125, 0.72, palette.ink)
    drawSparkle(context, centerX - 168, centerY - 92, 12, palette.accent)
  }

  if (style === 'chaos') {
    context.strokeStyle = palette.accent
    context.lineWidth = 9
    for (let index = 0; index < 8; index += 1) {
      const angle = (Math.PI * 2 * index) / 8 + random.between(-0.1, 0.1)
      const inner = 182
      const outer = 204 + random.between(-5, 7)
      line(
        context,
        [
          [centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner],
          [centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer]
        ],
        palette.accent,
        9
      )
    }
  }
}

function splitCaption(
  context: CanvasRenderingContext2D,
  caption: string,
  maxWidth: number
): string[] {
  const lines: string[] = []
  let current = ''
  for (const character of caption) {
    const next = current + character
    if (context.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = character
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 2)
}

function drawCaption(
  context: CanvasRenderingContext2D,
  caption: string,
  palette: Palette,
  style: EmojiStyle
): void {
  roundedRect(context, 48, 478, 544, 124, 26)
  context.fillStyle = palette.paper
  context.fill()
  context.strokeStyle = style === 'chaos' ? palette.accent : palette.ink
  context.lineWidth = 10
  context.stroke()

  let fontSize = caption.length > 14 ? 40 : caption.length > 9 ? 45 : 51
  context.font = `900 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
  let lines = splitCaption(context, caption, 480)
  while (lines.length > 2 && fontSize > 32) {
    fontSize -= 2
    context.font = `900 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
    lines = splitCaption(context, caption, 480)
  }
  context.fillStyle = palette.ink
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const lineHeight = fontSize * 1.08
  const startY = 540 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((value, index) => context.fillText(value, 320, startY + index * lineHeight))
}

function drawFaceArtwork(
  context: CanvasRenderingContext2D,
  spec: EmojiSpec,
  palette: Palette,
  random: Random,
  compact = false,
  embedCaption = true
): void {
  const face = drawFaceBase(context, palette, spec.style, random)
  if (compact) {
    drawCompactStyleDetails(context, spec.style, palette, face.centerX, face.centerY, random)
  } else {
    drawStyleDetails(
      context,
      spec.style,
      palette,
      face.centerX,
      face.centerY,
      random,
      embedCaption
    )
  }
  drawExpression(context, spec.emotion, palette, face.centerX, face.centerY, random)
}

function truncateCaption(value: string, maximumLength: number): string {
  const characters = [...value.trim()]
  return characters.length > maximumLength
    ? `${characters.slice(0, maximumLength - 1).join('')}…`
    : characters.join('')
}

function drawCompactCaption(
  context: CanvasRenderingContext2D,
  caption: string,
  palette: Palette
): void {
  const value = truncateCaption(caption, 14)
  if (!value) return
  let fontSize = value.length > 10 ? 21 : value.length > 6 ? 24 : 28
  context.font = `900 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
  let lines = splitCaption(context, value, 224)
  while (lines.length > 2 && fontSize > 18) {
    fontSize -= 1
    context.font = `900 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`
    lines = splitCaption(context, value, 224)
  }
  lines = lines.slice(0, 2)
  const lineHeight = fontSize * 1.08
  const startY = 225 - ((lines.length - 1) * lineHeight) / 2
  context.save()
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  context.miterLimit = 2
  context.strokeStyle = '#fffdf8'
  context.lineWidth = 6
  context.fillStyle = palette.ink
  lines.forEach((lineValue, index) => {
    const y = startY + index * lineHeight
    context.strokeText(lineValue, 128, y, 232)
    context.fillText(lineValue, 128, y, 232)
  })
  context.restore()
}

function renderPosterEmoji(spec: EmojiSpec, embedCaption: boolean): string {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 640
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前环境不支持 Canvas 2D')

  const palette = PALETTES[spec.style]
  const random = new Random(spec.seed)
  drawBackground(context, palette, spec.style, random)
  if (embedCaption) {
    drawFaceArtwork(context, spec, palette, random)
    drawCaption(context, spec.caption, palette, spec.style)
  } else {
    context.save()
    context.translate(320, 320)
    context.scale(1.18, 1.18)
    context.translate(-320, -270)
    drawFaceArtwork(context, spec, palette, random, false, false)
    context.restore()
  }

  return canvas.toDataURL('image/png')
}

function renderCompactEmoji(spec: EmojiSpec, embedCaption: boolean): string {
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = 640
  sourceCanvas.height = 640
  const sourceContext = sourceCanvas.getContext('2d')
  if (!sourceContext) throw new Error('当前环境不支持 Canvas 2D')

  const palette = PALETTES[spec.style]
  drawFaceArtwork(sourceContext, spec, palette, new Random(spec.seed), true)

  const compositionCanvas = document.createElement('canvas')
  compositionCanvas.width = 256
  compositionCanvas.height = 256
  const context = compositionCanvas.getContext('2d')
  if (!context) throw new Error('当前环境不支持 Canvas 2D')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  if (embedCaption) {
    context.drawImage(sourceCanvas, 95, 45, 450, 450, 32, 2, 192, 192)
    drawCompactCaption(context, spec.caption, palette)
  } else {
    context.drawImage(sourceCanvas, 95, 45, 450, 450, 8, 8, 240, 240)
  }

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = 128
  outputCanvas.height = 128
  const outputContext = outputCanvas.getContext('2d')
  if (!outputContext) throw new Error('当前环境不支持 Canvas 2D')
  outputContext.imageSmoothingEnabled = true
  outputContext.imageSmoothingQuality = 'high'
  outputContext.drawImage(compositionCanvas, 0, 0, 128, 128)
  return outputCanvas.toDataURL('image/png')
}

export function renderEmoji(
  spec: EmojiSpec,
  settings: EmojiRenderSettings = DEFAULT_EMOJI_RENDER_SETTINGS
): string {
  return settings.layout === 'poster'
    ? renderPosterEmoji(spec, settings.embedCaption)
    : renderCompactEmoji(spec, settings.embedCaption)
}
