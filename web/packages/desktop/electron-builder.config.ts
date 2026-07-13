import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "isaac-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  // Схема ("opencode://") намеренно НЕ переименована — на неё завязан парсинг
  // deep-link'ов (pages/layout/deep-links.ts, main/index.ts) и OS-регистрация
  // протокола у уже установленных копий. name — только текст в диалоге ОС
  // "Открыть это ссылкой в ...?", он безопасно переименован.
  protocols: {
    name: "Isaac",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

// appId ("ai.opencode.desktop*") намеренно НЕ переименован в isaac.* — это
// bundle/AppUserModelID, на который завязаны OS-идентичность приложения
// (реестр Windows, macOS bundle id) и путь к userData (настройки/токен уже
// установленных копий). Смена appId для уже выкатанных инсталляций — это
// НОВОЕ приложение с точки зрения ОС (нет апдейта поверх старого, теряется
// userData) — решать отдельно, а не как часть переименования брендинга.
function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        // appId НЕ переименован — см. комментарий у getConfig().
        appId: "ai.opencode.desktop.dev",
        productName: "Isaac Dev",
        rpm: { packageName: "isaac-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.opencode.desktop.beta",
        productName: "Isaac Beta",
        protocols: { name: "Isaac Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "GlebAvershin", repo: "paragraf-monorepo", channel: "latest" },
        rpm: { packageName: "isaac-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.opencode.desktop",
        productName: "Isaac",
        protocols: { name: "Isaac", schemes: ["opencode"] },
        publish: { provider: "github", owner: "GlebAvershin", repo: "paragraf-monorepo", channel: "latest" },
        rpm: { packageName: "isaac" },
      }
    }
  }
}

export default getConfig()
