/// <reference types="node" />

/**
 * Internal-only tunnel used by the extension command (`/session-sync`) to
 * thread the single `validateSyncRoots` pass into the orchestrator without
 * re-running overlap checks after the target child roots were created.
 *
 * This module is deliberately NOT re-exported from `./sync.ts` or `./index.ts`,
 * so it is not reachable through the package's public surface (`"."` in the
 * exports map). `syncSessionsWithValidatedRoots` verifies the non-forgeable
 * token brand as well as the complete validated root tuple before trusting
 * it; direct public `syncSessions` callers always validate the roots
 * themselves.
 */
export { syncSessionsWithValidatedRoots } from "./sync-orchestrator.ts";
