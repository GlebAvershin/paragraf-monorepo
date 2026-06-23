/**
 * Метаданные-заглушки. Рендерер дёргает их на старте (config/provider/project/command/
 * agent/path) + «программистские» группы (mcp/lsp/vcs/file/pty/tui), которые в нашем
 * продукте скрыты → возвращаем пустые/дефолтные формы, чтобы рендерер загрузился.
 *
 * ТОЧНЫЕ формы и пути сверяются в Фазе 2 против живого рендерера (контракт SDK).
 * Здесь — best-effort, типобезопасно, без падений.
 */
import { Hono } from "hono"
import { requireSession, type Session as Auth } from "./auth.ts"

type Env = { Variables: { session: Auth; token: string } }

export const meta = new Hono<Env>()
meta.use("*", requireSession)

// Конфиг приложения — рендерер мёржит с дефолтами. Пустой объект безопасен.
meta.get("/config", (c) => c.json({}))

// Провайдеры/модели в нашем вебе объявлены в конфиге провайдера (ourapp-ru); сервер
// их не диктует. Возвращаем пустой список — пикер берёт модели из конфигурации клиента.
meta.get("/config/providers", (c) => c.json({ providers: [], default: {} }))
meta.get("/provider", (c) => c.json({ providers: [], default: {} }))

// «Проект» у нас вестигиален (чат, не папка). Один фиктивный проект.
meta.get("/project", (c) => c.json([{ id: "default", worktree: "/", vcs: undefined, time: { created: 0 } }]))
meta.get("/project/current", (c) => c.json({ id: "default", worktree: "/", vcs: undefined, time: { created: 0 } }))

// Пути (desktop отдаёт реальные; в вебе — фиктивные, файловых операций нет).
meta.get("/path", (c) => c.json({ state: "/", config: "/", worktree: "/", directory: "/", data: "/" }))

// Команды / агенты — пусто (dev-фичи скрыты; наши сценарии живут на клиенте).
meta.get("/command", (c) => c.json([]))
meta.get("/agent", (c) => c.json([]))
meta.get("/app/agents", (c) => c.json([]))

// Скрытые «программистские» группы → пустые ответы.
meta.get("/mcp", (c) => c.json({}))
meta.get("/lsp", (c) => c.json({}))
meta.get("/vcs", (c) => c.json({}))
meta.get("/question", (c) => c.json([]))
meta.get("/permission", (c) => c.json([]))
