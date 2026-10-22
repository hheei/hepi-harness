"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { useApiRequest } from "../lib/api-request";
import {
  availabilityLimit,
  listingOf,
  mcpGrantAddBody,
  mcpGrantBody,
  mcpGrantRemoveBody,
  mcpListingRoute,
  mcpPanelState,
  mcpRefusalIsNamed,
  mcpRefusalKey,
  mcpSelectionRoute,
  mcpServerBlocks,
  mcpServerStates,
  mcpToolRows,
  appliedWrite,
  readConversationMcp,
  withHeldListings,
  readMcpListing,
  withListing,
  type ConversationMcpView,
  type McpSeamRefusal,
} from "../lib/conversation-mcp";
import { errorText } from "@hepi/protocol/error-text";
import { ConfigButton, ConfigNotice, ConfigSectionTitle, ConfigStatusDot } from "./SettingsUi";

/**
 * The MCP tools of **this conversation** (ticket 03c).
 *
 * It is mounted by Settings › Extensions in the conversation scope, because that panel already writes
 * `pi.agent.extensions` — whether `hepi.mcp` is selected at all — and this is the half that fills that choice with a
 * person's own picks. Both live on one seam, `/api/conversations/:id/extensions`, so a selection and its grants cannot
 * disagree, and no second route family or grant document is introduced.
 *
 * The four states are what a person must tell apart, and each is rendered from the single fact that states it; the
 * helper names them (`lib/conversation-mcp.ts`). Nothing is collapsed into one badge and no state is derived from a
 * connect.
 *
 * Discovery is explicit and per named server: opening this panel makes **one** request, the selection read, which asks
 * the host to read its own files and starts nothing. A server's tools appear only after its own "List tools" press —
 * the one request here that connects a server. A listing grants nothing: the checkbox is a separate act that writes one
 * grant through 03b's seam, and clearing it writes one revocation, which the backend answers without asking a host.
 *
 * Refusals keep the seam's own code (`needs-auth`, `server-disabled`, `project-untrusted`, `not_listed`, …) instead of a
 * second status vocabulary, an empty listing reads as an empty listing, and an unreachable host reads as one — the
 * three are never the same sentence.
 */

/** What one control's request is doing, so a person reads progress rather than silence. */
type Busy = { readonly kind: "read" | "list" | "grant" | "revoke"; readonly key: string } | null;

