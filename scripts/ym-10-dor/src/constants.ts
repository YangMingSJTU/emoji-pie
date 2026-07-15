export const PROBE_VERSION = '0.3.0'
export const BASELINE_COMMIT = '148de86f1273353e6edcb79567598c2389e3a818'
export const BASELINE_PACKAGE_LOCK_GIT_BLOB_SHA256 =
  '304825ae1935e24aa479b4a64b35e8107d8964dd5fc1d7a52441a3b4b7e1ba01'
export const CORPUS_SHA256 =
  'bb85300ef8df51b0d6ba2a57b5d485ea2430a65c4dc2b2030bd0fbe72cfb6a33'

export const OPENVERSE_ORIGIN = 'https://api.openverse.org'
export const OPENVERSE_SEARCH_PATH = '/v1/images/'
export const OPENVERSE_ASSET_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const OPENVERSE_THUMBNAIL_PATH =
  /^\/v1\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/thumb\/$/iu

export const SEARCH_TIMEOUT_MS = 10_000
export const DOWNLOAD_TIMEOUT_MS = 10_000
export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000
export const MAX_IMAGE_RESPONSE_BYTES = 10 * 1024 * 1024
export const MAX_CANDIDATES = 9
export const MAX_ONLINE_BATCHES_PER_UTC_DAY = 10
export const SEARCH_CONCURRENCY = 1
export const DOWNLOAD_CONCURRENCY = 3
export const DECODE_CONCURRENCY = 2
export const SHARP_JOB_TIMEOUT_MS = 3_000

export const FIXTURE_PRIVATE_KEY_NOTICE =
  'PUBLIC TEST-ONLY KEY: localhost fixture identity; never use outside the YM-10 probe.'
