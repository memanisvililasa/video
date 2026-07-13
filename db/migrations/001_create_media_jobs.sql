CREATE TABLE media_jobs (
  job_id text PRIMARY KEY,
  status text NOT NULL,
  progress double precision NOT NULL,
  processing_preset text NOT NULL,
  source_metadata jsonb,
  final_result_metadata jsonb,
  canonical_error jsonb,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  cancellation_requested_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  version bigint NOT NULL,

  CONSTRAINT media_jobs_job_id_check
    CHECK (job_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  CONSTRAINT media_jobs_status_check
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled', 'expired')),
  CONSTRAINT media_jobs_processing_preset_check
    CHECK (processing_preset IN ('original', 'remux-to-mp4', 'compatible-mp4', 'audio-only')),
  CONSTRAINT media_jobs_progress_check
    CHECK (
      progress >= 0::double precision
      AND progress <= 100::double precision
      AND progress <> 'NaN'::double precision
    ),
  CONSTRAINT media_jobs_retry_count_check CHECK (retry_count >= 0),
  CONSTRAINT media_jobs_version_check CHECK (version >= 0),
  CONSTRAINT media_jobs_source_metadata_check
    CHECK (
      source_metadata IS NULL
      OR (
        jsonb_typeof(source_metadata) = 'object'
        AND pg_column_size(source_metadata) <= 262144
      )
    ),
  CONSTRAINT media_jobs_final_result_metadata_check
    CHECK (
      final_result_metadata IS NULL
      OR (
        jsonb_typeof(final_result_metadata) = 'object'
        AND pg_column_size(final_result_metadata) <= 262144
      )
    ),
  CONSTRAINT media_jobs_canonical_error_check
    CHECK (
      canonical_error IS NULL
      OR (
        jsonb_typeof(canonical_error) = 'object'
        AND pg_column_size(canonical_error) <= 262144
      )
    ),
  CONSTRAINT media_jobs_timestamp_order_check
    CHECK (
      (started_at IS NULL OR started_at >= created_at)
      AND (completed_at IS NULL OR completed_at >= COALESCE(started_at, created_at))
      AND (expires_at IS NULL OR completed_at IS NULL OR expires_at >= completed_at)
      AND (
        cancellation_requested_at IS NULL
        OR cancellation_requested_at >= created_at
      )
    ),
  CONSTRAINT media_jobs_lease_pair_check
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT media_jobs_active_shape_check
    CHECK (
      status NOT IN ('queued', 'running')
      OR (
        completed_at IS NULL
        AND expires_at IS NULL
        AND cancellation_requested_at IS NULL
        AND final_result_metadata IS NULL
        AND canonical_error IS NULL
      )
    ),
  CONSTRAINT media_jobs_queued_shape_check
    CHECK (
      status <> 'queued'
      OR (started_at IS NULL AND progress = 0 AND source_metadata IS NULL)
    ),
  CONSTRAINT media_jobs_running_shape_check
    CHECK (status <> 'running' OR started_at IS NOT NULL),
  CONSTRAINT media_jobs_completed_shape_check
    CHECK (
      status NOT IN ('ready', 'failed', 'cancelled')
      OR (completed_at IS NOT NULL AND expires_at IS NOT NULL)
    ),
  CONSTRAINT media_jobs_ready_shape_check
    CHECK (
      status <> 'ready'
      OR (
        started_at IS NOT NULL
        AND progress = 100
        AND final_result_metadata IS NOT NULL
        AND canonical_error IS NULL
        AND cancellation_requested_at IS NULL
      )
    ),
  CONSTRAINT media_jobs_failed_shape_check
    CHECK (
      status <> 'failed'
      OR (
        started_at IS NOT NULL
        AND final_result_metadata IS NULL
        AND canonical_error IS NOT NULL
        AND cancellation_requested_at IS NULL
      )
    ),
  CONSTRAINT media_jobs_cancelled_shape_check
    CHECK (
      status <> 'cancelled'
      OR (
        final_result_metadata IS NULL
        AND canonical_error IS NOT NULL
        AND cancellation_requested_at IS NOT NULL
      )
    )
);

CREATE INDEX media_jobs_status_idx ON media_jobs (status);

CREATE INDEX media_jobs_expires_at_idx
  ON media_jobs (expires_at)
  WHERE expires_at IS NOT NULL;

-- This supports lease expiry inspection only. Queue claim ordering and dispatch
-- indexes intentionally belong to Stage 5.9.4.
CREATE INDEX media_jobs_lease_expires_at_idx
  ON media_jobs (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
