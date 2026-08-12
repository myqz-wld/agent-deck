import { getDb } from './db';

const PATH_AUTHORITY_JSON = '$.__agentDeckCanonicalPathAuthorityV1';

export const PATH_AUTHORITY_PROJECTION = `CASE
  WHEN json_valid(fc.metadata_json)
    THEN COALESCE(
      json_extract(fc.metadata_json, '${PATH_AUTHORITY_JSON}'),
      'legacy'
    )
  ELSE 'unavailable'
END AS path_authority`;

interface SqlPredicate {
  readonly sql: string;
  readonly args: string[];
}

function storedAuthority(authority: string): string {
  return `canonical:${authority}`;
}

export function pathAuthorityPredicate(authority?: string): SqlPredicate {
  if (authority === undefined) return { sql: '', args: [] };
  return {
    sql: `AND CASE WHEN json_valid(fc.metadata_json)
                    THEN json_extract(fc.metadata_json, '${PATH_AUTHORITY_JSON}') = ?
                    ELSE 0 END = 1`,
    args: [storedAuthority(authority)],
  };
}

export function pathRowsMatchAuthority(
  sessionId: string,
  paths: SqlPredicate,
  authority?: string,
): boolean {
  if (authority === undefined) return true;
  const mismatch = getDb()
    .prepare(
      `SELECT 1 AS authority_mismatch
         FROM file_changes AS fc
        WHERE fc.session_id = ? AND ${paths.sql}
          AND CASE WHEN json_valid(fc.metadata_json)
                        AND json_extract(fc.metadata_json, '${PATH_AUTHORITY_JSON}') = ?
                   THEN 0 ELSE 1 END = 1
        LIMIT 1`,
    )
    .get(sessionId, ...paths.args, storedAuthority(authority));
  return mismatch === undefined;
}
