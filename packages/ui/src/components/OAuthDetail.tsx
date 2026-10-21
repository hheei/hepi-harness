"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderLoginInfo } from "@hepi/protocol/gateway";
import { capabilityNoticeKey, useCapabilityServed } from "../lib/capability-availability";
import { useApiRequest } from "../lib/api-request";
import { providerAuthNotice, type ProviderAuthNotice, type ProviderPanelRow } from "../lib/provider/provider-auth";
import {
  PROVIDER_LOGIN_POLL_INTERVAL_MS,
  providerAnswerBody,
  providerFlowEnded,
  providerFlowOutcome,
  providerLoginRefusal,
  providerSignInRoute,
  providerSignOutRoute,
  readProviderFlow,
  type ProviderFlowOutcome,
} from "../lib/provider/provider-login";
import { providerFlowView } from "../lib/provider/provider-flow-view";
import { useI18n } from "../hooks/useI18n";
import { EnabledModelsSection, type EnabledModelsController } from "./EnabledModelsSection";
import {
  ConfigButton,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigSectionTitle,
} from "./SettingsUi";
import { OAuthPastePanel } from "./OAuthPastePanel";
import { ProviderUsageSummary } from "./ProviderUsageSummary";

/**
 * One provider's subscription sign-in, followed a step at a time.
 *
 * The flow belongs to the execution host, not to this component: it is started by a call, runs while the person finishes
 * in another browser, and keeps running after this panel, this tab, or this connection is gone. So the panel reads it
 * rather than watching it — the same reason the MCP surface polls (docs/mcp-on-the-web-host.md). A stream would turn a
 * reload into a cancelled login, and a browser flow that runs detached has no socket that could mean anything else.
 *
 * The loop is one read, then one timer, then the next read: never a request held open, and nothing running while a step
 * waits for a person. Each read answers the step the host is on, which is the step any other window of the same caller
 * is shown.
 *
 * Nothing here holds a credential. What a person types goes into one request body and is dropped immediately — including
 * when the host refuses it, because a retry is a re-typed answer, never a remembered one. What a flow produced is written
 * by the host and comes back only as the listing's own row. A device code and an authorization address are shown whole on
 * purpose: each is only useful next to the page it is typed into, and both die with the flow.
 *
 * A panel that unmounts mid-flow leaves the flow alone. A panel that mounts reads the route before it starts anything, so
 * a reload rejoins the sign-in already running instead of opening a second browser address against one account.
 */

type PanelState = {
  /** The step a person can act on, or the last one they could. */
  readonly step?: ProviderLoginInfo;
  /** Why the last call was refused, in the host's own words. */
  readonly notice?: ProviderAuthNotice;
  /** How the flow ended, once it has. */
  readonly outcome?: ProviderFlowOutcome;
  /** A start is on its way. */
  readonly starting?: boolean;
};

const IDLE: PanelState = {};

