ALTER TABLE media_jobs
  ADD COLUMN lease_attempt_id text;

UPDATE media_jobs
SET lease_attempt_id = 'attempt_' || md5(
  job_id || ':' || lease_owner || ':' || lease_expires_at::text || ':' || version::text
)
WHERE lease_owner IS NOT NULL;

ALTER TABLE media_jobs
  DROP CONSTRAINT media_jobs_lease_pair_check,
  ADD CONSTRAINT media_jobs_lease_tuple_check
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL AND lease_attempt_id IS NULL)
      OR
      (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_attempt_id IS NOT NULL)
    ),
  ADD CONSTRAINT media_jobs_lease_attempt_id_check
    CHECK (lease_attempt_id IS NULL OR lease_attempt_id ~ '^attempt_[a-f0-9]{32}$');

CREATE TABLE media_artifacts (
  artifact_id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES media_jobs (job_id) ON DELETE CASCADE,
  attempt_id text NOT NULL,
  kind text NOT NULL,
  publication_state text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  published_at timestamptz,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1,

  CONSTRAINT media_artifacts_artifact_id_check
    CHECK (artifact_id ~ '^(source|partial|file)_[a-f0-9]{32}$'),
  CONSTRAINT media_artifacts_attempt_id_check
    CHECK (attempt_id ~ '^attempt_[a-f0-9]{32}$'),
  CONSTRAINT media_artifacts_kind_check
    CHECK (kind IN ('source', 'partial', 'final')),
  CONSTRAINT media_artifacts_publication_state_check
    CHECK (publication_state IN ('staged', 'published', 'missing')),
  CONSTRAINT media_artifacts_identity_kind_check
    CHECK (
      (kind = 'source' AND artifact_id ~ '^source_[a-f0-9]{32}$')
      OR (kind = 'partial' AND artifact_id ~ '^partial_[a-f0-9]{32}$')
      OR (kind = 'final' AND artifact_id ~ '^file_[a-f0-9]{32}$')
    ),
  CONSTRAINT media_artifacts_storage_key_check
    CHECK (
      length(storage_key) BETWEEN 1 AND 512
      AND storage_key ~ '^((jobs/[a-zA-Z0-9_-]{1,128}/attempts/attempt_[a-f0-9]{32}/(source|partial|staged)/[a-zA-Z0-9._-]{1,128})|(published/[a-f0-9]{2}/[a-f0-9]{2}/file_[a-f0-9]{32}\.[a-z0-9]{1,8}))$'
    ),
  CONSTRAINT media_artifacts_filename_check
    CHECK (
      length(filename) BETWEEN 1 AND 180
      AND filename !~ '[/\\]'
      AND filename !~ '[[:cntrl:]]'
    ),
  CONSTRAINT media_artifacts_content_type_check
    CHECK (
      length(content_type) BETWEEN 3 AND 128
      AND content_type ~ '^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$'
    ),
  CONSTRAINT media_artifacts_byte_size_check
    CHECK (byte_size BETWEEN 1 AND 21474836480),
  CONSTRAINT media_artifacts_checksum_check
    CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT media_artifacts_timestamp_check
    CHECK (
      updated_at >= created_at
      AND expires_at >= created_at
      AND (published_at IS NULL OR published_at >= created_at)
    ),
  CONSTRAINT media_artifacts_state_shape_check
    CHECK (
      (publication_state = 'staged' AND published_at IS NULL)
      OR (publication_state = 'published' AND kind = 'final' AND published_at IS NOT NULL)
      OR publication_state = 'missing'
    ),
  CONSTRAINT media_artifacts_version_check CHECK (version >= 1),
  CONSTRAINT media_artifacts_job_attempt_kind_key UNIQUE (job_id, attempt_id, kind)
);

CREATE UNIQUE INDEX media_artifacts_one_published_final_per_job_idx
  ON media_artifacts (job_id)
  WHERE kind = 'final' AND publication_state = 'published';

CREATE INDEX media_artifacts_job_id_idx
  ON media_artifacts (job_id, attempt_id, kind);

CREATE INDEX media_artifacts_expiry_cleanup_idx
  ON media_artifacts (expires_at, artifact_id)
  WHERE publication_state = 'published';

CREATE INDEX media_artifacts_reconciliation_idx
  ON media_artifacts (publication_state, updated_at, artifact_id);
