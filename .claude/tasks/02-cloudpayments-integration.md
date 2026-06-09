# ТЗ-02: Интеграция CloudPayments

**Размер:** L (3-4 недели)
**Приоритет:** 🟠 Без неё нельзя запускать платный продукт

---

## 1. Контекст

Сейчас Billing-сервис умеет создавать/блокировать LiteLLM virtual keys по тарифу, но **не принимает деньги**. На странице `/credits` есть кнопки "Докупить +500 кредитов" и "Сменить тариф" — они **без onClick**, ничего не делают. Это блокер №1 для запуска платного продукта в РФ/СНГ.

CloudPayments — выбранный эквайер (см. план §10). Поддерживает рублёвую подписку (рекуррент), разовые платежи, привязку карт, webhook'и.

## 2. Объём

**В скоупе:**
- Привязка карты пользователя (CloudPayments tokenization API)
- Разовая покупка пакета кредитов (топ-ап)
- Подписка на тариф (Старт / Профи / Команда) с автопродлением
- Смена тарифа (upgrade/downgrade с пропорциональным расчётом)
- Webhook-приёмник от CloudPayments для подтверждения платежей
- История платежей (новая таблица + API + UI)
- Retry-логика для неудачных рекуррентов (3 попытки за 7 дней)
- Lifecycle подписки (trial → active → past_due → expired)
- Email-уведомления о ключевых событиях (списание/неудача/истечение)

**Не в скоупе:**
- Партнёрские/корпоративные счета (через 1С) — Phase 4
- Промокоды / реферальная программа — Phase 3
- Возвраты средств (manual ops процесс) — Phase 3
- Налоговая отчётность (УСН/НДС) — отдельная задача после первых платежей

## 3. Что нужно сделать в CloudPayments

**Регистрация и настройка (вне кода):**
1. Зарегистрировать юр.лицо в CloudPayments (РФ-юрлицо).
2. Получить Public ID + Secret API key.
3. Настроить webhook URL: `https://billing.paragraf.app/webhooks/cloudpayments`.
4. Настроить чек ОФД (Online Fiscal Drive — обязательно для РФ).
5. Активировать рекурренты в личном кабинете.

## 4. Backend (`billing` service)

### 4.1 Конфиг (`billing/src/config.ts`)
Добавить:
```ts
CLOUDPAYMENTS_PUBLIC_ID: string
CLOUDPAYMENTS_API_SECRET: string
CLOUDPAYMENTS_WEBHOOK_SECRET: string // для проверки HMAC
CLOUDPAYMENTS_API_URL: "https://api.cloudpayments.ru"
```

### 4.2 Схема БД (`billing/src/db/schema.ts`)
Уже есть таблицы `payment_methods`, `payments`, `subscriptions`, `credit_grants` — нужно проверить что их структура соответствует ниже. Если нет — добавить миграцию.

```ts
// payment_methods — привязанные карты
{
  id: uuid,
  userId: uuid,
  cloudpaymentsToken: text, // CryptogramTokenize result
  cardLast4: text,
  cardBrand: text, // 'visa' | 'mastercard' | 'mir'
  cardExpiresAt: date,
  isDefault: boolean,
  createdAt: timestamp,
}

// payments — все транзакции (успешные и неудачные)
{
  id: uuid,
  userId: uuid,
  subscriptionId: uuid | null,
  amountKopeck: bigint, // в копейках, всегда целое
  status: 'pending' | 'succeeded' | 'failed' | 'refunded',
  kind: 'subscription' | 'topup' | 'refund',
  cloudpaymentsTransactionId: text | null,
  isRecurrent: boolean,
  attemptNumber: integer, // для retry
  failureReason: text | null,
  paidAt: timestamp | null,
  metadata: jsonb, // { invoiceId, planCode, topupAmount, ... }
  createdAt: timestamp,
}

// credit_grants — уже есть. Расширить reason:
//   'subscription_monthly' | 'topup' | 'trial' | 'compensation' | 'referral'
```

### 4.3 Endpoints

#### `POST /payments/method` — привязка карты
**Используется на странице /credits для первоначальной привязки.**

Request:
```json
{ "cryptogram": "base64-from-cloudpayments-widget" }
```

