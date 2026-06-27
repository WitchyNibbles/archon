/**
 * TabBar — Tasks / Gates view selector (dashQuality S1).
 *
 * Underline-only active state: 2px --accent border-bottom on the active tab.
 * NO pill tabs — tab elements carry --radius-none per council condition C10.
 *
 * Keyboard: roving tabindex pattern per WAI-ARIA Tabs spec.
 *   - Active tab: tabIndex=0 (in natural tab order)
 *   - Inactive tabs: tabIndex=-1 (keyboard reachable via ArrowLeft/ArrowRight)
 *   - Left/Right arrows move focus AND activate the adjacent tab
 *   - Tab key follows normal document focus order (exits the tablist)
 *
 * A11y:
 *   - role="tablist" on the container
 *   - role="tab" on each button
 *   - aria-selected={true|false}
 *   - aria-controls pointing to the tab panel id
 *
 * C10: --radius-none on tab elements (no pill shape, no border-radius > 0px).
 * C14: Gates tab demotes GateSwimlane without removing it.
 */

import { useRef, useCallback } from "react";

export type DashboardTab = "tasks" | "gates";

interface TabBarProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
}

interface TabConfig {
  id: DashboardTab;
  label: string;
  panelId: string;
}

const TABS: readonly TabConfig[] = [
  { id: "tasks", label: "Tasks", panelId: "tabpanel-tasks" },
  { id: "gates", label: "Gates", panelId: "tabpanel-gates" },
] as const;

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, currentIndex: number) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % TABS.length;
        const nextTab = TABS[nextIndex];
        if (nextTab) {
          tabRefs.current[nextIndex]?.focus();
          onTabChange(nextTab.id);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prevIndex = (currentIndex - 1 + TABS.length) % TABS.length;
        const prevTab = TABS[prevIndex];
        if (prevTab) {
          tabRefs.current[prevIndex]?.focus();
          onTabChange(prevTab.id);
        }
      }
    },
    [onTabChange]
  );

  return (
    <div className="tab-bar" role="tablist" aria-label="Dashboard views">
      {TABS.map((tab, i) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            role="tab"
            aria-selected={isActive}
            aria-controls={tab.panelId}
            id={`tab-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            className={`tab-bar__tab mono${isActive ? " tab-bar__tab--active" : ""}`}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
