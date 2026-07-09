/**
 * OurApp — переключатель силы модели в сценарных сессиях (заменяет тумблер
 * «Углублённо» + полный список моделей — см. store.ts).
 */
import { createSignal, For, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { TIER_DESC, TIER_LABEL, TIER_MODEL, TIER_ORDER, tierForModel, type ModelTier } from "./store"

export interface ScenarioTierSelectorModel {
  current: () => { id: string; provider: { id: string } } | undefined
  set: (item: { providerID: string; modelID: string } | undefined, options?: { recent?: boolean }) => void
}

export const ScenarioTierSelector: Component<{ model: ScenarioTierSelectorModel }> = (props) => {
  const [open, setOpen] = createSignal(false)
  const activeTier = () => tierForModel(props.model.current())

  const select = (tier: ModelTier) => {
    const key = TIER_MODEL[tier]
    props.model.set({ providerID: key.providerID, modelID: key.modelID }, { recent: true })
    setOpen(false)
  }

  return (
    <DropdownMenu gutter={4} placement="top-start" open={open()} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        as="button"
        type="button"
        data-hint="ws-tier"
        title="Сила модели для этого сценария"
        aria-label="Сила модели"
        class="shrink-0 inline-flex items-center gap-x-1 h-8 px-2 rounded-md text-[13px] font-[440] leading-4 text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover transition-colors"
      >
        <Icon name="sliders" size="small" class="shrink-0" />
        <span>{activeTier() ? TIER_LABEL[activeTier()!] : "Сила"}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content style={{ "min-width": "260px", "max-width": "300px" }}>
          <For each={TIER_ORDER}>
            {(tier) => (
              <DropdownMenu.Item onSelect={() => select(tier)}>
                <div class="flex flex-col gap-y-0.5 py-0.5">
                  <DropdownMenu.ItemLabel>
                    {TIER_LABEL[tier]}
                    {activeTier() === tier ? " ✓" : ""}
                  </DropdownMenu.ItemLabel>
                  <span class="text-[11px] leading-tight text-v2-text-text-faint whitespace-normal">
                    {TIER_DESC[tier]}
                  </span>
                </div>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