Logic:
1. Принимает cryptogram (CloudPayments Widget на фронте генерирует его при вводе карты).
2. Делает **тестовое списание 1 RUB с автоматическим возвратом** для валидации карты:
   - POST `https://api.cloudpayments.ru/payments/cards/auth` с amount=1, cryptogram=...
   - Сразу: POST `/payments/void` для возврата холда.
3. Сохраняет токен и метаданные в `payment_methods`.

Response:
```json
{ "id": "uuid", "cardLast4": "1234", "cardBrand": "mir" }
```

#### `POST /payments/topup` — разовая покупка пакета кредитов
Request:
```json
{ "package": "p500" }  // "p500" = 500 кредитов за 1290 ₽
```

Logic:
1. Найти `payment_methods.isDefault=true` для юзера. Если нет — `400 no_card_attached`.
2. Через CloudPayments API сделать рекуррентное списание (используя сохранённый токен):
   - POST `/payments/tokens/charge` с amount=1290, token=..., invoiceId=`topup_<uuid>`
3. При **успехе**:
   - Insert в `payments` (status: succeeded).
   - Insert в `credit_grants` (reason: 'topup', amount: 500, expires_at: NULL — топ-ап не сгорает).
   - Вызов `litellm.updateKeyBudget(litellmKey, currentBudget + 1$)` — увеличить hardcap.
   - Отослать email "Платёж прошёл" через `sendEmail`.
4. При **отказе** (3DS, недостаточно средств, etc):
   - Insert в `payments` (status: failed, failureReason: ...).
   - 402 с описанием для UI.

Response:
```json
{ "paymentId": "uuid", "creditsAdded": 500, "newBalance": 1500 }
```

#### `POST /subscriptions/change-plan` — смена тарифа
Request:
```json
{ "newPlanCode": "pro" }
```

Logic:
1. Найти текущую подписку юзера. Получить `currentPlan` и `newPlan`.
2. **Upgrade** (newPlan.price > currentPlan.price):
   - Рассчитать пропорциональную доплату: `доплата = (newPlan.price - currentPlan.price) * (днейДоКонцаПериода / 30)`.
   - Списать доплату через CloudPayments tokens/charge.
   - При успехе — обновить `subscriptions.planCode`.
   - Дать `(newPlan.monthlyCredits - currentPlan.monthlyCredits) * (днейДоКонцаПериода / 30)` доп. кредитов.
3. **Downgrade** (newPlan.price < currentPlan.price):
   - Не возвращать разницу деньгами.
   - Установить `subscriptions.pendingPlanCode = newPlan.code` (новое поле). Применится в начале следующего периода.
4. Email-уведомление.

#### `POST /webhooks/cloudpayments` — обработчик webhook'ов
CloudPayments отправляет нотификации:
- `Pay` — успешный платёж (включая рекуррент)
- `Fail` — неудачный платёж
- `Recurrent` — событие подписки
- `Receipt` — фискальный чек создан

Logic:
1. Проверить HMAC-подпись запроса (header `Content-HMAC`) с `CLOUDPAYMENTS_WEBHOOK_SECRET`.
2. По `InvoiceId` найти `payment` в БД и обновить status.
3. Если это рекуррент за подписку — продлить subscription period, выпустить новые credit_grants (reason: subscription_monthly, expires_at: nextPeriodEnd).
4. Если Fail — увеличить `attemptNumber`. Если >=3 — перевести subscription в `past_due`, через 7 дней — в `expired`.
5. Ответить `{ "code": 0 }` (CloudPayments ожидает этот формат, иначе будет ретраить).

#### `GET /payments/history` — история платежей (для UI на /credits)
Response:
```json
{
  "items": [
    {
      "id": "uuid",
      "amountKopeck": 99000,
      "status": "succeeded",
      "kind": "subscription",
      "planTitleRu": "Профи",
      "creditsAdded": 1700,
      "paidAt": "2026-05-29T10:00:00Z"
    },
    ...
  ],
  "total": 12
}
```

### 4.4 Worker для retry неудачных рекуррентов

Файл `billing/src/worker/recurrent-retry.ts`:
- Раз в час сканирует `subscriptions` со статусом `past_due` и `last_attempt < now - 1 day`.
- Делает попытку повторного списания.
- Лимит: 3 попытки за 7 дней, потом → `expired`.

