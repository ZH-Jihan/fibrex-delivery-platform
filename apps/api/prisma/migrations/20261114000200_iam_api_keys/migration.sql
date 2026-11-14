-- =============================================================================
-- IAM API keys (Phase 1, commit 7d).
--
-- An integration calls with "Authorization: Bearer fbx_...". Before the key is known the
-- request has no tenant or company, and iam.api_key is hidden by row-level security
-- until both exist. iam.resolve_api_key() is the one narrow door through that wall,
-- like iam.resolve_tenant() for sign-in.
--
-- SECURITY DEFINER because it must read iam.api_key without a tenant context. It is safe
-- to expose to the app role because:
--   * it takes the SHA-256 of a key, never the key, and answers only for an exact match
--     of that hash: a caller must already hold a valid key (256 random bits) to learn
--     anything;
--   * it returns ids and the rate limit only, never the hash, name or scopes;
--   * it answers only for a key that can be used right now: not revoked, not expired,
--     not deleted, its client active and of kind api_key, its company and tenant active.
--     So revoking a key or disabling its client takes effect on the very next request.
-- search_path is pinned so the function cannot be redirected to another schema.
--
-- Additive only: no table or column changes, so the Prisma schema is unchanged.
-- =============================================================================
CREATE FUNCTION iam.resolve_api_key(p_key_hash text)
RETURNS TABLE (
  tenant_id uuid,
  company_id uuid,
  api_client_id uuid,
  api_key_id uuid,
  rate_limit_per_minute integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT k.tenant_id, k.company_id, k.api_client_id, k.id, c.rate_limit_per_minute
    FROM iam.api_key k
    JOIN iam.api_client c ON c.company_id = k.company_id AND c.id = k.api_client_id
    JOIN platform.company co ON co.tenant_id = k.tenant_id AND co.id = k.company_id
    JOIN platform.tenant t ON t.id = k.tenant_id
   WHERE k.key_hash = p_key_hash
     AND k.revoked_at IS NULL
     AND k.deleted_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND c.kind = 'api_key'
     AND c.status = 'active'
     AND c.deleted_at IS NULL
     AND co.status = 'active'
     AND co.deleted_at IS NULL
     AND t.status = 'active'
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION iam.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.resolve_api_key(text) TO fibrex_app;
