# servicenow-sparring

A read-only [MCP](https://modelcontextprotocol.io) server that lets an AI agent check claims about ServiceNow against
a live instance, instead of answering from memory.

https://github.com/user-attachments/assets/48cee9b5-aa48-4f32-b097-613aac823b13

*Intro, two minutes, no sound. The same film as a file: [docs/media/intro.mp4](docs/media/intro.mp4).*

An agent that answers ServiceNow questions from memory does not know your instance: which release it runs, which
plugins are active, what was customized. A wrong answer sounds exactly like a right one. This server gives the agent
eight functions that read the instance and return evidence a person can run again.

## What it answers

| Function | Question |
|---|---|
| `sn_instance` | Which release is this, how much was customized, and what can this account read? |
| `sn_query` | What is really in this table? |
| `sn_schema` | Which fields does a table have, including the inherited ones and dictionary overrides? |
| `sn_plugins` | Which plugins and store apps are installed? |
| `sn_delta` | What was changed on this instance, by whom and when? |
| `sn_origin` | Is this record out-of-the-box, customized, or customer-created? |
| `sn_dependencies` | What configuration is attached to this table? |
| `sn_upgrade_skips` | What did the upgrade skip, and still needs a review? |

It also serves one MCP prompt, `verify_claim`, and one resource, `servicenow-sparring://limitations`.

## Evidence you can run again

Every answer names where it came from and how complete it is:

```json
{
  "instance": "example.service-now.com",
  "table": "sys_script",
  "query": "collection=incident^active=true",
  "total": 83,
  "returned": 20,
  "offset": 0,
  "truncated": true,
  "nextOffset": 20,
  "fieldCheck": "all field names verified against sys_dictionary",
  "warnings": [],
  "records": []
}
```

Three rules keep the evidence from lying:

1. **A query on a field that does not exist is refused.** ServiceNow drops a condition on an unknown field and
   answers with every row. One typo would turn "no match" into "here are some records". Field names, dot-walks
   included, are checked against the instance dictionary before anything is sent, and the error names similar fields.
2. **Counts say what they count.** `total` is what matched on the server before row-level access rules; `returned`
   is what this account received. When rows were withheld, the answer says so.
3. **"Could not be checked" is never "nothing found".** A table this account cannot read is an error of kind `acl`.
   A tool that depends on it marks that part `not_checked` or `unknown`.

## What "read-only" means here

The server sends only HTTP `GET` requests, and only to two endpoints: the Table API (`/api/now/table/<table>`) and
the Aggregate API (`/api/now/stats/<table>`). There is no function and no code path that creates, updates or deletes
anything. Two tests fail the build if that changes: one scans the source for any other HTTP method, one records every
request the eight functions send.

That is a statement about what the server sends. It is not a statement about what an instance does while it answers:

- A `before query` business rule runs on every read. It is customer code and does whatever its author wrote.
- Every request is logged on the instance.
- `javascript:` inside an encoded query runs script on the instance. The server refuses such queries, and no setting
  turns that off. Use fixed values, for dates `YYYY-MM-DD HH:MM:SS` in UTC.

So give the server an account that cannot write. ServiceNow ships the role `snc_read_only` for this: its users "are
prevented from creating, updating, or deleting records". Then the instance enforces the promise a second time.

More guards: table names and field names are validated before they reach a URL; values that functions place into a
query may not contain `^`; `https` is required; redirects are not followed; requests time out. Record content that
comes back (names, descriptions, scripts) is data from the instance, and the server tells the agent to treat it as
data, never as an instruction.

## Setup

Needs Node.js 22 or newer.

```bash
git clone https://github.com/munirad7s/servicenow-sparring-mcp.git
cd servicenow-sparring-mcp
npm install
```

`npm install` also builds the server into `dist/`.

### Configuration

| Variable | Meaning |
|---|---|
| `SERVICENOW_INSTANCE_URL` | The instance address, for example `https://example.service-now.com` |
| `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD` | Basic authentication |
| `SERVICENOW_TOKEN` | A ready-made OAuth access token, sent as a bearer token. Wins over user name and password |
| `SERVICENOW_ENV_FILE` | Optional path to a file with the variables above. Without it, `.env` in the working directory is read if present |
| `SERVICENOW_TIMEOUT_MS` | Optional request timeout, default 30000 |

Variables that are already set win over the file. See [`.env.example`](.env.example).

The server does not fetch tokens itself. A token request is a `POST`, and this code base contains no request other
than `GET`.

### Check the account

```bash
npm run doctor
```

This lists the tables the functions read and whether the configured account can read each one. Nothing has to be
installed on the instance.

### Register with an MCP client

Any client that starts a local MCP server over stdio works. The usual configuration block:

```json
{
  "mcpServers": {
    "servicenow-sparring": {
      "command": "node",
      "args": ["/absolute/path/to/servicenow-sparring-mcp/dist/index.js"],
      "env": { "SERVICENOW_ENV_FILE": "/absolute/path/to/instance.env" }
    }
  }
}
```

## How `sn_origin` decides

It answers two questions separately and shows the rows behind each.

| Question | Evidence | Values |
|---|---|---|
| Who delivered the record? | the class of the package it belongs to (`sys_metadata.sys_package`) | `vendor`, `installed_application`, `custom_application`, `global_scope`, `unknown` |
| Was it changed on this instance? | rows in `sys_update_xml`, and versions in `sys_update_version` that came from an update set | `customer_changes_captured`, `no_customer_changes_captured`, `unknown` |

| Delivered by | Changed here | Verdict |
|---|---|---|
| vendor package or installed application | no | `out_of_box_as_captured` |
| vendor package or installed application | yes | `customized` |
| custom application | any | `custom_application_file` |
| no package (global scope) | yes | `customer_created` |
| no package (global scope) | no | `unknown` |
| anything | evidence not readable | `unknown` |

How far to trust it: the rule was derived on one instance. A run over 60 application files there gave 53 verdicts and
7 times `unknown`; the verdicts were not checked by hand against a second source. Update rows can be cleaned up or
lost in a clone, and a reverted change can still count as customized. Read `out_of_box_as_captured` as "no captured
change", not as proof.

## What it cannot know

- `sn_delta` reads `sys_update_xml`, which does not record everything: for example metadata types that are not
  tracked, cascading field changes, and some Flow changes. Every answer lists the gaps. Say "captured
  customizations", never "all customizations".
- `sn_dependencies` lists configuration attached to a table and its parents. It does not see scripts that only name
  the table in code, the flow behind a record trigger, wildcard access controls, reports or integrations. The answer
  lists what is not covered.
- `sn_upgrade_skips` lists records an upgrade did not overwrite. Each one needs a review. It is not a prediction
  that something breaks, and it describes only the instance that answered.
- Encoded queries are parsed with a strict grammar. Related-list queries (`RLQUERY`), tag conditions and the
  shorthand operators `*`, `%`, `!*` are refused, because they cannot be checked.

The resource `servicenow-sparring://limitations` carries the full list to the agent.

## Development

```bash
npm test          # unit tests against a fake instance, no network
npm run typecheck
npm run smoke     # end-to-end against the configured instance, read-only
```

`npm run smoke` drives the real server through an MCP client and exits with 1 if a check fails. It prints counts and
verdicts, never record content.

Tested live against one instance on the Australia release. On another release, run `npm run doctor` and
`npm run smoke` first. The bearer-token path is covered by unit tests only.

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see
[SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE). Not affiliated with ServiceNow, Inc. "ServiceNow" is a trademark of ServiceNow, Inc.