Запускается как Bun cronjob либо как отдельный процесс через `bun run worker/recurrent-retry.ts`.

### 4.5 Lifecycle подписки

```
   register / OTP-login
      │
      ▼
  ┌─────────┐   trial_ends_at + has_card_attached + auto-charge OK   ┌─────────┐
  │  TRIAL  ├────────────────────────────────────────────────────────▶│ ACTIVE  │◀──┐
  └────┬────┘                                                          └────┬────┘   │
       │ trial_ends, NO card / charge fail                                  │ recur OK│
       ▼                                                                    │         │
  ┌─────────┐                                                               ▼         │
  │ EXPIRED │◀───3 retries fail in 7d─────────────────────────┐ ┌──────────┐   │
  └────┬────┘                                                  └─┤ PAST_DUE ├───┘
       │ user attaches card + pays again                          └────┬─────┘
       ▼                                                               │ retry OK
   reactivate → ACTIVE                                                 │
                                                                       │
   user cancels: ACTIVE → cancel_at_period_end=true → EXPIRED в конце периода
```

## 5. Frontend (`desktop`)

### 5.1 CloudPayments Widget на странице `/credits`

Подключить `https://widget.cloudpayments.ru/bundles/cloudpayments.js` в `index.html` или через dynamic import.

Создать `desktop/packages/app/src/ourapp/cloudpayments-widget.ts`:

```ts
declare global {
  interface Window { cp: any }
}

export async function openCardBindingWidget(): Promise<{ cryptogram: string } | null> {
  // Открывает стандартное модальное окно CloudPayments для ввода карты.
  // Возвращает cryptogram (base64-зашифрованные данные карты) для отправки на backend.
  return new Promise((resolve) => {
    const widget = new window.cp.CloudPayments()
    widget.charge({
      publicId: import.meta.env.VITE_CLOUDPAYMENTS_PUBLIC_ID,
      description: "Привязка карты для «Параграфа»",
      amount: 1, // тестовое списание 1 RUB
      currency: "RUB",
      requireEmail: false,
      skin: "mini",
    }, (options: any) => {
      resolve({ cryptogram: options.cryptogram })
    }, () => resolve(null))
  })
}
```

### 5.2 Подключение кнопок на странице `/credits`

В `credits-page.tsx`:

```tsx
const [busy, setBusy] = createSignal(false)

const handleTopup = async () => {
  if (!me()?.subscription?.paymentMethodId) {
    // Карта не привязана — сначала привязка
    const cardResult = await openCardBindingWidget()
    if (!cardResult) return
    setBusy(true)
    await billingApi.attachCard(cardResult.cryptogram)
  }
  setBusy(true)
  const res = await billingApi.topup("p500")
  setBusy(false)
  if (res.ok) {
    refreshLimits() // обновить виджет в сайдбаре
    showToast({ title: "Платёж прошёл", description: `+500 кредитов. Новый баланс: ${res.data.newBalance}` })
  } else {
    showToast({ title: "Не удалось списать", description: res.error })
  }
}

const handleChangePlan = (newPlan: string) => {
  // Открыть модалку выбора тарифа со сравнением
  setShowPlanModal(true)
  setTargetPlan(newPlan)
}
```

### 5.3 Модалка "Сменить тариф"

Новый компонент `desktop/packages/app/src/ourapp/plan-change-modal.tsx`:
- Таблица сравнения 3 тарифов (Старт / Профи / Команда) с фичами и ценой.
- При клике на тариф — расчёт доплаты при upgrade ("До конца периода 18 дней, доплата 1 740 ₽").
- При downgrade — текст "Сменится с начала следующего периода".
- Кнопка "Подтвердить" → POST /subscriptions/change-plan.

### 5.4 История платежей на `/credits`

В блоке "История платежей" (сейчас заглушка) показывать реальные данные:

```tsx
const [history] = createResource(() => billingApi.paymentHistory())

<table>
  <For each={history()?.items}>
    {(item) => (
      <tr>
        <td>{formatDate(item.paidAt)}</td>
        <td>{item.kind === "subscription" ? `Подписка ${item.planTitleRu}` : "Докупка кредитов"}</td>
        <td>{formatRubles(item.amountKopeck)} ₽</td>
        <td>+{item.creditsAdded} кредитов</td>
        <td><Badge status={item.status} /></td>
      </tr>
    )}
  </For>
</table>
```

