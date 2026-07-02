// OurApp: URL-слаг директории сессии. В апстриме opencode это реальный путь к
// проекту на диске (десктоп-агент работает с несколькими репозиториями) — base64
// был осмыслен. У нас же продукт веб-чат без понятия «рабочих директорий», и
// движок всегда создаёт сессии с directory="/" — единственное практическое
// значение, что реально появляется в URL. base64("/") = "Lw" — нечитаемый мусор
// в адресной строке (напр. isaac-ai.ru/Lw/session). Раз это всегда один и тот же
// корень, даём ему стабильный читаемый слаг вместо base64, не трогая механизм
// для гипотетических не-корневых directory (которых в проде не бывает, но код
// остаётся корректным, если появятся).
const ROOT_DIRECTORY = "/"
const ROOT_DIRECTORY_SLUG = "workspace"

export function base64Encode(value: string) {
  if (value === ROOT_DIRECTORY) return ROOT_DIRECTORY_SLUG
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function base64Decode(value: string) {
  if (value === ROOT_DIRECTORY_SLUG) return ROOT_DIRECTORY
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export async function hash(content: string, algorithm = "SHA-256"): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest(algorithm, data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  return hashHex
}

export function checksum(content: string): string | undefined {
  if (!content) return undefined
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function sampledChecksum(content: string, limit = 500_000): string | undefined {
  if (!content) return undefined
  if (content.length <= limit) return checksum(content)

  const size = 4096
  const points = [
    0,
    Math.floor(content.length * 0.25),
    Math.floor(content.length * 0.5),
    Math.floor(content.length * 0.75),
    content.length - size,
  ]
  const hashes = points
    .map((point) => {
      const start = Math.max(0, Math.min(content.length - size, point - Math.floor(size / 2)))
      return checksum(content.slice(start, start + size)) ?? ""
    })
    .join(":")
  return `${content.length}:${hashes}`
}
