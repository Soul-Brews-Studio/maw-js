/**
 * Consent primitive — public surface (#644 Phase 1).
 *
 * Three integration points use this:
 *   - maw hey      (Phase 1 — wired in cmdSend)
 *   - team-invite  (Phase 2)
 *   - plugin-install (Phase 3)
 *
 * Each calls isTrusted() before acting and requestConsent() if not.
 */
export { generatePin, hashPin, verifyPin, isValidShape, normalize, pretty } from "./pin";
export {
  type ConsentAction, type ConsentStatus, type TrustEntry, type PendingRequest,
  trustPath, pendingDir,
  loadTrust, saveTrust, recordTrust, removeTrust, isTrusted, listTrust, trustKey,
  writePending, readPending, listPending, updateStatus, deletePending, applyExpiry,
} from "./store";
export {
  type ConsentRequest, type ConsentResult,
  newRequestId, requestConsent, approveConsent, rejectConsent,
} from "./request";
export {
  type PluginInstallGateContext, type PluginInstallGateDecision,
  maybeGatePluginInstall, shortSha,
} from "./gate-plugin-install";
