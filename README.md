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
| `sn_query` | What is really in this table, and how many of each? |
| `sn_schema` | Which fields apply to a table, including the inherited ones and dictionary overrides? |
| `sn_plugins` | Which plugins and applications are installed? |
| `sn_delta` | What was changed on this instance, by whom and when? |
| `sn_origin` | Is this record out-of-the-box, customized, or customer-created? |
| `sn_dependencies` | What configuration is attached to this table, or to this field? |
| `sn_upgrade_skips` | What did the upgrade skip, and still needs a review? |

It also serves three MCP prompts, `verify_claim`, `review_upgrade` and `assess_change`, and one resource,
`servicenow-sparring://limitations`.

## Evidence you can run again

Every answer names where it came from, what it cost, and how complete it is:

```json
{
  "instance": "example.service-now.com",
  "fetchedAt": "2026-11-20T02:14:07.512Z",
  "requests": 5,
  "warnings": [],
  "table": "sys_script",
  "query": "collection=incident^active=true",
  "total": 83,
  "returned": 2,
  "offset": 0,
  "truncated": true,
  "nextOffset": 2,
  "fieldCheck": "all field names verified against sys_dictionary",
  "records": [
    { "name": "Example rule A", "when": "before" },
    { "name": "Example rule B", "when": "after" }
  ]
}
```

The Table API does not reject a condition it cannot use. It drops the condition and answers with every row, or it
matches nothing. Both look like an answer. Five rules keep the evidence from lying:

1. **A query on a field that does not exist is refused.** ServiceNow drops a condition on an unknown field and
   answers unfiltered. One typo would turn "no match" into "here are some records". Field names, dot-walks
   included, are checked against the instance dictionary before anything is sent, and the error names similar
   fields. Where the dictionary cannot be used, the names are checked against a row of the table itself. Where
   neither works, a filtered query is not sent.
2. **A condition the instance would drop is refused.** A dot-walk through a list field, a date condition with a
   missing part, an operator written the wrong way. [docs/encoded-queries.md](docs/encoded-queries.md) lists what
   was measured on a live instance: which forms are dropped, which match nothing, and which run script.
3. **A value that cannot match is refused or explained.** `state=Resolved` matches nothing, because the field
   stores `6`. That query is refused, and the error names the stored value. `caller_id=Abel Tuter` matches nothing,
   because a reference is compared with a sys_id. That answer comes with the reason.
4. **Counts say what they count.** `total` is what matched on the server before row-level access rules; `returned`
   is what is in the answer. When rows were withheld, the answer says so.
5. **"Could not be checked" is never "nothing found".** A table this account cannot read is an error of kind `acl`.
   A tool that depends on it marks that part `not_checked` or `unknown`.

## What "read-only" means here

The server sends only HTTP `GET` requests, and only to two endpoints of the one configured instance: the Table API
(`/api/now/table/<table>`) and the Aggregate API (`/api/now/stats/<table>`). There is no function and no code path
that creates, updates or deletes anything. Tests hold that: one scans the source for any other HTTP method and any
other way to reach the network, one records every request the eight functions send. They run in CI on every push.
They are a guard against a change that breaks the promise, not a sandbox.

That is a statement about what the server sends. It is not a statement about what an instance does while it answers:

- A `before query` business rule runs on every read. It is customer code and does whatever its author wrote.
- Reading a remote table runs the script behind it. `sn_schema` names the kind of a table.
- Every request is logged on the instance. The server sends the header `User-Agent: servicenow-sparring/<version>`.
- A query can make the instance run script: through a `javascript:` value, or through a `DYNAMIC` condition, which
  runs a stored filter script. The server refuses both, and no setting turns that off. Use fixed values, for dates
  `YYYY-MM-DD HH:MM:SS` in UTC.

So give the server an account of its own that cannot write: read roles, plus the role `snc_read_only`, whose users
"are prevented from creating, updating, or deleting records". Then the instance enforces the promise a second time.
`sn_instance` and `npm run doctor` report whether the account is an administrator and whether it has that role.

More guards: table names and field names are validated before they reach a URL; a value read from the instance is
checked like any other before it goes into the next query; `https` is required (`http` only for `localhost`);
redirects are not followed; requests time out; an answer larger than 10 MB is not read to the end. Until the
instance has accepted the login once, requests go one at a time, so a wrong password costs one rejected login, not
one for every request in flight.

## What leaves the instance

