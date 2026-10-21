import { parseFrames, type ExecuteFailureCode, type ExecuteRequest, type ExecuteResult, type OutputSink } from "./execution.ts";
import { HostTransportError, type GatewayHostTransport, type HostRequestOptions } from "./host-client.ts";

/**
 * How long an abort may take: a cancellation that cannot reach the gateway inside this window must not hold the
 * caller's abort path open, and an abort whose answer is lost is reported as unknown rather than sent again.
 */
const ABORT_TIMEOUT_MS = 5_000;

/** The largest unterminated frame retained: a gateway that never ends a line is a broken answer, not more output. */
const MAX_FRAME_CHARS = 2 * 1024 * 1024;

/**
 * Execution and cancellation: one call runs a command and delivers its output as it arrives, and an abort stops a call
 * that is running or refuses one that has not started.
 *
 * Both are mutations. A lost answer on either leaves the outcome unknown — the command may have run, the abort may have
 * arrived — so nothing here is retried. A definitive gateway refusal is the gateway's own answer and is reported as
 * that, not as uncertainty.
 */
export type ProcessCapability = {
	/**
	 * Run one call, handing each output frame to `sink` as it arrives and awaiting what it returns, so a caller that
	 * commits progress holds the next frame back. The result frame ends the call.
	 */
	execute(request: ExecuteRequest, sink?: OutputSink, options?: HostRequestOptions): Promise<ExecuteResult>;
	/** Ask the gateway to stop `callId`. `ok` is false when the gateway knows no such running call. */
	abort(callId: string, options?: HostRequestOptions): Promise<{ readonly ok: boolean }>;
};

/** A failure the caller acts on, in the execution domain's own spelling. */
function failed(code: ExecuteFailureCode, callId?: string, message?: string): ExecuteResult {
	return { ok: false, code, ...(callId === undefined ? {} : { callId }), ...(message === undefined ? {} : { message }) };
}

/**
 * What a transport failure means to a caller of this capability. A connection that never opened proves nothing ran; a
 * caller's own cancellation and an imposed timeout are named as themselves; anything else — a connection that broke, a
 * gateway that restarted mid-call — leaves the outcome unknown, because the command may have run to completion.
 */
function lost(error: unknown, callId: string): ExecuteResult {
	if (!(error instanceof HostTransportError)) return failed("outcome-unknown", callId);
	if (error.code === "gateway_offline") return failed("gateway_offline", callId);
	if (error.code === "timeout") return failed("timeout", callId);
	if (error.code === "aborted") return failed("aborted", callId);
	if (error.code === "unauthorized") return failed("unauthorized", callId);
	return failed("outcome-unknown", callId);
}

/** The process capability over one host transport: it frames the request and reads the answer, and owns no policy. */
export function createProcessCapability(transport: GatewayHostTransport): ProcessCapability {
	return {
		async execute(request, sink, options = {}) {
			let response: Response;
			try {
				response = await transport.send({
					path: "/v1/execute",
					body: JSON.stringify(request),
					headers: { "content-type": "application/json" },
					policy: "mutation",
					// The answer streams for as long as the command runs and the transport's timeout covers the whole
					// body, so an execution imposes none: its bound is the command's own timeout and the abort path.
					timeoutMs: options.timeoutMs ?? 0,
					...(options.signal === undefined ? {} : { signal: options.signal }),
				});
			} catch (error) {
				return lost(error, request.callId);
			}
			// A gateway that refuses or answers with no body at all never ran the call in a way its answer describes.
			if (!response.ok || response.body === null) return failed(response.status === 401 ? "unauthorized" : "outcome-unknown", request.callId);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					let chunk: ReadableStreamReadResult<Uint8Array>;
					try {
						chunk = await reader.read();
					} catch {
						// The stream broke mid-call: the command may have run to completion, so nothing may be concluded.
						return failed("outcome-unknown", request.callId, "the gateway response ended before the call settled");
					}
					if (chunk.done) break;
					// A byte split across chunks is held until the rest arrives, so text is never cut mid-character.
					const parsed = parseFrames(buffer + decoder.decode(chunk.value, { stream: true }));
					buffer = parsed.rest;
					if (buffer.length > MAX_FRAME_CHARS) throw new Error("oversized gateway frame");
					for (const frame of parsed.frames) {
						// The result frame ends the call, and the output already delivered settled before it is answered.
						if (frame.type === "result") return frame.result;
						// Serialized: a frame is not handed over until the previous callback settled.
						await sink?.({ stream: frame.stream, text: frame.text, ...(frame.skipped === undefined ? {} : { skipped: frame.skipped }) });
					}
				}
				return failed("outcome-unknown", request.callId, "the gateway response ended without a result");
			} catch {
				return failed("outcome-unknown", request.callId, "invalid or interrupted gateway response");
			} finally {
				await reader.cancel().catch(() => undefined);
			}
		},

		async abort(callId, options = {}) {
			return await transport.json<{ readonly ok: boolean }>({
				path: "/v1/abort",
				body: { callId },
				policy: "mutation",
				timeoutMs: options.timeoutMs ?? ABORT_TIMEOUT_MS,
				...(options.signal === undefined ? {} : { signal: options.signal }),
				decode: (value) => {
					const ok = (value as { ok?: unknown } | null)?.ok;
					if (typeof ok !== "boolean") throw new Error("an abort answer names no outcome");
					return { ok };
				},
			});
		},
	};
}
