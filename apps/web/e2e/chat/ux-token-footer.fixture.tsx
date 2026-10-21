/**
 * Browser fixture for UX ticket 05 (response-footer SVG token statistics and
 * the browser visibility preference).
 *
 * It mounts the production MessageView (real footer, real i18n, real preference
 * module) with one usage-bearing assistant message. The switch and the locale
 * buttons stand in for Settings › General's switch and the language picker;
 * the switch calls the same response-usage-visibility module SettingsPanel
 * calls. The driver reads rendered DOM, accessible names and computed styles
 * only.
 */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageView } from "@hepi/ui/components/MessageView";
import { I18nProvider, useI18n } from "@hepi/ui/hooks/useI18n";
import {
  isResponseUsageVisible,
  setResponseUsageVisible,
  subscribeResponseUsageVisibility,
} from "@hepi/ui/lib/response-usage-visibility";
import type { AgentMessage } from "@hepi/ui/lib/types";
import "./ux-token-footer.fixture.css";

export const USAGE = {
  input: 1234,
  output: 567,
  cacheRead: 89,
  cacheWrite: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
};

function Fixture() {
  const { locale, setLocale } = useI18n();
  const [visible, setVisible] = useState(isResponseUsageVisible);
  useEffect(() => subscribeResponseUsageVisibility(() => setVisible(isResponseUsageVisible())), []);

  const message = useMemo<AgentMessage>(() => ({
    role: "assistant",
    content: [{ type: "text", text: "Answer with token statistics in its footer." }],
    model: "fixture-model",
    provider: "fixture",
    usage: USAGE,
  }), []);

  return (
    <div className="stage">
      <div className="controls">
        <button
          type="button"
          role="switch"
          aria-checked={visible}
          data-fixture-switch
          onClick={() => setResponseUsageVisible(!visible)}
        >
          token statistics
        </button>
        {["en", "zh-CN"].map((id) => (
          <button key={id} type="button" data-fixture-locale={id} onClick={() => setLocale(id as typeof locale)}>
            {id}
          </button>
        ))}
      </div>
      <div className="chat" data-fixture-chat>
        <MessageView message={message} showTimestamp />
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
