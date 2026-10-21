"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import type { DurableExtension, DurableExtensionFailure, DurableExtensionsResponse } from "../lib/api-types";
import { SETTINGS_SECTION_LABEL_KEYS, type SettingsSection } from "../lib/settings-navigation";
import { useApiRequest } from "../lib/api-request";
import { MCP_EXTENSION } from "../lib/conversation-mcp";
import { McpConversationTools } from "./McpConversationTools";
import { itemsToSwitch } from "./settings-ui-helpers";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigNotice,
  ConfigPanelShell,
  ConfigScopeSwitch,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarGroupStatus,
  ConfigSidebarGroupSwitch,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

/** Which selection the panel edits: the backend's default for new conversations, or the open conversation's own. */
export type ExtensionScope = "default" | "conversation";

/**
 * The Settings section an extension's own settings surface lives in, where this deployment has one. pi-durable gives an
 * extension no configuration surface of its own, so this panel never builds a generic editor for one: an extension
 * whose surface is another Settings section links to it, and an extension this map does not name shows no link at all.
 * `workspace-resources` is the resource loader, and its documents are managed in Settings › Skills.
 */
export const EXTENSION_SETTINGS_SECTION: Readonly<Record<string, SettingsSection>> = {
  "workspace-resources": "skills",
};

/**
 * The whole selection after switching `targets` to `enabled`, in the registry's own order. The backend stores a
 * selection whole, so one row and every row at once are the same write, and a name that is no longer installed is
 * dropped here rather than sent back to be refused.
 */
export function switchedSelection(
  installed: readonly string[],
  selected: readonly string[],
  targets: readonly string[],
  enabled: boolean,
): string[] {
  const switching = new Set(targets);
  const current = new Set(selected);
  return installed.filter((name) => (switching.has(name) ? enabled : current.has(name)));
}

/** The rows a group switch would change: the installed extensions not already in the requested state. */
export function extensionsToSwitch(
  installed: readonly string[],
  selected: readonly string[],
  enabled: boolean,
): string[] {
  return itemsToSwitch([...installed], enabled, (name) => selected.includes(name));
}

/** One installed extension's read-only facts, which is everything this panel is told about it. */
function ExtensionDetail({
  extension,
  enabled,
  busy,
  onToggle,
  onOpenSection,
}: {
  extension: DurableExtension;
  enabled: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onOpenSection?: (section: SettingsSection) => void;
}) {
  const { t } = useI18n();
  const settingsSection = EXTENSION_SETTINGS_SECTION[extension.name];
  return (
    <ConfigDetailStack>
      <ConfigDetailHeader className="is-top-aligned">
        <ConfigDetailHeaderInfo>
          <ConfigStatusDot active={enabled} />
          <ConfigDetailTitle>{extension.name}</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <ConfigSwitch
            checked={enabled}
            loading={busy}
            label={t(enabled ? "extensions.disable" : "extensions.enable", { name: extension.name })}
            onChange={onToggle}
          />
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <ConfigDetailGrid>
        <ConfigDetailGridRow
          label={t("i18n.status")}
          tone="plain"
          style={{ color: enabled ? "var(--accent)" : "var(--text-dim)" }}
        >
          {t(enabled ? "extensions.enabled" : "extensions.disabled")}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("extensions.tools")} mono={extension.tools.length > 0}>
          {extension.tools.length > 0 ? extension.tools.join(", ") : t("extensions.noneValue")}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("extensions.sections")} mono={extension.sections.length > 0}>
          {extension.sections.length > 0 ? extension.sections.join(", ") : t("extensions.noneValue")}
        </ConfigDetailGridRow>
      </ConfigDetailGrid>

      {settingsSection !== undefined && (
        <div>
          <ConfigSectionTitle>{t("extensions.settings")}</ConfigSectionTitle>
          <ConfigButton
            size="small"
            disabled={onOpenSection === undefined}
            onClick={() => onOpenSection?.(settingsSection)}
          >
            {t("extensions.openSettings", { section: t(SETTINGS_SECTION_LABEL_KEYS[settingsSection]) })}
          </ConfigButton>
        </div>
      )}
    </ConfigDetailStack>
  );
}

