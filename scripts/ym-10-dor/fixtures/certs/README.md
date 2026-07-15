# Local HTTPS fixture certificate

`localhost-ca.pem`, `localhost-cert.pem`, and `localhost-key.pem` form a public, test-only chain and identity for the YM-10 loopback fixture server. The private key is intentionally committed because it protects no secret and authenticates no production service.

The fixture transport trusts this certificate explicitly and accepts only `https://localhost:<port>` or `https://127.0.0.1:<port>`. The Openverse transport never uses this CA or a configurable origin.
