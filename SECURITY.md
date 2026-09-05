# Security Policy

Report security issues privately to the repository owner. Do not open public issues containing exploitable details.

This package is designed to avoid credentials. Never paste cookies, tokens, session data, private profile material, or signed provider URLs into issues, logs, command-line arguments, or receipts.

The CLI rejects unsafe output paths, path traversal, non-provider media URLs, non-HTTPS provider URLs, unsafe CDP targets, and redirects to private/local addresses.