/**
 * The durable-extension surface: exactly the extensions this backend installed, each one enabled or disabled as the
 * default for new conversations or for the conversation this Settings was opened from. A change writes the whole
 * selection in one request, so a bulk toggle is one action, and the panel offers nothing else — no install, no update,
 * no check and no generic per-extension editor.
 */
export function ExtensionsConfig({
  sessionId,
  embedded = false,
  onClose,
  onOpenSection,
}: {
  sessionId: string | null;
  embedded?: boolean;
  onClose: () => void;
  /** Opens another Settings section, for an extension whose own settings surface lives there. */
  onOpenSection?: (section: SettingsSection) => void;
}) {
  const { t } = useI18n();
  // The installed set and the conversation's own selection belong to the connection this panel was opened under: an App
  // asks the Gateway it was admitted to, with that connection's own credential.
  const request = useApiRequest();
  const [inventory, setInventory] = useState<DurableExtensionsResponse | null>(null);
  const [conversation, setConversation] = useState<{ sessionId: string; extensions: readonly string[] } | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<ExtensionScope>("default");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  /**
   * The conversation this panel is showing right now.
   *
   * A write and a read both answer later than they were asked, and the panel stays mounted while the reader moves
   * between conversations: the answer belongs to the conversation it named, or it is not this panel's to publish. This
   * is the identity the completion is checked against — the conversation, not the surface that asked.
   */
  const shownSessionIdRef = useRef<string | null>(sessionId);
  shownSessionIdRef.current = sessionId;

  const installed = useMemo(() => inventory?.installed.map((extension) => extension.name) ?? [], [inventory]);
  // A conversation's own selection is only usable once it was read: while it is unread, the scope stays the default
  // rather than showing an empty selection, which would claim this conversation selects nothing.
  const conversationSelection = sessionId !== null && conversation !== null && conversation.sessionId === sessionId
    ? conversation.extensions
    : null;
  const conversationReady = conversationSelection !== null;
  const activeScope: ExtensionScope = scope === "conversation" && conversationReady ? "conversation" : "default";
  // The conversation branch is only reachable while its selection was read, which is what `conversationReady` means;
  // the default branch is the backend's own answer, or nothing while it is still loading.
  const selection: readonly string[] = activeScope === "conversation"
    ? conversationSelection ?? []
    : inventory?.default ?? [];

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await request("/api/extensions");
      const body = (await response.json()) as DurableExtensionsResponse & { error?: string };
      if (!response.ok || body.error || !Array.isArray(body.installed)) throw new Error(body.error ?? `HTTP ${response.status}`);
      setInventory(body);
      setSelected((current) => (current !== null && body.installed.some((extension) => extension.name === current)
        ? current
        : body.installed[0]?.name ?? null));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  // The conversation's selection is that conversation's own durable state, so it is read from the conversation rather
  // than inferred from the default, and a reload reads the same thing back.
  //
  // It is read on the Backend's own vocabulary (`/api/conversations/:id/...`), which is the only one this deployment
  // serves: the copied app's `/api/sessions/...` addresses are the retired Next BFF's, and an ingress forwards `/api`
  // to the Backend unchanged, so a panel on that spelling asked for a conversation the Backend has never heard of and
  // could never reach this scope at all. Ticket 05's own journey is what found it.
  useEffect(() => {
    if (sessionId === null) {
      setConversation(null);
      setConversationError(null);
      setScope("default");
      return;
    }
    let cancelled = false;
    setConversation(null);
    setConversationError(null);
    void (async () => {
      try {
        const response = await request(`/api/conversations/${encodeURIComponent(sessionId)}/state`);
        const body = (await response.json()) as { extensions?: readonly string[]; error?: string };
        if (!response.ok || body.error || !Array.isArray(body.extensions)) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!cancelled) setConversation({ sessionId, extensions: body.extensions });
      } catch (error) {
        if (!cancelled) setConversationError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, request]);

  /** One write for the whole selection, in whichever scope is active; the answer is what was stored. */
  const applyToggle = useCallback(async (targets: readonly string[], enabled: boolean, bulk: boolean) => {
    const current = activeScope === "conversation" ? conversationSelection : inventory?.default;
    if (current === null || current === undefined) return;
    const next = switchedSelection(installed, current, targets, enabled);
    // The conversation this write is about, as it is when the write starts. A conversation write's answer is published
    // only while that conversation is still the one on screen; the deployment's default belongs to the connection
    // rather than to one conversation, so its answer is always this panel's own.
    const writtenSessionId = activeScope === "conversation" ? sessionId : null;
    const belongsToShown = () => writtenSessionId === null || shownSessionIdRef.current === writtenSessionId;
    setBusy(true);
    setNotice(null);
    setActionError(null);
    setGroupError(null);
    try {
      if (writtenSessionId !== null) {
        const response = await request(`/api/conversations/${encodeURIComponent(writtenSessionId)}/extensions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extensions: next }),
        });
        const body = (await response.json()) as { extensions?: readonly string[]; error?: string };
        if (!response.ok || body.error || !Array.isArray(body.extensions)) throw new Error(body.error ?? `HTTP ${response.status}`);
        // The answer states the selection that conversation now holds: the route writes it through the conversation's
        // own configure seam, so this readback is that conversation's state and not a second copy of the default.
        if (belongsToShown()) {
          setConversation({ sessionId: writtenSessionId, extensions: body.extensions });
          setNotice(t("extensions.savedConversation"));
        }
      } else {
        const response = await request("/api/extensions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extensions: next }),
        });
        const body = (await response.json()) as DurableExtensionsResponse & { error?: string };
        if (!response.ok || body.error || !Array.isArray(body.installed)) throw new Error(body.error ?? `HTTP ${response.status}`);
        // The default belongs to the connection rather than to one conversation, so every mounted reader of it is this
        // panel itself: the answer is the whole selection the backend now stores.
        setInventory(body);
        setNotice(t("extensions.savedDefault"));
      }
    } catch (error) {
      // A failure about a conversation the reader has left is not this panel's error to state: the conversation they are
      // looking at did not ask for this write, so reporting it here would attribute it to the wrong selection.
      if (belongsToShown()) {
        const message = error instanceof Error ? error.message : String(error);
        if (bulk) setGroupError(message); else setActionError(message);
      }
    } finally {
      // The in-flight indicator is this panel's own and the write has settled either way: leaving it set because the
      // reader moved on would leave the next conversation's panel permanently saving.
      setBusy(false);
    }
  }, [activeScope, conversationSelection, installed, inventory, request, sessionId, t]);

  const groupToggle = (enabled: boolean) => {
    const targets = extensionsToSwitch(installed, selection, enabled);
    if (targets.length === 0) return;
    void applyToggle(targets, enabled, true);
  };

  const selectedExtension = inventory?.installed.find((extension) => extension.name === selected) ?? null;
  const failures: readonly DurableExtensionFailure[] = inventory?.failures ?? [];
  const allOn = installed.length > 0 && selection.length === installed.length;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.extensions")} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="extensions-scope">
        <ConfigScopeSwitch
          value={activeScope}
          label={t("extensions.applyTo")}
          options={[
            { value: "default", label: t("extensions.scope.default") },
            { value: "conversation", label: t("extensions.scope.conversation"), disabled: !conversationReady },
          ]}
          disabledReason={conversationError === null
            ? t("extensions.scopeNoConversation")
            : t("extensions.conversationUnreadable", { reason: conversationError })}
          onChange={(next) => {
            setScope(next);
            setNotice(null);
            setActionError(null);
            setGroupError(null);
          }}
        >
          {busy && <span role="status" className="config-scope-switch-reason">{t("i18n.saving")}</span>}
        </ConfigScopeSwitch>
      </div>
      {notice !== null && <ConfigNotice>{notice}</ConfigNotice>}
      {actionError !== null && <div role="alert" className="config-notice">{actionError}</div>}

      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {loading ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : loadError !== null ? (
              <div role="alert" className="config-sidebar-message is-error">{t("extensions.loadFailed")} {loadError}</div>
            ) : installed.length === 0 ? (
              <div className="config-sidebar-message is-empty">{t("extensions.none")}</div>
            ) : (
              <div className="config-sidebar-group">
                <ConfigSidebarGroupLabel
                  aside={
                    <ConfigSidebarGroupSwitch
                      enabled={selection.length}
                      total={installed.length}
                      disabled={busy}
                      loading={busy}
                      label={t(allOn ? "extensions.groupSwitchOn" : "extensions.groupSwitchOff")}
                      onChange={groupToggle}
                    />
                  }
                >
                  {t("extensions.installed")}
                </ConfigSidebarGroupLabel>
                {groupError !== null && <ConfigSidebarGroupStatus error={groupError} />}
                {(inventory?.installed ?? []).map((extension) => {
                  const on = selection.includes(extension.name);
                  return (
                    <ConfigSidebarItem
                      key={extension.name}
                      active={selected === extension.name}
                      title={extension.name}
                      onClick={() => {
                        setSelected(extension.name);
                        setNotice(null);
                        setActionError(null);
                      }}
                    >
                      <ConfigStatusDot active={on} />
                      <ConfigSidebarText className={`is-grow${on ? "" : " is-muted"}`}>{extension.name}</ConfigSidebarText>
                    </ConfigSidebarItem>
                  );
                })}
              </div>
            )}
          </ConfigSidebarList>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {selectedExtension === null ? (
              <ConfigEmptyState>{t("extensions.select")}</ConfigEmptyState>
            ) : (
              <>
                <ExtensionDetail
                  key={selectedExtension.name}
                  extension={selectedExtension}
                  enabled={selection.includes(selectedExtension.name)}
                  busy={busy}
                  onToggle={(enabled) => void applyToggle([selectedExtension.name], enabled, false)}
                  onOpenSection={onOpenSection}
                />
                {/* One conversation's MCP tools are that conversation's own durable state, so they are shown only in
                    the conversation scope and only under the extension that offers them: the deployment default holds
                    no grants, and a grant is one conversation's choice (tickets 03b, 03c). This block's own read asks
                    the host to read its files and connects nothing. */}
                {selectedExtension.name === MCP_EXTENSION && activeScope === "conversation" && sessionId !== null && (
                  // `key` is what makes the block's own identity the conversation's: the grants, listings and refusals
                  // it holds are that conversation's durable state, so a switch to another conversation is a new block
                  // rather than one panel re-deciding what it holds. `extensionSelected` is the fact this panel above
                  // just wrote, which the block cannot read any earlier than the person switched it.
                  <McpConversationTools key={sessionId} conversationId={sessionId} extensionSelected={selection.includes(MCP_EXTENSION)} />
                )}
              </>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={failures.length > 0 ? (
          <ConfigFooterStatus
            tone="error"
            summary={failures.length === 1 ? t("extensions.failure") : t("extensions.failures", { count: failures.length })}
            details={failures.map((failure) => `${failure.name}: ${failure.message}`)}
          />
        ) : (
          <ConfigFooterStatus summary={inventory === null ? "" : t("extensions.count", { enabled: selection.length, total: installed.length })} />
        )}
      >
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
        <ConfigButton variant="secondary" onClick={() => void load()} disabled={loading || busy}>
          {t("i18n.refresh")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
