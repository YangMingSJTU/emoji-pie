export const PROBE_VERSION = '0.1.0'
export const BASELINE_COMMIT = '148de86f1273353e6edcb79567598c2389e3a818'
export const BASELINE_PACKAGE_LOCK_SHA256 =
  'de61717ae5b1fb87dffdd3e985e6cfa3e6a15f171da674ee976ef14f5552d35c'
export const CORPUS_SHA256 =
  'bb85300ef8df51b0d6ba2a57b5d485ea2430a65c4dc2b2030bd0fbe72cfb6a33'

export const OPENVERSE_ORIGIN = 'https://api.openverse.org'
export const OPENVERSE_SEARCH_PATH = '/v1/images/'
export const OPENVERSE_THUMBNAIL_PATH = /^\/v1\/images\/[0-9a-f-]+\/thumb\/$/i

export const SEARCH_TIMEOUT_MS = 10_000
export const DOWNLOAD_TIMEOUT_MS = 10_000
export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_IMAGE_RESPONSE_BYTES = 10 * 1024 * 1024
export const MAX_CANDIDATES = 9
export const MAX_ONLINE_BATCHES_PER_UTC_DAY = 10
export const SEARCH_CONCURRENCY = 1
export const DOWNLOAD_CONCURRENCY = 3
export const DECODE_CONCURRENCY = 2

export const FIXTURE_PRIVATE_KEY_NOTICE =
  'PUBLIC TEST-ONLY KEY: localhost fixture identity; never use outside the YM-10 probe.'
