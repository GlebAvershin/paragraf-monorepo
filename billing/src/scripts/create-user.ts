/**
 * Ручное создание пользователя (личного кабинета) — для первых тестовых клиентов.
 *
 * Вход по OTP разрешён ТОЛЬКО заранее заведённым active-юзерам (см. routes/auth.ts,
 * allowlist). Самозапись закрыта, поэтому кабинеты первым клиентам создаём этим
 * скриптом. Он вставляет пользователя (status=active, email подтверждён) и через
 * initSubscription заводит триал-подписку + виртуальный ключ LiteLLM + кредиты.
 *
 * Использование (из каталога billing/, с поднятым LiteLLM-шлюзом):
 *   bun run create-user <email> ["Имя Фамилия"] [пароль]
 *
 * Необязательный [пароль] — заводит password_hash (email+пароль вход,
 * /auth/login) в дополнение к OTP. Для обычных клиентов не передавать —
 * у них остаётся только OTP.
 *
 * Идемпотентно: если юзер уже есть — не дублирует, при отсутствии подписки
 * дозаводит её; пароль (если передан) перезаписывается. Требует ту же .env,
 * что и billing (JWT/DATABASE_URL/LITELLM_*).
 */
import { and, eq } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { initSubscription } from "../routes/subscriptions.ts"

async function main() {
  const email = process.argv[2]?.trim().toLowerCase()
  const name = process.argv[3]?.trim() || null
  const password = process.argv[4]?.trim() || null

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("Usage: bun run create-user <email> [\"Имя Фамилия\"] [пароль]")
    console.error("  email обязателен и должен быть валидным.")
    process.exit(1)
  }

  const now = new Date()

  // 1. Юзер уже есть?
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
  let user = existing[0]

  if (user) {
    console.log(`Пользователь уже существует: ${user.email} (id=${user.id}, status=${user.status})`)
    if (user.status !== "active") {
      await db.update(schema.users).set({ status: "active", updatedAt: now }).where(eq(schema.users.id, user.id))
      console.log("  → статус переведён в active.")
    }
  } else {
    const inserted = await db
      .insert(schema.users)
      .values({ email, name, status: "active", emailVerifiedAt: now })
      .returning()
    user = inserted[0]!
    console.log(`Создан пользователь: ${user.email} (id=${user.id})`)
  }

  if (password) {
    const passwordHash = await Bun.password.hash(password)
    await db.update(schema.users).set({ passwordHash, updatedAt: now }).where(eq(schema.users.id, user.id))
    console.log("  → пароль установлен (вход через email+пароль, /auth/login).")
  }

  // 2. Подписка есть?
  const subs = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, user.id))
    .limit(1)

  if (subs[0]) {
    console.log(`Подписка уже есть: план=${subs[0].planCode}, статус=${subs[0].status}. Готово.`)
    process.exit(0)
  }

  // 3. Заводим триал-подписку + LiteLLM-ключ + кредиты (нужен поднятый шлюз).
  console.log("Создаю подписку + виртуальный ключ LiteLLM (нужен поднятый шлюз :4000)…")
  try {
    await initSubscription(user.id)
  } catch (err) {
    console.error("Не удалось создать подписку:", err instanceof Error ? err.message : String(err))
    console.error("Проверь, что LiteLLM-шлюз поднят и seed выполнен (bun run db:seed).")
    process.exit(1)
  }

  // 4. Показать выданный ключ (для отладки/выдачи клиенту через приложение — вход по OTP).
  const finalSub = await db
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.userId, user.id)))
    .limit(1)
  console.log("Готово. Кабинет создан:")
  console.log(`  email:     ${user.email}`)
  console.log(`  user id:   ${user.id}`)
  console.log(`  план:      ${finalSub[0]?.planCode ?? "?"} (${finalSub[0]?.status ?? "?"})`)
  console.log("Вход: пользователь заходит на сайт, вводит этот email → получает OTP-код → внутри.")
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
