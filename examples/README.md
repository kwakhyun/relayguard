# Policy examples

`read-only-policy.json` is a complete credential creation request, with `name`,
`ttl_hours` and `policy`. The same JSON can be checked offline and submitted to
`POST /api/credentials`. A bare policy object is not accepted by this command.

```bash
relayguard policy check examples/read-only-policy.json
relayguard policy check examples/read-only-policy.json --cases examples/policy-cases.json
```

The command needs no running gateway, provider account, credentials, database or
network access. It prints one JSON object and exits with `0` when the schema is
valid and every expected decision matches, or `1` for invalid files, invalid
schemas or a decision mismatch. Without `--cases`, it validates only the
credential creation schema. CLI argument errors are handled by argparse.

## Write request cases

The cases file has one `cases` array containing 1–1,000 objects. Each object
requires exactly these fields; unknown fields and coerced types are rejected:

```json
{
  "cases": [
    {
      "name": "read customers",
      "method": "GET",
      "path": "/customers?limit=2",
      "peer_ip": "127.0.0.1",
      "expected": "allow"
    }
  ]
}
```

- `name`: a short, non-sensitive label, 1–80 characters.
- `method`: an uppercase HTTP method. Unsupported methods do not match a route.
- `path`: the upstream request path including any raw query, without the
  gateway's `/proxy` prefix or an origin. Preserve percent escapes when testing
  aliases. Use synthetic query values; no real customer data is needed.
- `peer_ip`: the numeric socket peer address, without a port or scope identifier.
  This is not an `X-Forwarded-For` value.
- `expected`: `allow` or `deny` for the static request policy.

Policy input is limited to 64 KiB and cases input to 8 MiB. Request targets are
bounded at 8,192 characters. Duplicate JSON fields and non-finite JSON numbers
are rejected. Results include the case label, decision, reason code, matched
policy template and expectation; raw request paths, query values and peer IPs
are not echoed. Schema errors include field positions and codes, not values.

## What passing means

The checker reuses the gateway's canonical-path, route-selection, query and IP
checks in their actual evaluation order. It can expose mistakes such as a
specific route overriding a wildcard's query allowance, or a percent-encoded
alias being denied. Add expected denials as well as successful requests before
issuing a credential.

`allow` means only that the static path, method, query-key and peer policy passes.
It does not issue a token, validate authentication or a live token's expiry,
reserve quota, check headers or bodies, contact an upstream, or guarantee a
successful response. The credential file's TTL and quota fields are validated
as configuration, but their live state is not simulated. Query **values** and
object/tenant authorization remain the upstream's responsibility. The included
`limit=999999` case deliberately shows that allowing the `limit` key does not
enforce the value `2`.

## Docker and IP policies

An IP allowlist containing only `127.0.0.1/32` and `::1/128` is suitable for a
gateway that sees the client as loopback. A host request forwarded into a Docker
bridge may arrive from the bridge address instead. The CLI's synthetic
`peer_ip` does not discover or change that address. Check the deployment's actual
peer before choosing production CIDRs, and keep denials for peers outside the
allowed networks in your own cases file. An empty allowlist means no IP
restriction; it does not mean loopback-only. The Docker demo's published port is
bound to host loopback, which is a separate network boundary.

For that synthetic, loopback-published Docker demo only, use
`docker-demo-policy.json` with the issuance command in the README. It deliberately
has an empty IP allowlist so bridge translation does not block the tutorial. Do
not carry that choice into production without selecting your actual network
policy. Both examples cap lifetime usage at 100 reserved calls and 1 MiB of
approved responses. The supplied case file targets the loopback-restricted
`read-only-policy.json`, not this Docker variant.

## Adapting a real integration

1. Select an HTTPS API that accepts a Bearer token and returns bounded JSON or
   plain text. Keep its original token only in the gateway's environment or mounted secret file.
2. Replace the example route and query keys with the exact reads the integration
   needs. Choose response, minute and lifetime budgets from the expected data volume.
3. Add synthetic cases for required reads, forbidden writes/exports, nested
   paths, query aliases and the actual peer ranges. Run the offline checker.
4. Start the gateway using the [deployment guide](../docs/deployment.md), issue
   the checked credential, then exercise a read and an expected denial through
   `/proxy/` using the new relay key.
5. Revoke the relay key and verify that the same request returns 401. Preserve
   the audit export separately from the gateway's database.

See the [API contract](../docs/api.md) for protocol restrictions and error codes.
