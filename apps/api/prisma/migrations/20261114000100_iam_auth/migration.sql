-- =============================================================================
-- IAM authentication support (Phase 1, commit 7).
--
-- Signing in starts before the caller has a tenant: the request names the tenant by its
-- slug ("fibrex"), and platform.tenant is hidden by row-level security until a tenant
-- context exists. iam.resolve_tenant() is the one narrow door through that wall.
--
-- SECURITY DEFINER because it must read platform.tenant without a tenant context. It is
-- safe to expose to the app role because:
--   * it takes one value and returns one id, never a row: nothing else about a tenant
--     (name, plan, status) can be read through it;
--   * it answers only for active, not-deleted tenants, so a suspended tenant cannot sign in;
--   * a tenant id on its own opens nothing: every table still demands credentials that
--     belong to that tenant.
-- search_path is pinned so the function cannot be redirected to another schema.
--
-- Additive only: no table or column changes, so the Prisma schema is unchanged.
-- =============================================================================
CREATE FUNCTION iam.resolve_tenant(p_slug text) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id
    FROM platform.tenant t
   WHERE t.slug = p_slug
     AND t.status = 'active'
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION iam.resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.resolve_tenant(text) TO fibrex_app;
