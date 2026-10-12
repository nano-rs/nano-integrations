# Manifest schema

Every integration is a directory under `integrations/` containing a
`manifest.yaml`, a `connector.yaml` and (until the connector cutover) a
`code.ts`. This is the manifest reference.

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
    field_type: hostname          # opts into the outbound host policy
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

runtime: deno                     # deno | connector
connector_spec: connector.yaml    # the nano connector spec next to this file
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

Both render as form inputs. `field_type` is `secret`, `string`, `number`,
`boolean`, or — for config fields only — `hostname`.

`hostname` is not cosmetic. It opts the field into the outbound host policy
below: its value must satisfy one of `allowed_domain_suffixes` before nano will
let the collector reach it. **Every other type is ignored by that policy**, so
an admin address or a region code is never mistaken for an egress target.

Declare `hostname` on exactly the fields that name a host. Forgetting it fails
safe — the host is never admitted, and the collector's request is denied by the
sandbox — but it fails at run time rather than at save time, so it is worth
getting right.

### Outbound network

A collector can only reach hosts you declare. Two ways:

- `allowed_domains` — exact hostnames known at authoring time.
- `allowed_domain_suffixes` — for per-tenant hostnames. nano reads every
  `config_fields` entry declared as `field_type: hostname` and admits its value
  **only if it ends with one of these suffixes**. Fields of any other type are
  not considered, so an admin address or a region code is never mistaken for an
  egress target.

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
| `parser` | no | The parser this stream needs, looked up by name. Must be an OCSF parser (`parsers-ocsf/` on the parsers repo's `ocsf-1.9` branch, e.g. `netskope_ocsf`) that claims `source_type`; `testing/ocsf-parsers/manifests.test.ts` enforces it. |
| `default` | no | Pre-checked at install. Default `false`. |
| `description` | no | One line under the toggle. |

Two reserved values route nowhere near a parser: `nano_enrich` (records for
the enrichment lane) and `nano_identity` (streams of a `kind: identity` spec;
see Components below). Neither may name a `parser`.

Give every stream its own `source_type`. Collapsing several event classes into
one source_type forces the parser to re-derive what the collector already knew.

### Runtime

| Key | Default | Notes |
|---|---|---|
| `runtime` | `deno` | Which runtime executes the entry: `deno` runs `code.ts`, `connector` runs the spec named by `connector_spec` on the nano connector engine. |
| `connector_spec` | none | File name of the connector spec, next to the manifest (no paths). Required when `runtime: connector`. |
| `hosted_connector_spec` | none | Optional hosted-only spec, next to the manifest (no paths). nano's hosted runner uses it instead of `connector_spec`; self-hosted and open core keep `connector_spec`. For platform-managed auth the hosted runner can do without a customer secret (e.g. keyless Google DWD). The hosted install asks only for the credential fields that this spec's auth reads. |

Sync copies the spec into the catalog entry's config together with its
SHA-256, and a configured feed pins that hash. A manifest may name a
`connector_spec` while `runtime` is still `deno`: the spec ships alongside and
the shadow run keeps the two in step until the switch.

### Components and categories (marketplace layout)

Optional and additive: a manifest without them keeps working, and nano
deployments that predate them ignore both keys. They let one vendor card
offer several things a customer turns on separately, such as Google
Workspace audit logs and the Google Workspace directory.

```yaml
categories: [logs, identity]      # marketplace sections this card lists under
components:
  - id: audit_logs                # stable id, [a-z0-9_]
    label: Audit logs
    kind: logs                    # logs | identity
    description: "One line under the component toggle"
    streams: [login, admin]       # logs: ids from this manifest's `streams`
    default: true                 # pre-selected at install
    setup:                        # shown in the install drawer
      scopes: ["https://www.googleapis.com/auth/admin.reports.audit.readonly"]
      steps: ["Markdown, one string per step"]
  - id: directory
    label: Directory
    kind: identity
    connector_spec: directory.connector.yaml               # identity: the spec
    hosted_connector_spec: directory.connector.hosted.yaml # optional hosted twin
    config_fields: [ADMIN_EMAIL, PRIVILEGED_GROUPS]        # fields this component reads
    default: false
    setup:
      scopes: [...]               # OAuth scopes the customer must grant
      permissions: [...]          # vendor roles / API permissions, plain text
      steps: [...]                # markdown strings, in order
```

| Key | Required | Notes |
|---|---|---|
| `categories` | no | Marketplace sections: `logs`, `identity`. A card with an `identity` component lists under Identity. Without it the card lists by `category` as before. |
| `components[].id` | yes | Stable; the install records which components are on. |
| `components[].label` | yes | Shown on the card. |
| `components[].kind` | yes | `logs` (rows go to ingest through parsers) or `identity` (rows go to nano's identity snapshot; no parser, no log source). |
| `components[].description` | no | One line. |
| `components[].streams` | `logs` | Ids from this manifest's `streams`. Every stream belongs to at most one component. |
| `components[].connector_spec` | `identity` | Spec file next to the manifest (no paths), `kind: identity`. Usually not the manifest's own `connector_spec`, so a logs entry can add a directory without changing its log streams. |
| `components[].hosted_connector_spec` | no | Hosted twin of the component's spec. Same rule as the top-level one: it may differ from `connector_spec` only in its `auth` block. |
| `components[].config_fields` | no | Names from `config_fields` this component reads, so the install form can show only those. Every config field an identity spec reads must be listed. |
| `components[].default` | no | Pre-selected at install. Default `false`. |
| `components[].setup` | no | `scopes`, `permissions`, `steps` (all lists of strings; `steps` are markdown). |

An entry whose only purpose is a directory (Okta Users, Entra ID) declares
one `identity` component whose `connector_spec` is the manifest's own. Its
manifest `streams` mirror the spec's stream ids with `source_type:
nano_identity`, the marker for identity rows (never a parser, never a log
source). `testing/shadow/shadow.test.ts` checks every component: specs exist,
are `kind: identity`, read only declared fields, and a hosted twin differs
only in `auth`.

### Identity specs (`kind: identity`)

An identity spec emits canonical directory rows instead of log events. Each
stream sets `identity.role`: `users` streams emit one row per user
(`external_id` plus profile fields such as `email`, `upn`, `department`,
`manager_upn`, `account_status`, `is_admin`), `memberships` streams emit
`{member, group, privileged}` that nano aggregates into each user's groups.
`identity.mode: delta` on a users stream lets runs between full snapshots
ship only changes (`deleted: true` rows are tombstones); a top-level
`identity.full_every_secs` forces a full snapshot at least that often. See the
nano-connector authoring guide for the canonical field list.

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
