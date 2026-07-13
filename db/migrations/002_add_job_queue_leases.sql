ALTER TABLE media_jobs
  ADD COLUMN source_url text,
  ADD COLUMN format_id text;

ALTER TABLE media_jobs
  DROP CONSTRAINT media_jobs_queued_shape_check,
  ADD CONSTRAINT media_jobs_queued_shape_check
    CHECK (
      status <> 'queued'
      OR (started_at IS NULL AND source_metadata IS NULL)
    ),
  ADD CONSTRAINT media_jobs_execution_payload_pair_check
    CHECK ((source_url IS NULL) = (format_id IS NULL)),
  ADD CONSTRAINT media_jobs_source_url_check
    CHECK (
      source_url IS NULL
      OR (
        length(source_url) BETWEEN 1 AND 2048
        AND source_url ~ '^https?://'
        AND source_url !~ '[[:cntrl:]]'
      )
    ),
  ADD CONSTRAINT media_jobs_format_id_check
    CHECK (format_id IS NULL OR format_id ~ '^[a-zA-Z0-9._-]{1,64}$'),
  ADD CONSTRAINT media_jobs_lease_owner_format_check
    CHECK (lease_owner IS NULL OR lease_owner ~ '^worker_[a-f0-9]{32}$'),
  ADD CONSTRAINT media_jobs_lease_status_check
    CHECK (
      status = 'running'
      OR (lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
  ADD CONSTRAINT media_jobs_terminal_payload_check
    CHECK (
      status NOT IN ('ready', 'failed', 'cancelled', 'expired')
      OR (source_url IS NULL AND format_id IS NULL)
    );

DROP INDEX media_jobs_lease_expires_at_idx;

CREATE INDEX media_jobs_claim_fifo_idx
  ON media_jobs (created_at, job_id)
  WHERE
    status = 'queued'
    AND cancellation_requested_at IS NULL
    AND expires_at IS NULL
    AND source_url IS NOT NULL
    AND format_id IS NOT NULL;

CREATE INDEX media_jobs_expired_lease_idx
  ON media_jobs (lease_expires_at, job_id)
  WHERE
    status = 'running'
    AND lease_expires_at IS NOT NULL;