## 6. Файлы для создания / редактирования

**Создать (backend):**
- `billing/src/routes/payments.ts` — `/payments/method`, `/payments/topup`, `/payments/history`
- `billing/src/routes/webhooks.ts` — `/webhooks/cloudpayments`
- `billing/src/lib/cloudpayments.ts` — клиент CloudPayments API (charge, void, etc.)
- `billing/src/lib/hmac.ts` — проверка webhook signature
- `billing/src/worker/recurrent-retry.ts`
- Миграция БД для новых полей (`payment_methods.cloudpaymentsToken`, `payments.attemptNumber`, `subscriptions.pendingPlanCode`)

**Изменить (backend):**
- `billing/src/index.ts` — подключить новые роуты
- `billing/src/routes/subscriptions.ts` — добавить `/change-plan`
- `billing/src/config.ts` — добавить CLOUDPAYMENTS_* переменные
- `billing/src/db/schema.ts` — обновить структуру payment_methods, payments

**Создать (frontend):**
- `desktop/packages/app/src/ourapp/cloudpayments-widget.ts`
- `desktop/packages/app/src/ourapp/plan-change-modal.tsx`

**Изменить (frontend):**
- `desktop/packages/app/src/ourapp/credits-page.tsx` — подключить кнопки + историю
- `desktop/packages/app/src/ourapp/billing-api.ts` — методы attachCard, topup, paymentHistory, changePlan
- `desktop/packages/app/src/ourapp/low-balance-guard.tsx` — открывать модалку plan-change при клике "Сменить тариф" в HARD-модалке

## 7. Принимочные критерии

- [ ] Юзер заходит на `/credits` без привязанной карты → нажимает "Докупить +500 кредитов" → открывается CloudPayments widget → вводит тестовую карту (тест-режим) → карта привязалась, списание 1 RUB прошло и возвращено.
- [ ] Юзер с привязанной картой → "Докупить" → 1 290 ₽ списались, +500 кредитов в `credit_grants` (reason: topup), сайдбар-виджет обновился, LiteLLM hardcap увеличился.
- [ ] Юзер на тарифе "Старт" → "Сменить тариф" → выбрал "Профи" → модалка с доплатой → подтвердил → доплата списалась, тариф сменился, дополнительные кредиты начислены пропорционально.
- [ ] CloudPayments webhook на Pay приходит → запись в `payments` (status: succeeded) появляется или обновляется.
- [ ] Тест: рекуррент на следующий месяц проходит автоматически, выпускается новый `credit_grants` с reason: subscription_monthly.
- [ ] Тест: рекуррент падает 3 раза → подписка → past_due → expired через 7 дней.
- [ ] История платежей на `/credits` показывает все транзакции с фильтром по статусу.
- [ ] Email-уведомления приходят при: успешном платеже, неудачном платеже, истечении подписки.
- [ ] HMAC-валидация webhook'ов работает, левые запросы отклоняются 401.
- [ ] Для тестирования в dev — использовать CloudPayments **test mode** с тестовыми картами (4242424242424242 и т.д.).

## 8. Подводные камни

- **CloudPayments test mode** требует отдельной регистрации в тестовом ЛК. Не использовать боевой `publicId` для тестов.
- **3DS / SBP** — современные карты требуют 2-факторное подтверждение. CloudPayments виджет это обрабатывает, но при tokens/charge через API уже нет 3DS. Поэтому первичная привязка через виджет (с 3DS), а потом рекурренты по токену.
- **Фискальный чек (ОФД)** — обязателен в РФ при оплате физлицами. CloudPayments умеет автоматически отправлять данные в ОФД (опция в личном кабинете).
- **Валютный риск.** Доход в RUB, расход в USD. Хранить курс ЦБ на момент списания (для маржинального анализа).
- **Возвраты средств** — пока не реализуем, но заложить в схему `payments.status: 'refunded'` чтобы потом было куда вписывать.
- **Webhook ретраи.** CloudPayments ретраит webhook до тех пор пока не получит `{"code":0}`. Сделать idempotent — повторное событие не должно дважды начислить кредиты.
- **Тестовые рекурренты** в CloudPayments проходят с задержкой (не моментально). Учитывать при QA.
