import * as React from "react"
import type { ComponentProps } from "react"

export function Tabs(props: ComponentProps<"div">) {
  return <div {...props} role="tablist" />
}

export function Tab({ panel, selected = false, ...props }: ComponentProps<"button"> & {
  panel: string
  selected?: boolean
}) {
  return <button {...props} type="button" role="tab" aria-controls={panel}
    aria-selected={selected} tabIndex={selected ? 0 : -1} />
}

export function TabPane({ tab, ...props }: ComponentProps<"div"> & { tab: string }) {
  return <div {...props} role="tabpanel" aria-labelledby={tab} />
}