export function McpConversationTools({
  conversationId,
  extensionSelected,
}: {
  conversationId: string;
  /**
   * Whether this conversation selects `hepi.mcp`, as the panel this block is mounted in just stored it.
   *
   * The switch that changes it is above this block, and the panel's own read states the same fact a moment earlier, so
   * the prop is the newer of the two: it is what the limit reads from the instant the switch answers, and the read that
   * follows confirms it against the runtime's own offer.
   */
  extensionSelected: boolean;
}) {
  const { t } = useI18n();
  const request = useApiRequest();
  const [view, setViewState] = useState<ConversationMcpView | null>(null);
  // The view this instance currently shows, beside the state that renders it: a write's answer states a conversation's
  // grants and offer but not the listings this panel was given, so a write has to keep the ones it already holds rather
  // than read "no listing in this answer" as "this panel holds no listing" and collapse every unselected row.
  const viewRef = useRef<ConversationMcpView | null>(null);
  const setView = useCallback((next: ConversationMcpView | null) => { viewRef.current = next; setViewState(next); }, []);
  const [readError, setReadError] = useState<McpSeamRefusal | null>(null);
  // A refused listing is held per server because the seam's answer carries no listing to hold, and the panel must still
  // say which server refused and why. A later listing of that server replaces it.
  const [refusals, setRefusals] = useState<Record<string, McpSeamRefusal>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [writeError, setWriteError] = useState<{ readonly key: string; readonly refusal: McpSeamRefusal } | null>(null);
  // A read that comes back after the conversation moved on is dropped rather than applied, so one conversation's grants
  // cannot be painted over another's.
  const readRef = useRef(0);
  const writeRef = useRef(0);
  const listingRef = useRef(new Map<string, object>());
  const mountedRef = useRef(true);
  // The conversation every request below was made for. A request answers about **one** document, so an answer that
  // arrives after the panel moved to another conversation is dropped rather than applied to the wrong one — the same
  // fence for a read, a listing and a write, because all three carry a whole conversation's state back.
  const conversationRef = useRef(conversationId);
  // …and the epoch of that conversation: a new object per conversation, so a request can tell "the same conversation
  // was re-read" from "the panel moved away and came back", which is the case where its answer is older than the
  // document it now shows.
  const conversationEpochRef = useRef(Object());
  const selectionRef = useRef(extensionSelected);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Unmounting invalidates every request this instance made, of every kind: a panel that is gone must not answer.
      mountedRef.current = false;
      readRef.current += 1;
      writeRef.current += 1;
      listingRef.current.clear();
    };
  }, []);

  /**
   * The one read this panel makes by itself: the conversation's selection, its grants, the servers its host configures
   * and the names the runtime resolves. It asks no host to connect anything.
   */
  const load = useCallback(async () => {
    const at = conversationId;
    const attempt = ++readRef.current;
    setBusy({ kind: "read", key: "read" });
    setReadError(null);
    try {
      const response = await request(mcpSelectionRoute(conversationId));
      const body = await response.json().catch(() => null);
      if (conversationRef.current !== at || readRef.current !== attempt) return;
      // A state read states a conversation's grants and offer and asks no host to connect anything, so the listings
      // this panel was given by its own presses stay the newest reading of those servers: they are kept beside the answer
      // rather than dropped, which is what makes a re-read after a refused listing show both the refusal and the rows the
      // person was looking at.
      const read = readConversationMcp(conversationId, body, response.status);
      if (read.ok) setView(withHeldListings(read.view, viewRef.current));
      else setReadError(read.refusal);
    } catch (error) {
      if (conversationRef.current !== at || readRef.current !== attempt) return;
      setReadError({ code: "operation_failed", error: errorText(error), status: 0 });
    } finally {
      if (conversationRef.current === at && readRef.current === attempt && mountedRef.current) setBusy(null);
    }
  }, [conversationId, request, setView]);

  /**
   * The conversation changed, so everything held here — the view, its listings, its refusals, a write's refusal and the
   * control that was busy — belonged to the previous one and is dropped, and whatever is still in flight is invalidated
   * before the new read starts. Nothing of one conversation can be painted over another's, and a listing asked of one
   * conversation's host never answers as another's tools.
   */
  useEffect(() => {
    conversationRef.current = conversationId;
    conversationEpochRef.current = Object();
    readRef.current += 1;
    writeRef.current += 1;
    listingRef.current.clear();
    setView(null);
    setReadError(null);
    setRefusals({});
    setWriteError(null);
    setBusy(null);
    void load();
  }, [conversationId, load]);

  /**
   * The extension switch lives above this block and writes the same conversation, so a flip means the panel's held
   * read is now the older statement of whether `hepi.mcp` is selected. It re-reads the conversation — one request that
   * asks no host to connect anything — instead of guessing what the new offer is, so "currently available" cannot keep
   * saying yes for an extension the person just switched off.
   */
  useEffect(() => {
    if (selectionRef.current === extensionSelected) return;
    selectionRef.current = extensionSelected;
    void load();
  }, [extensionSelected, load]);

  /**
   * The one request that connects a server, made because a person named that server.
   *
   * The seam answers the conversation's whole state plus that one listing, so one request refreshes both and the
   * listing the panel holds afterwards is the one a grant can be written from.
   */
  const listServer = useCallback(async (server: string) => {
    const at = conversationId;
    const attempt = Object();
    listingRef.current.set(server, attempt);
    setBusy({ kind: "list", key: server });
    // The answer carries that conversation's whole state beside the one listing, so it is fenced exactly as a read is:
    // a listing asked before a switch cannot install its view, its listing or its refusal over the new conversation.
    const stale = () => !mountedRef.current || conversationRef.current !== at || listingRef.current.get(server) !== attempt;
    try {
      const response = await request(mcpListingRoute(conversationId, server));
      const body = await response.json().catch(() => null);
      if (stale()) return;
      listingRef.current.delete(server);
      const read = readConversationMcp(conversationId, body, response.status);
      if (!read.ok) {
        // A refused listing answers with a refusal, not with a state, so the four states this panel shows are still the
        // ones from before the press — and a server switched off on the host would keep reading "on" beside a refusal
        // that says it is off. The refusal is held per server and one read follows it, which asks a host to read a file
        // and starts nothing, so what the panel states is the host's answer rather than this press's silence.
        setReadError(read.refusal);
        setRefusals((current) => ({ ...current, [server]: read.refusal }));
        void load();
        return;
      }
      const listing = readMcpListing(server, body, response.status);
      if (!listing.ok) {
        setView(read.view);
        setRefusals((current) => ({ ...current, [server]: listing.refusal }));
        return;
      }
      setView(withListing(read.view, listing.listing));
      setRefusals((current) => {
        if (current[server] === undefined) return current;
        const { [server]: _dropped, ...rest } = current;
        return rest;
      });
    } catch (error) {
      if (stale()) return;
      listingRef.current.delete(server);
      setRefusals((current) => ({ ...current, [server]: { code: "operation_failed", error: errorText(error), status: 0 } }));
    } finally {
      if (conversationRef.current === at && mountedRef.current) {
        setBusy((current) => (current?.kind === "list" && current.key === server ? null : current));
      }
    }
  }, [conversationId, request, load]);

  /**
   * One grant or one revocation, written through 03b's seam and answered with the state the backend stored.
   *
   * The body comes from the helper, so granting one tool cannot silently drop that server's other grants and revoking
   * one says nothing about any other tool. A refusal leaves the conversation exactly as it was and names itself:
   * `not_listed` is the host refusing a name it does not list, not a write that was lost.
   */
  const writeGrants = useCallback(async (server: string, body: string, key: string, kind: "grant" | "revoke") => {
    const at = conversationId;
    const epoch = conversationEpochRef.current;
    const attempt = ++writeRef.current;
    // The body was derived from the view this panel held when a person pressed the control, and the seam replaces a
    // whole server's set: if the panel moved to another conversation while this write was in flight, its answer is
    // about a document nobody is looking at, so neither its state nor its refusal is applied. The write itself still
    // happened, so when the panel is showing that conversation again by then — the person switched away and back — the
    // read that answered it may predate the write, and the panel re-reads rather than showing what the write replaced.
    const stale = () => !mountedRef.current || conversationEpochRef.current !== epoch || writeRef.current !== attempt;
    const drop = () => {
      if (conversationEpochRef.current !== epoch && conversationRef.current === at) void load();
    };
    setBusy({ kind, key });
    setWriteError(null);
    try {
      const response = await request(mcpSelectionRoute(conversationId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
      const answer = await response.json().catch(() => null);
      if (stale()) { drop(); return; }
      // The answer states the conversation's whole selection, and the helper decides what it says about the listings
      // this panel already holds: a grant's answer carries one (the backend read the host to write the descriptors), a
      // revocation's asks no host at all, so an answer that states none leaves the held readings exactly as they were.
      // A panel with no view yet has nothing held, so its write is read exactly as an ordinary read would be.
      const held = viewRef.current;
      const applied = held === null
        ? readConversationMcp(conversationId, answer, response.status)
        : appliedWrite(held, answer, response.status);
      if (!applied.ok) {
        setWriteError({ key, refusal: applied.refusal });
        return;
      }
      setView(applied.view);
    } catch (error) {
      if (stale()) { drop(); return; }
      setWriteError({ key, refusal: { code: "operation_failed", error: errorText(error), status: 0 } });
    } finally {
      if (conversationRef.current === at && writeRef.current === attempt && mountedRef.current) setBusy(null);
    }
  }, [conversationId, request, load, setView]);

  // The switch above this block is the newer statement of whether `hepi.mcp` is selected, so every state shown here is
  // derived from it rather than from a read that may predate the flip; the read a flip triggers then confirms it against
  // the runtime's own offer. One object for the whole panel, so the summary, the rows, the projection and the body a
  // checkbox writes can never disagree about which conversation the person is looking at or what it selects.
  const shown = view === null ? null : { ...view, extensionSelected };
  const limit = shown === null ? undefined : availabilityLimit(shown);
  // The union of what the host configures and what this conversation holds, which is why an offline host still shows
  // every server a grant names: its configuration is unknown, its grants are not.
  const blocks = shown === null ? [] : mcpServerBlocks(shown);
  // One write at a time, whatever its kind: the seam replaces a whole server's grant set, so two writes in flight
  // would be two answers about one document and neither is trustworthy.
  const writing = busy?.kind === "grant" || busy?.kind === "revoke";

  return (
    // The four states this panel holds, as machine-readable text on the panel's own root: the same content the rows
    // above show a person, projected through the helper's allowlist. A journey reads it to state what browser state
    // **is** rather than infer it from pixels, and to prove no credential, entry value or host path is in it.
    <div className="mcp-conversation-tools" data-mcp-state={shown === null ? "" : JSON.stringify(mcpPanelState(shown))}>
      <ConfigSectionTitle>{t("mcpTools.title")}</ConfigSectionTitle>
      <div className="mcp-config-lines">
        <span className="mcp-config-line is-dim">{t("mcpTools.hint")}</span>
        {busy?.kind === "read" && <span role="status" className="mcp-config-line is-dim">{t("i18n.loading")}</span>}
        {readError !== null && (
          <span role="alert" className="mcp-config-line is-error">
            {t("mcpTools.readFailed")} {t(mcpRefusalKey(readError.code))} — {readError.error}
          </span>
        )}
        {/* A conversation's own limits come first, because they apply to every tool below and are the only thing a
            person can act on before choosing any of them. */}
        {view !== null && limit !== undefined && (
          <ConfigNotice>{t("mcpTools.availability." + limit)}</ConfigNotice>
        )}
        {view !== null && view.offered.length > 0 && (
          <span className="mcp-config-line">
            {t("mcpTools.offered")}{" "}
            {view.offered.map((name) => <code key={name} className="mcp-config-chip">{name}</code>)}
          </span>
        )}
        {/* The host's own configuration read answered nothing. That is not the host saying it configures nothing: the
            servers below are still the ones this conversation holds grants of, and their configured state is unknown. */}
        {shown !== null && !shown.serversKnown && (
          <ConfigNotice>
            {t("mcpTools.serversUnknown")}{" "}
            {shown.serversRefusal === undefined ? "" : t(mcpRefusalKey(shown.serversRefusal.code)) + " — " + shown.serversRefusal.error}
          </ConfigNotice>
        )}
        {shown !== null && shown.serversKnown && blocks.length === 0 && (
          <span className="mcp-config-line">{t("mcpTools.noServers")}</span>
        )}
        {blocks.map((block) => {
          const server = block.server;
          const listing = listingOf(shown!, server);
          const refusal = refusals[server];
          const states = mcpServerStates(shown!, server, listing);
          const key = `${server}\u0000${states.scope}`;
          const listingBusy = busy?.kind === "list" && busy.key === server;
          const revokingAll = busy?.kind === "revoke" && busy.key === `revoke:${server}`;
          return (
            <div className="mcp-conversation-server" data-server={server} data-scope={states.scope} key={key}>
              <span className="mcp-config-line">
                {/* A server only a grant names has no host entry this panel could read, so it gets no "on"/"off" dot:
                    an unknown configuration is stated in words rather than drawn as a switch position. */}
                {block.configured && <ConfigStatusDot active={block.enabled === true} />}{" "}
                <code className="mcp-config-chip">{server}</code>{" "}
                {t("mcpTools.scope." + block.scope)}
                {block.configUnknown && <> · {t("mcpTools.configUnknown")}</>}
                {block.configured && block.enabled === false && <> · {t("mcpTools.switchedOff")}</>}
              </span>
              {/* The four states, stated as four numbers, because a single badge cannot tell a person that the host
                  lists a tool this conversation never selected, or that they selected one this host switched off. */}
              <span className="mcp-config-line is-dim">
                {t("mcpTools.states", {
                  configured: block.configUnknown ? t("mcpTools.stateUnknown") : t(block.configured ? "mcpTools.stateYes" : "mcpTools.stateNo"),
                  exposed: listing === undefined ? t("mcpTools.stateUnknown") : String(states.exposed),
                  selected: String(states.selected),
                  available: states.availableUnknown ? t("mcpTools.stateUnknown") : String(states.available),
                })}
              </span>
              <span className="mcp-config-lines">
                <ConfigButton size="small" onClick={() => void listServer(server)} disabled={listingBusy || writing}>
                  {listingBusy ? t("mcpTools.listing") : t("mcpTools.list")}
                </ConfigButton>
                {/* A server only a grant names still offers its revocation, and an empty set is the whole revocation:
                    the backend answers it without asking a host, which is why it works while this host is away. */}
                {states.selected > 0 && (
                  <ConfigButton
                    size="small"
                    variant="secondary"
                    onClick={() => void writeGrants(server, mcpGrantBody(server, []), `revoke:${server}`, "revoke")}
                    disabled={revokingAll || busy?.kind === "grant" || busy?.kind === "list"}
                  >
                    {t("mcpTools.revokeAll")}
                  </ConfigButton>
                )}
                {revokingAll && <span role="status" className="mcp-config-line is-dim">{t("i18n.saving")}</span>}
                {listingBusy && <span role="status" className="mcp-config-line is-dim">{t("mcpTools.listing")}</span>}
              </span>
              {refusal !== undefined && (
                <span role="alert" className="mcp-config-line is-error">
                  {t(mcpRefusalIsNamed(refusal) ? "mcpTools.listRefused" : "mcpTools.listUnreachable")}{" "}
                  {t(mcpRefusalKey(refusal.code))} — {refusal.error}
                </span>
              )}
              {listing !== undefined && listing.tools.length === 0 && (
                <span className="mcp-config-line">{t("mcpTools.listEmpty", { total: String(listing.total) })}</span>
              )}
              {listing !== undefined && listing.truncated && (
                <span className="mcp-config-line is-warning">
                  {t("mcpTools.listTruncated", { carried: String(listing.tools.length), total: String(listing.total) })}
                </span>
              )}
              {mcpToolRows(shown!, server, listing).map((row) => {
                const control = `${row.selected ? "revoke" : "grant"}:${server}:${row.tool}`;
                const rowBusy = busy?.key === control;
                const refused = writeError?.key === control ? writeError.refusal : undefined;
                const notes: string[] = [];
                if (row.limitedBy !== undefined) notes.push(t("mcpTools.availability." + row.limitedBy));
                // A grant of a tool the newest listing does not name is the changed-server case: the person chose it,
                // the host no longer offers it, and the panel says that instead of leaving a tick with no meaning.
                if (listing !== undefined && !row.exposed && row.selected) notes.push(t("mcpTools.notListed"));
                if (row.hidden) notes.push(t("mcpTools.toolHidden"));
                if (row.switchedOff) notes.push(t("mcpTools.switchedOff"));
                if (row.descriptorChanged) notes.push(t("mcpTools.descriptorChanged"));
                if (row.schemaOmitted) notes.push(t("mcpTools.schemaOmitted"));
                if (row.readOnly) notes.push(t("mcpTools.readOnly"));
                return (
                  <div className="mcp-conversation-tool" key={control} data-tool={row.tool}>
                    <span className="mcp-config-line">
                      <label>
                        <input
                          type="checkbox"
                          checked={row.selected}
                          disabled={rowBusy || writing || revokingAll || busy?.kind === "list"}
                          // The write is exactly one grant added to, or one removed from, this server's own set; the
                          // backend replaces the set, so this is the only way to state a single tool's choice.
                          onChange={() => (row.selected
                            ? void writeGrants(server, mcpGrantRemoveBody(shown!, server, row.tool), control, "revoke")
                            : void writeGrants(server, mcpGrantAddBody(shown!, server, row.tool), control, "grant"))}
                        />{" "}
                        <code className="mcp-config-chip">{row.tool}</code>
                      </label>{" "}
                      {t("mcpTools.exposed." + (row.exposed ? "yes" : row.exposureUnknown ? "unknown" : "no"))} ·{" "}
                      {t("mcpTools.available." + (row.available ? "yes" : row.availableUnknown ? "unknown" : "no"))}
                      {notes.length === 0 ? "" : " · " + notes.join(" · ")}
                    </span>
                    {row.description === undefined ? "" : <span className="mcp-config-line is-dim">{row.description}</span>}
                    {rowBusy && <span role="status" className="mcp-config-line is-dim">{t("i18n.saving")}</span>}
                    {refused !== undefined && (
                      <span role="alert" className="mcp-config-line is-error">
                        {t("mcpTools.writeRefused")} {t(mcpRefusalKey(refused.code))} — {refused.error}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
