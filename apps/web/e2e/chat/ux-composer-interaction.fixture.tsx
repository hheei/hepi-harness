/**
 * Browser fixture for the composer's own interaction ticket: the editor behaviour a DOM-less test cannot state.
 *
 * It mounts the production `ChatInput` inside a real workbench connection — the same provider a page gives it — and
 * states only the transport underneath: the file index answers with a small listing, and the send seams record what the
 * composer dispatched. Everything the driver reads is therefore what the shipped composer did with real keys, real
 * composition events, real paste and the browser's own undo stack.
 */
import { StrictMode, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatInput } from "@hepi/ui/components/ChatInput";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";

export interface ComposerGate {
  /** Every send the composer dispatched, in order, with the pictures it carried. */
  readonly sends: { text: string; images: number }[];
  /** Every queued steer and follow-up, in order. */
  readonly queued: { mode: string; text: string }[];
  /** Change the key the composer holds its draft under, as a promotion or a move does. */
  rekey(previousKey: string, nextKey: string): void;
  /** Change the draft key the surface passes, as moving the composer to another folder does. */
  moveTo(key: string): void;
  /** The live text the fixture believes the composer holds, read from the page's own state. */
  readonly draftKeys: string[];
}

declare global {
  interface Window { __composer?: ComposerGate }
}

const sends: ComposerGate["sends"] = [];
const queued: ComposerGate["queued"] = [];
const draftKeys: string[] = [];

/** The listing the `@` menu ranks: a small workspace, so a completion is an observation rather than a wait. */
const INDEX = {
  files: ["README.md", "src/app.ts", "src/lib/util.ts", "docs/guide.md"],
};

const client = createClient({
  origin: window.location.origin,
  credential: { kind: "cookie" },
  fetch: async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname === "/api/file-index") {
      return new Response(JSON.stringify({ files: INDEX.files, truncated: false }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  },
  createSource: () => ({ onmessage: null, close() {} }) as unknown as EventSource,
});
const connection = workbenchConnection(client, { profile: "composer", backendId: "composer", accountScope: "composer" });

let changeDraftKey: (key: string) => void = () => {};

/** The key this fixture's composer is on. Kept across a reload, because the point of the draft is that it survives one. */
const KEY_ENTRY = "composer-fixture-key";

function Fixture() {
  const [draftKey, setDraftKeyState] = useState(() => window.sessionStorage.getItem(KEY_ENTRY) ?? "session-one");
  const setDraftKey = (key: string) => {
    window.sessionStorage.setItem(KEY_ENTRY, key);
    setDraftKeyState(key);
  };
  const [streaming, setStreaming] = useState(false);
  const ref = useRef<import("@hepi/ui/components/ChatInput").ChatInputHandle | null>(null);
  changeDraftKey = setDraftKey;
  draftKeys.push(draftKey);

  const send = useCallback((text: string, images?: readonly { data: string }[]) => {
    sends.push({ text, images: images?.length ?? 0 });
  }, []);
  const steer = useCallback((text: string) => { queued.push({ mode: "steer", text }); }, []);
  const followUp = useCallback((text: string) => { queued.push({ mode: "followUp", text }); }, []);

  return (
    <div>
      <ChatInput
        ref={ref}
        onSend={send}
        onAbort={() => {}}
        onSteer={streaming ? steer : undefined}
        onFollowUp={streaming ? followUp : undefined}
        isStreaming={streaming}
        draftKey={draftKey}
        cwd="/workspace/ws-1"
        inputHistory={["an earlier question"]}
        slashCommands={[{ name: "help", description: "What this deployment can do", source: "extension" }]}
        onBuiltinCommand={async () => ({ handled: false })}
      />
      <button type="button" data-fixture-stream onClick={() => setStreaming((value) => !value)}>
        streaming
      </button>
      <button
        type="button"
        data-fixture-rekey
        onClick={() => {
          ref.current?.rekeyDraft(draftKey, draftKey + "-promoted");
          setDraftKey(draftKey + "-promoted");
        }}
      >
        promote
      </button>
      <button type="button" data-fixture-move onClick={() => setDraftKey("session-two")}>
        move
      </button>
    </div>
  );
}

window.__composer = {
  get sends() { return sends; },
  get queued() { return queued; },
  rekey(previousKey: string, nextKey: string) { changeDraftKey(nextKey); },
  moveTo(key: string) { changeDraftKey(key); },
  get draftKeys() { return draftKeys; },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <WorkbenchConnectionProvider value={connection}>
        <Fixture />
      </WorkbenchConnectionProvider>
    </I18nProvider>
  </StrictMode>,
);
