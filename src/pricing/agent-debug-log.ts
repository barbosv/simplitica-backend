import { appendFileSync } from "node:fs";

const LOG_PATH =
  process.env.PRICING_DEBUG_LOG_PATH ??
  "/Users/vitorbarbosa/Repositories/iOS/voice-invoice/.cursor/debug-33edb4.log";
const SESSION_ID = process.env.PRICING_DEBUG_SESSION_ID ?? "33edb4";

export function agentDebugLog(payload: {
  location: string;
  message: string;
  data?: Record<string, unknown>;
  hypothesisId?: string;
  runId?: string;
}): void {
  // #region agent log
  try {
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({
        sessionId: SESSION_ID,
        timestamp: Date.now(),
        ...payload,
      })}\n`,
    );
  } catch {
    // Local debug log only; ignore when path is unavailable (e.g. Cloud Run).
  }
  // #endregion
}
