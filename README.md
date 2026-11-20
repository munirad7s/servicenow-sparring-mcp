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

More examples, also of refusals: [docs/examples.md](docs/examples.md).

The Table API does not reject a condition it cannot use. It drops the condition and answers with every row, or it
matches nothing. Both look like an answer. Five rules keep the evidence from lying:

1. **A query on a field that does not exist is refused.** ServiceNow drops a condition on an unknown field and
   answers unfiltered. One typo would turn "no match" into "here are some records". Field names, dot-walks
   included, are checked against the instance dictionary before anything is sent, and the error names similar
   fields. Where the dictionary cannot be used, the names are checked against a row of the table itself. Where
   neither works and the table is not empty, a filtered query is not sent.
2. **A condition the instance would drop is refused.** A dot-walk through a list field, a date condition with a
   missing part, an operator written the wrong way, a `LIKE` without a value.
   [docs/encoded-queries.md](docs/encoded-queries.md) lists the forms that one live instance dropped or answered
   with nothing, and the forms that are refused because they are documented to run script.
3. **A value that cannot match is refused or explained.** `state=Resolved` matches nothing, because the field
   stores `6`. That query is refused, and the error names the stored value. `caller_id=Abel Tuter` matches nothing,
   because a reference is compared with a sys_id. That answer comes with the reason. `assigned_to!=<sys_id>` leaves
   out every row without an assignee, and the answer says that too. The check of choice values needs `sys_choice`
   to be readable and covers the fields of the table itself; where it could not be made, the answer says so.
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
provider, the data leaves your network. Four things limit what can go that way:

- **The account.** The server reads what its account may read, and nothing else. This is the limit that counts.
- **Secrets are withheld.** Fields of a password type or an encrypted type, and system properties of a password
  type, come back as `[withheld: this field holds a secret]`. The Table API would hand them out as stored. The
  server knows the type of a field from the dictionary. Where it cannot read the type, it withholds a field whose
  name suggests a secret (password, token, secret, key), and the answer says that types were missing.
- **A secret cannot be found out by trying.** "Starts with a", "starts with b": the number of matches would give a
  value away piece by piece, and so would the order of rows sorted by it. A field that holds a secret can be asked
  whether it is filled, and nothing else. A query that compares or sorts by the value of system properties leaves
  the properties of a password type out and says so; a count per property value is refused.
- **Tables can be closed on your side.** `SERVICENOW_TABLE_DENY=sys_user,sys_user_*` keeps the rows of those tables
  away from the server: it does not ask for them, a query cannot reach them through a dot-walk, a child table or a
  database view, and the names behind references into them are left out, for single references and for lists.
  Such a reference can be compared with a sys_id, but not with text and not sorted by, because both work on the
  names. Where the type of a field cannot be read, its display value is left out as well.
  `SERVICENOW_TABLE_ALLOW` names the only tables whose rows it may read. A name can end in `*`. A closed table is
  reported as "could not be checked". What the dictionary says about a closed table (its fields, what is attached
  to it) can still be read, and the other functions read a fixed set of configuration tables, which
  `npm run doctor` lists.

Record content that comes back (names, descriptions, scripts, error texts) is data from the instance. The server
tells the agent to treat it as data, never as an instruction, and it cuts long values. It cannot make an agent obey.

To see afterwards what an agent asked, set `SERVICENOW_AUDIT_LOG` to a file, with its full path. The server
appends one line per request:

```json
{"time":"2026-11-20T02:14:07.101Z","tool":"sn_query","api":"table","table":"sys_script","query":"collection=incident^active=true","fields":["name","when"],"status":200,"sent":1,"rows":2,"total":83,"ms":212}
```

`sent` is the number of HTTP requests this took: 0 for a request that was refused or held back, 2 after a retry.
The file holds no credentials and no record content. A query can contain values, so keep it as private as the
instance; it is created readable by its owner only. The lines stand in the order the requests ended. If the file
cannot be written, the server says so once on its error output and keeps answering. The npm scripts do not write
it.

## Requests, caching and pauses

- One `sn_query` is one request, plus a few to check its field names the first time a table is used. The other
  functions cost more: `sn_origin` 5 to 7, `sn_dependencies` 25 to 30 (about 15 for one field), `sn_instance`
  about 50. Every answer carries its
  count in `requests`. At most six requests of one function are in flight at a time.
- What the dictionary says about a table is kept for ten minutes for the checks of `sn_query`. A field that is
  missing from an entry older than 30 seconds is looked up once more, so a field created during a session is
  found. `sn_schema` reads the dictionary anew for every call, for a database view also that of the tables it
  joins.
- A `429 Too Many Requests` is waited out once, for at most five seconds.
- After a rejected login the server sends nothing for 60 seconds, unless the env file holds new credentials. While
  no request has ever succeeded, an unreachable instance pauses it for 15 seconds.

## Setup

Needs Node.js 22 or newer.

```bash
git clone https://github.com/munirad7s/servicenow-sparring-mcp.git
cd servicenow-sparring-mcp
npm install
```

`npm install` also builds the server into `dist/`.

Without a checkout, `npx` can fetch and build it from GitHub. The first start takes about fifteen seconds; add
`#v0.3.0` to the name to stay on one release. Checked on Linux with npm 11.

