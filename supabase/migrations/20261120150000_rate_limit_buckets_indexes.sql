-- Additive indexes for shared PostgreSQL rate_limit_buckets scope checks and expired-row pruning.
CREATE INDEX IF NOT EXISTS rate_limit_buckets_scope_reset_idx
  ON public.rate_limit_buckets (scope, reset_at);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_idx
  ON public.rate_limit_buckets (reset_at);
