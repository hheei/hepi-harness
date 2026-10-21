"use client";

import { useEffect, useState, type ReactElement } from "react";
import { TokenCacheReadIcon, TokenCacheWriteIcon, TokenInputIcon, TokenOutputIcon } from "./TokenUsageIcons";
import { useI18n } from "../hooks/useI18n";
import { isResponseUsageVisible, subscribeResponseUsageVisibility } from "../lib/response-usage-visibility";

/** Re-reads the browser preference whenever Settings changes it. */
function useUsageVisibility(): boolean {
  const [visible, setVisible] = useState(isResponseUsageVisible);
  useEffect(() => subscribeResponseUsageVisibility(() => setVisible(isResponseUsageVisible())), []);
  return visible;
}

const USAGE_METRICS = [
  { key: "input", labelKey: "chat.usageInput", Icon: TokenInputIcon },
  { key: "output", labelKey: "chat.usageOutput", Icon: TokenOutputIcon },
  { key: "cacheRead", labelKey: "chat.usageCacheRead", Icon: TokenCacheReadIcon },
  { key: "cacheWrite", labelKey: "chat.usageCacheWrite", Icon: TokenCacheWriteIcon },
] as const satisfies readonly { key: "input" | "output" | "cacheRead" | "cacheWrite"; labelKey: string; Icon: () => ReactElement }[];

/**
 * The per-response token statistics: one icon family plus the plain numbers.
 * Each metric keeps its localized name and value as one accessible pair, so an
 * icon never leaves a bare number unnamed. Presentation only — the aggregate
 * session toolbar and backend accounting are untouched.
 *
 * The browser preference that hides this footer is read by this component, so a
 * Settings change reaches an already-mounted transcript without re-rendering it.
 */
export function MessageUsage({ usage }: {
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
}) {
  const { t } = useI18n();
  const visible = useUsageVisibility();
  if (!visible) return null;
  const metrics = USAGE_METRICS
    .filter(({ key }) => usage[key] > 0)
    .map(({ key, labelKey, Icon }) => ({
      key,
      label: t(labelKey),
      value: usage[key].toLocaleString(),
      Icon,
    }));

  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 2, fontSize: 11, color: "var(--text-dim)" }}>
      {metrics.map(({ key, label, value, Icon }) => (
        <span
          key={key}
          data-token-metric={key}
          title={`${label}: ${value}`}
          style={{ display: "flex", alignItems: "center", gap: 3 }}
        >
          <Icon />
          <span style={{ display: "inline-flex" }}>
            <span className="sr-only">{label}: </span>
            {value}
          </span>
        </span>
      ))}
      {usage.cost?.total ? <span>${usage.cost.total.toFixed(4)}</span> : null}
    </div>
  );
}
