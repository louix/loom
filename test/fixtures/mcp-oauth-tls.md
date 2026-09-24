# OAuth TLS fixtures

The certificate and private key in `mcp-oauth-cert.pem` and `mcp-oauth-key.pem`
are synthetic test data for `issuer.test`, valid from January 2026 to January 2036.
They have never been used with a real service. The SHA-256 self-signed certificate
is trusted only by the child test process via Deno's `--cert` option.

Generated once with selfsigned 5.2.0; that generator is not an application or test
dependency. These PEM files are intentionally outside oxfmt's supported formats.
A formatter invocation containing only PEM files reports no matching targets;
format checks over the repository's supported files remain required.
