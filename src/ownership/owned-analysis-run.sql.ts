import type { OwnershipContext } from "./ownership-context.types.js";

/**
 * Canonical SQL ownership predicate for all owner-protected analysis reads and
 * mutations. The caller must alias analysis_runs as `run`.
 */
export function ownedAnalysisRunClause(
  analysisRunId: string,
  owner: OwnershipContext
) {
  return owner.actorType === "anonymous"
    ? {
        clause: `
          run.anonymous_session_id = $2
          AND run.user_id IS NULL
          AND run.workspace_id IS NULL
        `,
        values: [analysisRunId, owner.anonymousSessionId]
      }
    : {
        clause: `
          (
            (run.user_id = $2 AND run.workspace_id = $3)
            OR (
              run.user_id IS NULL
              AND run.workspace_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM anonymous_sessions AS claimed_session
                WHERE claimed_session.anonymous_session_id =
                      run.anonymous_session_id
                  AND claimed_session.claimed_by_user_id = $2
                  AND claimed_session.claimed_workspace_id = $3
                  AND claimed_session.claimed_at IS NOT NULL
              )
            )
          )
        `,
        values: [analysisRunId, owner.userId, owner.workspaceId]
      };
}
