import { getSessionToken } from "./auth-storage"

export type DocumentDraft =
  | { kind: "text"; html: string }
  | { kind: "sheet"; cells: Record<string, Record<string, string>> }
export type DocumentVersion = { revision: number; draft: DocumentDraft | null; updated?: number }

const base =
  import.meta.env.VITE_OURAPP_ENGINE_URL || (import.meta.env.DEV ? "http://127.0.0.1:4096" : window.location.origin)

export async function documentVersion(
  session: string,
  key: string,
  input?: { revision: number; draft: DocumentDraft },
): Promise<DocumentVersion> {
  const response = await fetch(`${base}/session/${encodeURIComponent(session)}/document/${encodeURIComponent(key)}`, {
    method: input ? "POST" : "GET",
    headers: { Authorization: `Bearer ${getSessionToken()}`, "Content-Type": "application/json" },
    body: input ? JSON.stringify(input) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 409)
    throw new Error(
      "Документ изменён в другой вкладке. Скачайте ваши правки и обновите страницу, чтобы загрузить последнюю версию.",
    )
  if (!response.ok)
    throw new Error("Не удалось сохранить или загрузить документ. Проверьте соединение и повторите попытку.")
  return response.json()
}
