# Manifest schema

Every integration is a directory under `integrations/` containing a
`manifest.yaml` and a `code.ts`. This is the manifest reference.

```yaml
name: Netskope                    # display name
slug: netskope                    # unique id; [a-z0-9_-], stable forever
category: collector               # always "collector" in this repo
description: "One line, shown on the catalog card"
icon: cloud                       # icon name from nano's icon set
author: nano
version: 1                        # bump on every content change
changelog: "v1: initial release"  # optional, shown on upgrade

auth_type: api_key_header         # none | bearer | api_key_header | basic_auth
                                  #      | oauth2_client_credentials
auth:
  header_name: Netskope-API-Token # api_key_header only
  credential_field: API_TOKEN     # which credential_field holds the secret

requires_credential: required     # none | optional | required
credential_fields:                # encrypted at rest, injected at call time
  - name: API_TOKEN
    label: API Token
    field_type: secret
    required: true
    help: "Where to get it"

config_fields:                    # NON-secret, operator-supplied config
  - name: TENANT_HOST
    label: Tenant hostname
    field_type: string
    required: true
    placeholder: "acme.goskope.com"
    help: "Your tenant hostname"

allowed_domains: []               # static outbound allowlist
allowed_domain_suffixes:          # suffix allowlist for per-tenant hostnames
  - ".goskope.com"

streams:                          # what the operator can turn on
  - id: alert
    label: Alerts
    source_type: netskope_alert   # routes to this parser
    default: true
    description: "Policy, DLP, malware and anomaly alerts"

config:
  poll_schedule: "*/5 * * * *"    # cron; operator can override
  max_run_secs: 900               # run budget before shouldStop() flips
  max_events_per_emit: 10000      # batch ceiling nano enforces

tags:
  - casb
  - dlp
```

## Fields

### Identity

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name. |
| `slug` | yes | Unique, stable, `[a-z0-9_-]`. Changing it creates a new catalog entry and orphans existing instances. |
| `category` | yes | Always `collector`. |
| `description` | yes | One line. |
| `icon` | no | Icon name. Falls back to a generic plug icon. |
| `author` | no | Defaults to `Community`. |
| `version` | yes | Integer. Bump on every change; nano offers an upgrade when it rises. |
| `changelog` | no | Shown in the upgrade prompt. Say what changed and why. |

### Auth

`auth_type` selects how nano injects credentials into outbound requests. The
sandbox monkey-patches `fetch`, so your code never touches the secret — just
call the API and the header is already there.

| `auth_type` | `auth` keys | Injected as |
|---|---|---|
| `none` | — | nothing |
| `bearer` | `credential_field` | `Authorization: Bearer <value>` |
| `api_key_header` | `header_name`, `credential_field` | `<header_name>: <value>` |
| `basic_auth` | `username_field`, `password_field` | `Authorization: Basic <b64>` |
| `oauth2_client_credentials` | `token_url`, `client_id_field`, `client_secret_field`, `scope` | `Authorization: Bearer <fetched>`, refreshed automatically |

Three-legged OAuth (authorization code + refresh token) is not supported.

### Credential and config fields

`credential_fields` are secrets: encrypted with AES-256-GCM at rest, decrypted
only into the sandbox process, never logged, never returned by the API.

`config_fields` are not secrets: tenant hostnames, region codes, org ids. They
are readable through the API and appear in logs.

Both render as form inputs. `field_type` is `secret`, `string`, `number`, or
`boolean`.

### Outbound network

A collector can only reach hosts you declare. Two ways:

- `allowed_domains` — exact hostnames known at authoring time.
- `allowed_domain_suffixes` — for per-tenant hostnames. nano resolves each
  `config_fields` value that looks like a hostname and admits it **only if it
  ends with one of these suffixes**.

A suffix must have at least two labels (`.goskope.com` is fine, `.com` is
rejected). Everything is re-validated against SSRF rules immediately before
each run, so a hostname that starts resolving to an internal address stops
working rather than becoming an egress hole.

### Streams

A stream is one logical feed the operator can toggle independently. Each maps
to a `source_type`, which is what routes events to a parser.

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable id. Used as the cursor key — renaming resets the cursor. |
| `label` | yes | Shown in the UI. |
| `source_type` | yes | Must match a parser's `match_values` in the parsers repo. |
| `default` | no | Pre-checked at install. Default `false`. |
| `description` | no | One line under the toggle. |

Give every stream its own `source_type`. Collapsing several event classes into
one source_type forces the parser to re-derive what the collector already knew.

### Runtime config

| Key | Default | Notes |
|---|---|---|
| `poll_schedule` | `*/15 * * * *` | Cron. 5- or 6-field both accepted. Operator can override per instance. |
| `max_run_secs` | `600` | Run budget. `ctx.shouldStop()` returns `true` once exceeded; the process is killed 30s later. |
| `max_events_per_emit` | `10000` | Hard ceiling per `emit` call. Exceeding it fails the run. |

Set `max_run_secs` from the vendor's pacing, not from optimism. If the API
allows 4 requests/second at 10k events per page, a 900s budget is ~36M events —
far more than a poll interval will ever produce, which is what you want: the
budget is a safety net, not a throttle.
