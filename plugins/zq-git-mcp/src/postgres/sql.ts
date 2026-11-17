export const TABLES = ["zq_git_audit", "zq_git_branch_tips", "zq_git_blob_meta"] as const;

export const SQL = {
  tablesPresent: "SELECT t AS name, to_regclass(t) IS NOT NULL AS present FROM unnest($1::text[]) AS t",
  bindTenant: "SELECT set_config('qm.tenant_id', $1, false)",
  auditInsert: "INSERT INTO zq_git_audit (id, json) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
  tipsList:
    "SELECT branch, tip_sha, (extract(epoch FROM seen_at) * 1000)::bigint AS seen_at_ms FROM zq_git_branch_tips WHERE repo = $1",
  tipsRecord:
    "INSERT INTO zq_git_branch_tips (repo, branch, tip_sha, seen_at) VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000)) ON CONFLICT (tenant_id, repo, branch) DO NOTHING",
  tipsAdvance:
    "UPDATE zq_git_branch_tips SET tip_sha = $4, seen_at = to_timestamp($5::double precision / 1000) WHERE repo = $1 AND branch = $2 AND tip_sha = $3",
  blobMetaUpsert:
    "INSERT INTO zq_git_blob_meta (repo, oid, size_bytes, sha256, seen_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (tenant_id, repo, oid) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = COALESCE(EXCLUDED.sha256, zq_git_blob_meta.sha256), seen_at = now()",
} as const;