export function OAuthDetail({ provider, onRefresh, enabledModels }: {
  provider: ProviderPanelRow; onRefresh: () => void; enabledModels: EnabledModelsController;
}) {
  const { t } = useI18n();
  const request = useApiRequest();

  /**
   * Whether this connection serves the sign-in route, asked of the very path the Login control posts to.
   *
   * Sign-in is a separate capability from storing a key, so it is asked of its own route and not of the listing's: an
   * entry that writes API keys and serves no flows must not be shown a Login control whose only answer is a refusal.
   */
  const signInServed = useCapabilityServed(providerSignInRoute(provider.id));
  const signInNotice = capabilityNoticeKey(signInServed, "models.providerSignInUnavailable");

  const [state, setState] = useState<PanelState>(IDLE);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  /** The flow this panel follows: its id is the query of every read, answer and cancel. */
  const flowId = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Whether this panel is following a flow, as opposed to having reported one that ended. */
  const following = useRef(false);
  /** One read or action at a time, whichever direction it came from. */
  const inFlight = useRef(false);
  const mounted = useRef(true);
  /** The state as it stands, for a callback that must keep the step it is refusing to lose. */
  const last = useRef<PanelState>(IDLE);
  last.current = state;

  const show = useCallback((next: PanelState): void => {
    last.current = { ...next };
    if (mounted.current) setState(next);
  }, []);

  const clear = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  /** Read the flow, answer it, or end it — always the route that names this provider and the flow being followed. */
  const call = useCallback(async (init: RequestInit): Promise<{ status: number; body: unknown } | undefined> => {
    try {
      const response = await request(providerSignInRoute(provider.id, flowId.current), init);
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) {
      // A request that never arrived says nothing about the flow or the deployment: the work is the host's and continues
      // regardless of this one path. The panel keeps the step it had and asks again on the next tick.
      return { status: 0, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }, [provider.id, request]);

  const read = useRef<() => Promise<void>>(async () => {});
  const resume = useCallback((): void => {
    clear();
    if (following.current) timer.current = setTimeout(() => void read.current(), PROVIDER_LOGIN_POLL_INTERVAL_MS);
  }, [clear]);

  /**
   * Take a step this host reported as the panel's own, and follow it or stop on it.
   *
   * The host's id replaces whatever this panel believed, which is what lets a read that joined another window's flow, or a
   * start that returned one already running, drive the same steps.
   */
  const adopt = useCallback((step: ProviderLoginInfo): void => {
    flowId.current = step.flowId;
    if (!providerFlowEnded(step.phase)) {
      following.current = true;
      show({ step, notice: undefined });
      resume();
      return;
    }
    following.current = false;
    flowId.current = undefined;
    clear();
    const outcome = providerFlowOutcome(step);
    show({ outcome });
    // A flow that stored a credential changed the listing this panel sits in, so the panel re-reads that rather than
    // reporting a success its own rows have not caught up with.
    if (outcome.kind === "stored") onRefresh();
  }, [clear, onRefresh, resume, show]);

  /**
   * One read of the followed flow.
   *
   * Every outcome re-arms the next read except the two that end following: a flow this host reports as over, and an id
   * that no longer exists. A refusal that is neither — a host that could not be reached, an answer refused — is shown and
   * retried on the tick, because the bound on it is the host's own deadline.
   */
  const poll = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const answer = await call({ headers: { accept: "application/json" } });
      if (answer === undefined || !mounted.current) return;
      const refusal = providerLoginRefusal(answer, answer.body);
      if (refusal !== undefined) {
        if (answer.status === 404) {
          // The host holds this flow no more: it ended past the window it stays readable in, or the host service
          // restarted. Nothing is left to follow, and the next action is a new sign-in.
          following.current = false;
          flowId.current = undefined;
          clear();
          show({ outcome: { kind: "ended", phase: "expired", detail: refusal.detail } });
          return;
        }
        show({ ...(last.current.step === undefined ? {} : { step: last.current.step }), notice: refusal });
        resume();
        return;
      }
      const step = readProviderFlow(answer.body);
      if (step === undefined) {
        show({ notice: providerAuthNotice(undefined, "the sign-in route answered without a sign-in") });
        resume();
        return;
      }
      adopt(step);
    } finally {
      inFlight.current = false;
    }
  }, [adopt, call, clear, resume, show]);
  read.current = poll;

  /**
   * Start a sign-in, or rejoin the one already running for this provider.
   *
   * A read goes first: this host keeps one open flow per caller and provider, so a lost response, a double click, or a
   * second window all land on the same flow instead of opening a second browser address against one account.
   *
   * Only a flow that is *still open* is rejoined. A host keeps an ended flow readable for a while so a late poll learns what
   * happened to it, and that record is an outcome, not a sign-in to follow: adopting it here would show the panel its own
   * last cancel again and send no start, which is a Login button that does nothing for the length of that window. Falling
   * through is safe because the start is the host's idempotent one — it answers the flow already open for this caller and
   * provider, or opens a new one.
   */
  const start = useCallback(async (): Promise<void> => {
    setInput("");
    show({ ...last.current, starting: true, notice: undefined });
    const existing = await call({ headers: { accept: "application/json" } });
    if (mounted.current && existing !== undefined) {
      // A refused read is no reason to skip the start: it says nothing about whether a flow is open.
      const found = providerLoginRefusal(existing, existing.body) === undefined ? readProviderFlow(existing.body) : undefined;
      if (found !== undefined && !providerFlowEnded(found.phase)) { adopt(found); return; }
    }
    // A start carries no data, but this entrance reads a POST as a JSON request — the same rule MCP sign-in
    // answers — so it arrives with an empty object rather than no body at all.
    const started = await call({ method: "POST", body: "{}" });
    if (!mounted.current) return;
    const refusal = started === undefined ? undefined : providerLoginRefusal(started, started.body);
    if (refusal !== undefined) {
      // The start itself failed, so nothing is being followed: the panel goes back to idle with the reason against it,
      // which is the difference between a refused sign-in and one running somewhere this panel cannot read.
      show({ notice: refusal });
      return;
    }
    const step = started === undefined ? undefined : readProviderFlow(started.body);
    if (step === undefined) { show({ notice: providerAuthNotice(undefined, "the sign-in route answered without a sign-in") }); return; }
    adopt(step);
  }, [adopt, call, show]);

  /** Hand the open question its answer, and show the step the host moved to. */
  const answer = useCallback(async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed === "" || flowId.current === undefined) return;
    // Cleared before the request rather than after: a refused code is never left in a browser's DOM as though it still
    // had a use.
    setInput("");
    const sent = await call({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: providerAnswerBody(trimmed),
    });
    if (!mounted.current || sent === undefined) return;
    const refusal = providerLoginRefusal(sent, sent.body);
    if (refusal !== undefined) {
      show({ ...(last.current.step === undefined ? {} : { step: last.current.step }), notice: refusal });
      resume();
      return;
    }
    const step = readProviderFlow(sent.body);
    if (step === undefined) { show({ notice: providerAuthNotice(undefined, "the sign-in route answered without a sign-in") }); return; }
    adopt(step);
  }, [adopt, call, resume, show]);

  /**
   * Cancel this flow.
   *
   * The host ends it and reports the phase it settled into, so a person sees the cancel rather than the panel quietly
   * losing its question. A cancel the host refused is shown as that refusal, and following continues.
   */
  const cancel = useCallback(async (): Promise<void> => {
    if (flowId.current === undefined) {
      following.current = false;
      clear();
      show(IDLE);
      return;
    }
    const ended = await call({ method: "DELETE" });
    if (!mounted.current || ended === undefined) return;
    const refusal = providerLoginRefusal(ended, ended.body);
    if (refusal !== undefined) { show({ ...(last.current.step === undefined ? {} : { step: last.current.step }), notice: refusal }); return; }
    const step = readProviderFlow(ended.body);
    if (step === undefined) { show(IDLE); return; }
    adopt(step);
  }, [adopt, call, clear, show]);

  /** Drop the stored credential. A sign-out names the account, never a flow, and is served even where sign-in is not. */
  const signOut = useCallback(async (): Promise<void> => {
    following.current = false;
    flowId.current = undefined;
    clear();
    try {
      const response = await request(providerSignOutRoute(provider.id), { method: "POST", headers: { accept: "application/json" }, body: "{}" });
      const body = await response.json().catch(() => null);
      const refusal = providerLoginRefusal({ status: response.status }, body);
      show(refusal === undefined ? IDLE : { notice: refusal });
    } catch (error) {
      show({ notice: providerAuthNotice(undefined, error instanceof Error ? error.message : String(error)) });
    }
    onRefresh();
  }, [clear, onRefresh, provider.id, request, show]);

  // A provider change is a different sign-in: stop following, forget the id, and let the read below look for a flow on
  // the provider now selected rather than carrying one across a the caller never started here.
  useEffect(() => {
    mounted.current = true;
    following.current = false;
    flowId.current = undefined;
    clear();
    setState(IDLE);
    last.current = IDLE;
    setInput("");
    return () => {
      mounted.current = false;
      clear();
    };
  }, [clear, provider.id]);

  /**
   * Rejoin an open flow when this panel mounts.
   *
   * Only when the route serves sign-in: a host with no provider surface would answer this read with its own limit, and a
   * notice about a deployment on a panel that offers no sign-in is noise a person never asked for.
   */
  useEffect(() => {
    if (signInServed !== true) return;
    let cancelled = false;
    void (async () => {
      const answerToRead = await call({ headers: { accept: "application/json" } });
      if (cancelled || answerToRead === undefined) return;
      const refusal = providerLoginRefusal(answerToRead, answerToRead.body);
      if (refusal !== undefined) return;
      const found = readProviderFlow(answerToRead.body);
      if (found === undefined || providerFlowEnded(found.phase)) return;
      adopt(found);
    })();
    return () => { cancelled = true; };
  }, [adopt, call, signInServed]);

  const step = state.step;
  const view = step === undefined ? undefined : providerFlowView(step);
  /** The step that answers through a field: the browser address waiting to be pasted back, or an open question. */
  const paste = view !== undefined && (view.kind === "browser" || view.kind === "answer") ? view : undefined;
  // The field and its button are held while an answer is on its way: the question it answered is gone either way, and a
  // second submit of the same code is a refused answer the person has to read their way out of.
  const answering = state.step !== undefined && inFlight.current && providerFlowEnded(state.step.phase) === false;
  // A step that asks for a value takes the focus to its field, once per step rather than once per read of it.
  const asksForValue = view !== undefined && view.kind !== "waiting" && view.kind !== "progress" && view.kind !== "device_code" && view.kind !== "select";
  useEffect(() => {
    if (!asksForValue) return;
    const focus = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(focus);
  }, [asksForValue, step?.flowId]);
  const working = step !== undefined && !providerFlowEnded(step.phase);
  const settled = state.outcome !== undefined || state.notice !== undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: provider.loggedIn && !working && !settled ? 0 : 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigSectionTitle>{t("i18n.subscription")}</ConfigSectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "#4ade80" : "var(--border)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
              {provider.loggedIn ? t("i18n.connected") : t("i18n.notConnected")}
            </span>
          </div>
          {working ? (
            <ConfigButton size="small" onClick={() => void cancel()}>{t("i18n.cancel")}</ConfigButton>
          ) : signInServed === false ? null : (
            <>
              <ConfigButton variant="primary" size="small" onClick={() => void start()}>
                {provider.loggedIn ? t("i18n.relogin") : t("i18n.login")}
              </ConfigButton>
              {provider.loggedIn && (
                <ConfigButton variant="danger" size="small" onClick={() => void signOut()}>{t("i18n.disconnect")}</ConfigButton>
              )}
            </>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <div style={{ minHeight: provider.loggedIn && !working && !settled ? 0 : 48 }}>
        {working && (view === undefined || view.kind === "waiting") && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("models.providerAuth.flowRunning")}</p>
        )}
        {!working && !settled && signInNotice !== undefined && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t(signInNotice)}</p>
        )}
        {!working && !settled && !state.starting && signInServed === true && !provider.loggedIn && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t("models.providerAuth.signInIdle", { name: provider.name })}
          </p>
        )}
        {state.notice !== undefined && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>
            {state.notice.key === undefined ? "" : t(state.notice.key)}
            {state.notice.detail === "" ? "" : " " + state.notice.detail}
          </p>
        )}
        {state.outcome !== undefined && (
          state.outcome.kind === "stored" ? (
            <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{t("i18n.connectedSuccessfully")}</p>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t(state.outcome.key ?? "models.providerAuth.flowEnded")}
              {state.outcome.detail === "" ? "" : " " + state.outcome.detail}
            </p>
          )
        )}
        {working && view !== undefined && view.kind === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{view.message}</p>
        )}
        {working && view !== undefined && view.kind === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("models.providerAuth.deviceInstructions")}</p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {view.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={view.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>{view.verificationUri}</a>
              {view.expiresInSeconds === undefined ? "" : " " + t("models.providerAuth.expiresIn", { minutes: Math.ceil(view.expiresInSeconds / 60) })}
            </p>
          </div>
        )}
        {working && view !== undefined && view.kind === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{view.message}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {view.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => void answer(option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                  {option.description === undefined ? "" : <span style={{ color: "var(--text-dim)" }}> — {option.description}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {working && paste !== undefined && (
          <OAuthPastePanel
            message={paste.message}
            hint={
              paste.link === undefined ? undefined : (
                <>{t("models.providerAuth.browserHint")} <a href={paste.link} target="_blank" rel="noopener noreferrer">{paste.link}</a></>
              )
            }
            value={input}
            placeholder={paste.kind === "answer" ? paste.placeholder ?? t("models.providerAuth.answerPlaceholder") : t("models.providerAuth.answerPlaceholder")}
            submitLabel={t("i18n.submit")}
            disabled={answering}
            inputRef={inputRef}
            onValueChange={setInput}
            onSubmit={() => void answer(input)}
          />
        )}
      </div>

      <ProviderUsageSummary providerId={provider.id} enabled={provider.loggedIn} />
      {provider.loggedIn && <EnabledModelsSection providerId={provider.id} controller={enabledModels} />}
    </div>
  );
}