Everything a function returns goes to the MCP client, and from there to the model it uses. If that model runs at a
provider, the data leaves your network. Three things limit what can go that way:

- **The account.** The server reads what its account may read, and nothing else. This is the limit that counts.
- **Secrets are withheld.** Fields of a password type or an encrypted type, and system properties of a password
  type, come back as `[withheld: this field holds a secret]`. The Table API would hand them out as stored.
- **Tables can be closed on your side.** `SERVICENOW_TABLE_DENY=sys_user,sys_user_*` stops the server from asking
  for those tables at all. `SERVICENOW_TABLE_ALLOW` names the only tables it may ask for. A name can end in `*`.
  A closed table is reported as "could not be checked".

Record content that comes back (names, descriptions, scripts, error texts) is data from the instance. The server
tells the agent to treat it as data, never as an instruction, and it cuts long values. It cannot make an agent obey.

To see afterwards what an agent asked, set `SERVICENOW_AUDIT_LOG` to a file. It receives one line per request:

```json
{"time":"2026-11-20T02:14:07.101Z","tool":"sn_query","api":"table","table":"sys_script","query":"collection=incident^active=true","status":200,"rows":2,"total":83,"ms":212}
```

It holds no credentials and no record content. A query can contain values, so keep the file as private as the
instance.

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
| `SERVICENOW_ENV_FILE` | Path to a file with the variables above. `~` means your home folder |
| `SERVICENOW_TABLE_ALLOW`, `SERVICENOW_TABLE_DENY` | Optional. Table names or prefixes ending in `*`, separated by commas |
| `SERVICENOW_AUDIT_LOG` | Optional. A file that receives one line per request |
| `SERVICENOW_TIMEOUT_MS` | Optional request timeout, default 30000 |

Variables that are set win over the file; an empty variable counts as not set. Only `SERVICENOW_*` keys are taken
from the file. See [`.env.example`](.env.example).

The server itself reads no `.env` file from the folder it is started in, because an MCP client can start it inside
any project. The npm scripts below do read `.env` in the folder you run them in, when no `SERVICENOW_*` variable
is set.

### Check the account

```bash
npm run doctor
```

This checks the address and the login with one request, then lists the tables the functions read and whether the
account can read each one, and finally the release, the Aggregate API and the roles of the account. Nothing has to
be installed on the instance.

Which roles the account needs depends on the access rules of your instance. Start with a read-only account and let
`doctor` show what is closed; the functions report a closed source as "could not be checked".

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

- On Windows, write paths with forward slashes or doubled backslashes: `"C:/tools/instance.env"`.
- A desktop app may not see a `node` that a version manager installed. Then give the full path of the `node`
  program as `command`.
- The client does not start the server in the folder of this repository. That is why the env file needs an
  absolute path.

### Signing in with a token

Where basic authentication is switched off, give the server an OAuth access token in `SERVICENOW_TOKEN`. The server
does not fetch tokens itself: a token request is a `POST`, and this code base contains no request other than `GET`.

A token expires. If it lives in the file named by `SERVICENOW_ENV_FILE`, a helper of yours can write a new one
there; the server reads the file again when the instance rejects a login. An instance that answers with a redirect
to a sign-in page is reported as an error of kind `redirect`.

### Proxies and certificates

