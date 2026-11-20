# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0 a minor version can change the shape of an
answer; such changes are listed under "Changed".

## 0.3.0 (2026-11-20)

This release closes ways in which an answer could look like evidence and not be it. Most were found by sending
query forms to a live instance and comparing counts; [docs/encoded-queries.md](docs/encoded-queries.md) lists the
measurements.

### Fixed: answers that could mislead

- **A dot-walk through a list field was certified and then ignored by the instance.** `watch_list.email=…` passed the
  field check, and ServiceNow answered with every row. Dot-walks are now followed through single references only.
- **A choice label matched nothing.** `state=Resolved` returned a correct-looking 0, because the field stores `6`.
  Such a query is refused, and the error names the stored value.
- **Malformed date conditions were dropped by the instance.** `ON` without its three parts and `BETWEEN` without
  its second value are refused. So are the units of `RELATIVEGT`, `SAMEAS` and `MORETHAN` that matched nothing when
  measured.
- **Operators that match nothing through the Table API were accepted:** `VALCHANGES`, `CHANGESFROM`, `CHANGESTO`,
  `EXCLUDING`, `DOESNOTHAVE`, `EMPTYSTRING`, and `<>`. `ISEMPTYSTRING` and `CONTAINS`, which work, were missing.
- **`DYNAMIC` conditions were accepted.** They run a script stored on the instance and are now refused, like
  `javascript:`. The check for `javascript:` also sees through look-alike letters and invisible characters.
- **Without a readable dictionary, queries went out unchecked.** Field names are now checked against a row of the
  table instead. If that is not possible either, a filtered query is not sent.
- **A field proven wrong was forgotten** when another part of the dictionary failed to load in the same check.
- **When an answer was cut to size, `returned` and `nextOffset` still described the uncut page.** Reading on from
  `nextOffset` skipped rows. Long values are now cut before rows are dropped, and paging continues behind the last
  row shown.
- **`sn_schema` listed only the table's own fields by default.** "Does incident have a field for the business
  service" was answered with no. Inherited fields are now included by default, and `filter` finds a field.
- **`sn_origin` said "not found" for a record this account may not see,** and "customized" for a record whose
  customer change an upgrade had long replaced. It also called every record created inside an installed
  application "customized".
- **`sn_upgrade_skips` took the latest upgrade of any kind for the latest family upgrade.** After a hotfix with no
  skips it would have answered "nothing to review". It also missed the plain "Skipped" disposition in its built-in
  list, and counted "Skipped Error" as a customization.
- **`sn_delta` filtered `since` on the day a row was first written.** A record changed again inside an open update
  set keeps that day; such changes were missed. The filter now uses the day of the last change.
- **`sn_plugins` matched the name only.** Asking for `com.snc.incident` or `sn_hr_core` returned nothing. It also
  failed completely when only the plugin list was unreadable.
- **`sn_dependencies` listed client scripts, UI policies and data policies of a parent table that are not inherited,**
  and transform maps and inbound actions that target the parent. It showed sys_ids where an access control has an
  operation and a type.
- A table whose dictionary entry is hidden by an access rule was reported as "does not exist". A table whose name
  contains "acl" was reported as "access denied" when it did not exist.

### Added

- `sn_origin` reads three more witnesses: the version marked current, whether a vendor version of the record exists,
  and whether the last upgrade refused to overwrite it. It reports `created` (here or delivered) and `capturedBy`
  (people or system accounts), and finds deleted records and tracked records outside `sys_metadata` by sys_id.
- `sn_query` counts rows per value of a field with `groupBy`, with the label of each value.
- `sn_delta` counts the rows captured under system accounts, and `peopleOnly` leaves them out.
- `sn_dependencies` covers seven more kinds of configuration (workspace actions, data filters, assignment rules,
  data lookups, record producers, related lists, database views), names the table and query behind every category,
  counts descendants, and takes a `categories` list. It needs about half the requests it did.
- `sn_upgrade_skips` gives exact counts per disposition and per type, the number of entries nobody reviewed, and the
  upgrades applied since the one it covers.
- `sn_schema` and the field check understand database views. `sn_schema` names remote tables, which run a script
  when read.
- `sn_instance` reports whether the server's account is an administrator and whether it has `snc_read_only`.
- Fields that hold secrets are withheld: password types, encrypted fields, system properties of a password type.
- `SERVICENOW_TABLE_ALLOW` and `SERVICENOW_TABLE_DENY` close tables on the machine that runs the server.
- `SERVICENOW_AUDIT_LOG` writes one line per request: tool, table, query, status, row counts.
- Every answer says how many requests it cost.
- A renewed token is read again from the env file after a rejected login.
- `servicenow-sparring doctor`, `--version` and `--help`. The doctor command checks the Aggregate API, the release
  property and the account's roles, not only the tables.
- `npm run call` runs one tool from the shell. `npm run origin-check` measures `sn_origin` on your instance.

### Changed

- `sn_schema`: `includeInherited` defaults to true. `columnCount` and `inheritedColumnCount` became `fieldCount`,
  `ownFieldCount` and `returned`. A column carries `mandatory`, `readOnly`, `choice` and `inactive` only when true.
- `sn_origin`: new fields `created`, `capturedBy`, `evidence.versions.current`, `evidence.upgradeSkips`; a new value
  `changed_without_capture` of `divergence`. `sysId` and `updateName` can no longer be given together.
- `sn_delta`: `createdBy` became `changedBy` and also matches the user of the last change.
- `sn_upgrade_skips`: `upgrade` defaults to `latest_family`. `byDisposition` and `byType` are exact lists for the
  whole filter instead of counts within the page.
- `sn_plugins`: `storeApps.readFrom` became `table`; both lists carry `table` and `query`.
- A redirect is an error of kind `redirect`, an oversized answer one of kind `too_large`. Both were
  `invalid_response`, with a hint about hibernating instances.
- The server no longer reads a `.env` file from the folder it is started in. Name the file with
  `SERVICENOW_ENV_FILE`. The npm scripts still read `.env`. Only `SERVICENOW_*` keys are taken from a file.

### Security

- A file named `.env` in the working directory could set any environment variable of the server, including
  `NODE_TLS_REJECT_UNAUTHORIZED`, and could supply the address that credentials from the environment were sent to.
- A token with a line break made the request fail with the token in the error message, which went to the agent.
- A wrong password was sent once per request in flight, up to 30 times for one `sn_instance`. Requests now go one at
  a time until the instance has accepted the login, and stop after the first rejection.
- A parent chain that loops, sent by a broken or hostile instance, made the server wait forever.
- A value read from the instance (an update name, a parent table) went into the next query unchecked.
- An answer was read into memory completely before its size was checked.

## 0.2.0 (2026-11-19)

First public release: eight read-only tools, a field-name check against the dictionary before every query, exact
totals, and a statement of what each tool cannot know.
