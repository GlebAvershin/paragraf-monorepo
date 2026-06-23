/**
 * Метаданные-заглушки. Рендерер дёргает их на старте (config/provider/project/command/
 * agent/path) + «программистские» группы (mcp/lsp/vcs/file/pty/tui), которые в нашем
 * продукте скрыты → возвращаем пустые/дефолтные формы, чтобы рендерер загрузился.
 *
 * Формы сверены против контракта SDK (types.gen.ts) живым рендерером в Фазе 2.
 */
import { Hono } from "hono"
import { requireSession, type Session as Auth } from "./auth.ts"
import { providerList } from "./providers.ts"

type Env = { Variables: { session: Auth; token: string } }

const DEFAULT_PROJECT = { id: "default", worktree: "/", vcs: undefined, time: { created: 0 } }

// Единственный primary-агент: рендерер выбирает агента по умолчанию = list()[0]
// (context/local.tsx). Без него композер блокирует отправку («Выберите агента и
// модель»). Сценарии/инструменты у нас на клиенте — агенту достаточно быть primary.
const DEFAULT_AGENT = {
  name: "build",
  description: "Ассистент",
  mode: "primary" as const,
  native: true,
  permission: [],
  options: {},
}

export const meta = new Hono<Env>()
meta.use("*", requireSession)

// Конфиг приложения — рендерер мёржит с дефолтами. Пустой объект безопасен.
meta.get("/config", (c) => c.json({}))

// Провайдеры/модели: на вебе их диктует движок (на desktop — глобальный
// opencode.jsonc + models.dev). Форма — {all, default, connected} (см. providers.ts).
meta.get("/config/providers", (c) => c.json(providerList()))
meta.get("/provider", (c) => c.json(providerList()))

// «Проект» у нас вестигиален (чат, не папка). Один фиктивный проект.
meta.get("/project", (c) => c.json([DEFAULT_PROJECT]))
meta.get("/project/current", (c) => c.json(DEFAULT_PROJECT))
// PATCH метаданных проекта (иконка/имя): файловых проектов нет — эхо-ответ,
// чтобы layout-эффект иконок не получал 404.
meta.patch("/project/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json({ ...DEFAULT_PROJECT, id: c.req.param("id"), name: body?.name, icon: body?.icon })
})

// Пути (desktop отдаёт реальные; в вебе — фиктивные, файловых операций нет).
meta.get("/path", (c) => c.json({ state: "/", config: "/", worktree: "/", directory: "/", data: "/" }))

// Команды — пусто. Агенты — один primary (см. DEFAULT_AGENT). bootstrap дёргает
// /app/agents (sdk.app.agents); /agent оставляем для совместимости.
meta.get("/command", (c) => c.json([]))
meta.get("/agent", (c) => c.json([DEFAULT_AGENT]))
meta.get("/app/agents", (c) => c.json([DEFAULT_AGENT]))

// Статусы сессий: рендерер опрашивает /session/status (карта sessionID→status).
// ВАЖНО: статический путь, иначе /session/:id в index.ts перехватит "status" как id.
// meta смонтирован раньше session-роутов → статика выигрывает у параметра.
meta.get("/session/status", (c) => c.json({}))

// Скрытые «программистские» группы → пустые ответы.
meta.get("/mcp", (c) => c.json({}))
meta.get("/lsp", (c) => c.json({}))
meta.get("/vcs", (c) => c.json({}))
meta.get("/question", (c) => c.json([]))
meta.get("/permission", (c) => c.json([]))
