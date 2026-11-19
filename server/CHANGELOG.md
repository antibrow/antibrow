# Changelog

## [0.1.0]

- Initial skeleton: dual-runtime build (Cloudflare and Node/Docker), configuration reader, health endpoint.
- Shared core module: license token signing, error responses, S3 storage client, profile and proxy sync schemas, and zod schemas for the `/api/v1` wire protocol.
- API keys are stored as a SHA-256 hash plus their last 4 characters; the full key is shown only once, when it is created.
