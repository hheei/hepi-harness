/**
 * Streaming output rate (tokens/second) for the live assistant message.
 *
 * The rate is measured over a sliding window of token samples rather than as a
 * cumulative average from the first token. A cumulative average divides the
 * *whole* token count by the elapsed time since the first sample, so a head
 * start already present when sampling begins (a snapshot adopted mid-stream, or
 * simply the first tick's worth of content) is charged to a denominator that
 * does not cover it. That makes the first reading far too high and then decays
 * as `headStart / elapsed`. A sliding window compares two samples inside the
 * window, so pre-existing content cancels out and the reading tracks the
 * current rate instead of a long-run mean.
 */

export interface TpsSample {
  /** Milliseconds, same clock as the other samples. */
  at: number;
  /** Cumulative estimated output tokens at `at`. Monotonic within a generation. */
  tokens: number;
}

/** How far back the rate is measured. */
export const TPS_WINDOW_MS = 3000;
/** The shortest span that can produce a reading, so a burst of samples cannot divide by ~0. */
export const TPS_MIN_SPAN_MS = 600;
/** Defensive cap: the window never needs more than this many 300ms samples. */
const TPS_MAX_SAMPLES = 64;

/** Append a sample and drop everything that fell out of the window. */
export function pushTpsSample(
  samples: readonly TpsSample[],
  sample: TpsSample,
  windowMs: number = TPS_WINDOW_MS,
): TpsSample[] {
  const cutoff = sample.at - windowMs;
  const next = samples.filter((existing) => existing.at >= cutoff);
  next.push(sample);
  return next.length > TPS_MAX_SAMPLES ? next.slice(next.length - TPS_MAX_SAMPLES) : next;
}

/**
 * Tokens per second across the window, or `null` when the samples cannot support
 * a reading yet: fewer than two samples, a span shorter than `minSpanMs`, or a
 * non-positive token delta (an authoritative block replacement can shrink the
 * estimate). A hidden reading is preferable to a fabricated one.
 */
export function computeTps(
  samples: readonly TpsSample[],
  minSpanMs: number = TPS_MIN_SPAN_MS,
): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.at - first.at;
  if (spanMs < minSpanMs) return null;
  const deltaTokens = last.tokens - first.tokens;
  if (deltaTokens <= 0) return null;
  return deltaTokens / (spanMs / 1000);
}