The server uses the `fetch` of Node.js. Behind a company proxy that inspects TLS, point Node at the company's
certificate with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Recent versions of Node use `HTTPS_PROXY` when
`NODE_USE_ENV_PROXY=1` is set (checked with Node 26). Both go into the `env` block of the client, next to
`SERVICENOW_ENV_FILE`. A failed connection names its cause, for example `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or
`ENOTFOUND`.

## How `sn_origin` decides

It asks the instance four questions and shows the rows behind each answer, with the queries to run them again.

| Question | Evidence | Answer |
|---|---|---|
| Who delivered the record? | the class of the package it belongs to (`sys_metadata.sys_package`) | `provenance`: vendor, installed application, custom application, global scope |
| Was it changed here? | customer update rows (`sys_update_xml`), the version marked current (`sys_update_version`), and whether the last upgrade refused to overwrite it (`upgrade_history_task`) | `divergence` |
| Was it created here, or delivered? | a vendor version of the record exists, or the record is older than its first captured change | `created` |
| Who made the captured changes? | the authors of the update rows | `capturedBy`: people, or system accounts only |

| Delivered by | Changed here | Created | Verdict |
|---|---|---|---|
| platform or installed application | no | | `out_of_box_as_captured` |
| platform or installed application | yes | delivered | `customized` |
| platform or installed application | yes | here | `customer_created` |
| custom application | any | | `custom_application_file` |
| no package (global scope) | yes | a vendor version exists | `customized` |
| no package (global scope) | yes | otherwise | `customer_created` |
| no package (global scope) | no | | `unknown` |
| anything | evidence not readable | | `unknown` |

### What was measured

On one instance of the Australia release, with `npm run origin-check`:

- **Against the upgrade engine.** The last family upgrade skipped 79 files because it found them changed. For 77
  of them `sn_origin` answers `customized`; one it does not find, one it leaves `unknown`. This is not an
  independent confirmation for all of them: 36 of the 77 have no customer update at all, and `sn_origin` knows
  about them only because it reads what the upgrade found. Before it did, it called those 36 out-of-the-box.
- **200 random application files:** 170 `out_of_box_as_captured`, 30 `unknown`. It abstains on 15 in 100. Most of
  those belong to no package: parts of flows and actions, which are captured with their parent and carry no name
  of their own.
- **197 random captured changes:** 100 `customer_created`, 71 `customized`, 22 `custom_application_file`, 3
  `unknown`, 1 `deleted_here`. Of the 71 customized records, 57 were captured under system accounts and 14 by
  people.

What follows from that:

- **`out_of_box_as_captured` means "no captured change", not "unchanged".** A record can differ from the vendor
  version without any captured change: a property set by a script, a role changed by an installer. Only an upgrade
  notices, by comparing content, and this server cannot compare content. Where no upgrade has looked at a record
  yet, such a change is invisible here.
- **"Customized" is the platform's word, not a statement about people.** On this instance four in five of the
  customized records were changed by installations, upgrades and jobs, and of all 6,631 captured changes 2,789
  were made under system accounts. `capturedBy` tells them apart, `sn_delta` counts them, and its `peopleOnly`
  leaves them out.
- **The rule is measured on one instance.** The verdicts were compared with the upgrade engine and with the stored
  evidence, not checked by hand, and not on a second instance. Update rows and versions can be cleaned up or lost
  in a clone. Run `npm run origin-check` on your instance before you rely on the verdicts there.

## What it cannot know

- `sn_delta` reads `sys_update_xml`, which does not record everything: for example metadata types that are not
  tracked, the files of an installed application, cascading field changes, and some Flow changes. Every answer lists
  the gaps. It counts rows, and one record can have several. Say "captured customizations", never "all
  customizations".
- `sn_dependencies` lists configuration attached to a table and its parents, or to one field. It does not see
  scripts and conditions that only name the table or field, the flow behind a record trigger, wildcard access
  controls, reports or integrations. The answer lists what is not covered.
- `sn_upgrade_skips` lists records an upgrade did not overwrite and that have a review entry. Each one needs a
  review. It is not a prediction that something breaks, and it describes only the instance that answered.
- Encoded queries are parsed with a strict grammar. Related-list queries (`RLQUERY`), tag conditions, catalog
  variables and the shorthand operators `*`, `%`, `!*` are refused, because they cannot be checked.
- One answer carries about 60,000 characters of rows. Longer values are cut and marked.

The resource `servicenow-sparring://limitations` carries the full list to the agent.

## Development

```bash
npm test              # unit tests against a fake instance, no network
npm run typecheck
npm run smoke         # end-to-end against the configured instance, read-only
npm run call -- sn_schema '{"table":"incident","filter":"assign"}'
npm run origin-check  # measures sn_origin on the configured instance
```

`npm run smoke` drives the real server through an MCP client and exits with 1 if a check fails. It prints counts and
verdicts, never record content. `npm run call` runs one function from the shell and prints what an agent would
receive.

What was tested, and what was not:

- Live against one instance on the Australia release, with an administrator account that did not have
  `snc_read_only`. How narrower roles and that role change what the functions can read was not measured.
- On another release, run `npm run doctor` and `npm run smoke` first.
- Signing in with a token is covered by unit tests only.
- CI runs the unit tests on Linux, Windows and macOS.

See [CHANGELOG.md](CHANGELOG.md) for what changed. Contributions are welcome, see
[CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE). Not affiliated with ServiceNow, Inc. "ServiceNow" is a trademark of ServiceNow, Inc.
