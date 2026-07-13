ALTER TABLE media_jobs
  ADD COLUMN available_at timestamptz,
  ADD COLUMN deadline_at timestamptz;

UPDATE media_jobs
SET available_at = created_at
WHERE status = 'queued';

ALTER TABLE media_jobs
  ADD CONSTRAINT media_jobs_available_at_state_check
    CHECK (
      (status = 'queued' AND available_at IS NOT NULL)
      OR (status <> 'queued' AND available_at IS NULL)
    ),
  ADD CONSTRAINT media_jobs_deadline_at_state_check
    CHECK (deadline_at IS NULL OR status IN ('queued', 'running')),
  ADD CONSTRAINT media_jobs_lifecycle_timing_check
    CHECK (
      (available_at IS NULL OR available_at >= created_at)
      AND (deadline_at IS NULL OR deadline_at >= created_at)
      AND (
        available_at IS NULL
        OR deadline_at IS NULL
        OR available_at <= deadline_at
      )
    );

DROP INDEX media_jobs_claim_fifo_idx;

CREATE INDEX media_jobs_claim_fifo_idx
  ON media_jobs (available_at, created_at, job_id)
  WHERE
    status = 'queued'
    AND cancellation_requested_at IS NULL
    AND expires_at IS NULL
    AND source_url IS NOT NULL
    AND format_id IS NOT NULL;

CREATE INDEX media_jobs_active_deadline_idx
  ON media_jobs (deadline_at, job_id)
  WHERE status IN ('queued', 'running') AND deadline_at IS NOT NULL;

CREATE TABLE media_lifecycle_state (
  singleton_key smallint PRIMARY KEY DEFAULT 1,
  last_recovery_at timestamptz,
  last_reconciliation_at timestamptz,
  last_expiration_at timestamptz,
  last_full_sweep_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  version bigint NOT NULL DEFAULT 0,

  CONSTRAINT media_lifecycle_state_singleton_check CHECK (singleton_key = 1),
  CONSTRAINT media_lifecycle_state_timestamp_order_check CHECK (
    (last_recovery_at IS NULL OR last_recovery_at <= updated_at)
    AND (last_reconciliation_at IS NULL OR last_reconciliation_at <= updated_at)
    AND (last_expiration_at IS NULL OR last_expiration_at <= updated_at)
    AND (last_full_sweep_at IS NULL OR last_full_sweep_at <= updated_at)
  ),
  CONSTRAINT media_lifecycle_state_version_check CHECK (version >= 0)
);

INSERT INTO media_lifecycle_state (singleton_key) VALUES (1);