```bash
npx -y github:munirad7s/servicenow-sparring-mcp --version
npx -y github:munirad7s/servicenow-sparring-mcp doctor
```

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

- Without a checkout: `"command": "npx"` and `"args": ["-y", "github:munirad7s/servicenow-sparring-mcp#v0.3.0"]`.
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
| Was it changed here? | customer update rows (`sys_update_xml`), the version marked current (`sys_update_version`), and the newest entry of an upgrade that refused to overwrite it (`upgrade_history_task`) | `divergence` |
| Was it created here, or delivered? | a vendor version of the record exists; inside a delivered package also: the record is older than its first captured change | `created` |
| Who made the captured changes? | the authors of the update rows | `capturedBy`: people, or system accounts only |

| Delivered by | Changed here | Created | Verdict |
|---|---|---|---|
| custom application | any | | `custom_application_file` |
| platform or installed application | no | | `out_of_box_as_captured` |
| platform or installed application | yes | delivered | `customized` |
| platform or installed application | yes | here | `customer_created` |
| installed application | yes | not decided | `unknown` |
| platform | yes | not decided | `customized` |
| no package (global scope) | yes | delivered: a vendor version exists | `customized` |
| no package (global scope) | yes | here: no vendor version | `customer_created` |
| no package (global scope) | no | delivered: a vendor version exists | `out_of_box_as_captured` |
| no package (global scope) | no | otherwise | `unknown` |
| any but a custom application | the evidence it needs is not readable, or rows of it are hidden | | `unknown` |

Inside an installed application both happen often, a file made here and a delivered file changed here, so an
undecided case stays undecided. In a platform package a file made here is rare (5 of 1,885 changed files on the
test instance), so there a captured change means `customized`.

Two kinds of record need a detour. A dictionary entry or a field label that was never captured stores no update
name; asked for by the name it would get, it is found by the table and field that name describes. And the entry of
a system field such as `sys_id` belongs to no package, because the platform generates it together with the table:
for it, the package of the table answers the first question, and the answer says so.

An `unknown` always comes with its reason in `explanation`.

### What was measured

On one instance of the Australia release, with `npm run origin-check`:

- **Against the upgrade engine.** The last family upgrade skipped 79 files because it found them changed. For 77
  of them `sn_origin` answers `customized`. The other two are system properties: the file carries the sys_id the
  vendor gave the property, the instance holds the property under another one, so no record answers to the file
  name and the verdict is `unknown`. This is not an independent confirmation for all 77: 36 of them have no
  customer update at all, and `sn_origin` knows about them only because it reads what the upgrade found. Before it
  did, it called those 36 out-of-the-box.
- **198 random application files:** 184 `out_of_box_as_captured`, 14 `unknown`. It abstains on one file in
  fourteen. Those belong to no package: parts of flows and actions, which are captured with their parent and carry
  no name of their own, and the tables of the text index.
- **197 random captured changes:** 100 `customer_created`, 69 `customized`, 26 `custom_application_file`, 2
  `deleted_here`. Of the 69 customized records, 60 were captured under system accounts and 9 by people.
- **Fields nobody touched.** Two in three dictionary entries of the instance (207,943 of 299,720) store no update
  name, because they were never captured. Asked for by the name they would get, such as
  `sys_dictionary_incident_category`, they are found by the table and field the name describes.
- **System fields.** One application file in nine (143,264 of 1,236,269) belongs to no package. Most of them are
  the entries and labels of system fields. In a sample of 150 such entries, 131 described a system field of a
  table that has a package. Before these were judged by their table, `sn_origin` left one file in six `unknown`
  (27, 30 and 34 in three samples of 200).

What follows from that:

- **`out_of_box_as_captured` means "no captured change", not "unchanged".** A record can differ from the vendor
  version without any captured change: a property set by a script, a role changed by an installer. Only an upgrade
  notices, by comparing content, and this server cannot compare content. Where no upgrade has looked at a record
  yet, such a change is invisible here.
- **"Customized" is the platform's word, not a statement about people.** On this instance most of the customized
  records were changed by installations, upgrades and jobs (60 of 69 in the sample), and 2,783 of all 6,631
  captured changes have no person on them at all. `capturedBy` tells them apart, `sn_delta` counts them, and its `peopleOnly`
  leaves them out.
- **The rule is measured on one instance.** The verdicts were compared with the upgrade engine and with the stored
  evidence, not checked by hand, and not on a second instance. Update rows and versions can be cleaned up or lost
  in a clone. Run `npm run origin-check` on your instance before you rely on the verdicts there, and check a
  sheet of them by hand (see [Development](#development)).

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
npm run origin-check  # measures sn_origin on the configured instance, with about 1,200 requests
```

`npm run smoke` drives the real server through an MCP client and exits with 1 if a check fails. It prints counts and
verdicts, never record content. `npm run call` runs one function from the shell and prints what an agent would
receive. In the Windows command prompt, write the JSON with escaped double quotes instead of single quotes:
`"{\"table\":\"incident\"}"`.

To check the verdicts of `sn_origin` by hand, let it write a sheet:

```bash
npm run --silent origin-check -- 25 --sheet > sheet.csv
```

That is one line per judged record instead of counts: 25 files the last upgrade skipped, 25 random application
files and 25 random captured changes, each with its verdict, a link that opens the record, and two empty columns
for your own verdict. The sheet names records of your instance, so keep it to yourself.

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
