export const POSTGRES_MIGRATION_CATALOG = Object.freeze([
  Object.freeze({
    version: "001",
    file: "001_create_media_jobs.sql",
    checksum: "117b7a013b24735bfbeb96e6fafa605d2ccd419d51428f02ac9f972503a6048d"
  }),
  Object.freeze({
    version: "002",
    file: "002_add_job_queue_leases.sql",
    checksum: "0ea84b543bd1c51b89cd8cb369f73eb6dedb97dbf3ddc06ac574e033a27f0f16"
  }),
  Object.freeze({
    version: "003",
    file: "003_add_durable_media_artifacts.sql",
    checksum: "d82d680738a69c73e9b4cbee47ec0998fda4613bcb17493c4b5ef167593c5d70"
  }),
  Object.freeze({
    version: "004",
    file: "004_add_job_lifecycle_coordination.sql",
    checksum: "13dad638517d45904468963fb050b25445cf4d2d890541ae4e69eccf14cbcc19"
  })
]);
