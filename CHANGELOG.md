# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0 a minor version can change the shape of an
answer; such changes are listed under "Changed".

## 0.3.1 (2026-11-20)

### Added

- `sn_query` says when business rules run on every read of the queried table. Such a "before query" rule can hide
  rows depending on who asks, and the total counts only what it lets through. Measured: 183 active rules of that
  kind on one instance, among them two that apply to incident and ten that apply to customer service cases.
- `sn_instance` names two settings that change what every answer means: whether the instance separates its data
  into domains (`domains`, read from the table of that name), which limits every row and count to the domains of
  the account, and `glide.invalid_query.returns_no_rows`, which turns a query the instance cannot use into an
  empty answer instead of an unfiltered one.

### Fixed

- When the instance refuses a request because of one field in it, the hint said the table could not be read.
  Measured: the Aggregate API refuses to count `sys_metadata` by `sys_class_name` with "Field(s) present in the
  query do not have permission to be read", while the table and the same field in a condition are readable. The
  hint now names the field as the reason.

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
- `sn_schema` showed the label of the parent table where a child table has its own: on incident, "Close notes"
  instead of "Resolution notes".
- A table whose dictionary entry is hidden by an access rule was reported as "does not exist". A table whose name
  contains "acl" was reported as "access denied" when it did not exist.
- **A condition without a value was sent.** Measured: `LIKE`, `NOT LIKE`, `STARTSWITH`, `ENDSWITH`, `CONTAINS` and
  `NOT IN` without a value are dropped and the answer is unfiltered; `IN` without one matches nothing. Only `=` and
  `!=` may come without a value now, where they mean "is empty" and "is not empty".
- **"Is not" silently left rows out.** Measured: `!=`, `NOT IN` and `NOT LIKE` skip the rows where the field is
  empty. "Not assigned to X" missed every unassigned record. The query is still sent, and the answer now says so.
- **`GROUPBY` inside a query was accepted,** although the Table API ignores it. It is refused, with a pointer to
  the `groupBy` input. Tags and catalog variables were refused in front of a condition only, not in a sort, as the
  second field of a comparison, or behind a dot-walk.
- **`sn_origin` said "not found" for a field nobody ever changed.** Two in three dictionary entries of the test
  instance store no update name. Asked for by the name `sn_schema` tells an agent to use
  (`sys_dictionary_<table>_<field>`), such a field is now found by what the name describes.
- **`sn_origin` said "not found" for a file an upgrade had skipped,** where the instance holds the record under
  another sys_id than the vendor's file. That is now `unknown`, with the name to look the record up by.
- **`sn_origin` decided on evidence it saw only part of.** A hidden current version behind a visible older one, a
  hidden upgrade entry behind a visible older one, hidden update rows behind a visible one by a system account. A
  skip by an older upgrade no longer counts once a later upgrade has applied the record. With more update rows
  than one page shows, it now asks whether a person is on any of them. It no longer searches update rows by a
  sys_id that is a plain word.
- **`sn_dependencies` with a field listed the actions of UI policies and data policies of a parent table** that
  are not passed down to child tables.
- `sn_instance` reported a partial role list as the roles of the account when some role names were hidden.
- A choice list that is only partly readable was treated as complete, and the choices of a field of a database
  view were looked up under the name of the view.

### Added

- `sn_origin` reads three more witnesses: the version marked current, whether a vendor version of the record exists,
  and whether the last upgrade refused to overwrite it. It reports `created` (here or delivered) and `capturedBy`
  (people or system accounts), and finds deleted records and tracked records outside `sys_metadata` by sys_id.
- `sn_query` counts rows per value of a field with `groupBy`, with the label of each value.
- `sn_delta` counts the rows captured under system accounts, and `peopleOnly` leaves them out.
- `sn_dependencies` covers seven more kinds of configuration (workspace actions, data filters, assignment rules,
  data lookups, record producers, related lists, database views), names the table and query behind every category,
  counts descendants, and takes a `categories` list. It needs about half the requests it did. With `field` it lists
  what is tied to one field: UI policy actions, client scripts, data policy rules, access controls, overrides,
  choices, the forms and lists that show it, and the fields that depend on it.
- `sn_upgrade_skips` gives exact counts per disposition and per type, the number of entries nobody reviewed, and the
  upgrades applied since the one it covers.
- `sn_schema` and the field check understand database views. `sn_schema` names remote tables, which run a script
  when read.
- `sn_instance` reports whether the server's account is an administrator and whether it has `snc_read_only`.
- Fields that hold secrets are withheld: password types, encrypted fields, system properties of a password type.
- `SERVICENOW_TABLE_ALLOW` and `SERVICENOW_TABLE_DENY` close tables on the machine that runs the server: their
  rows cannot be asked for, nor reached through a dot-walk, a child table or a database view, and the names behind
  references into them are left out.
- `SERVICENOW_AUDIT_LOG` writes one line per request: tool, table, query, fields, status, requests sent, row
  counts.
- Where the type of a field cannot be read, a field whose name suggests a secret is withheld, and the answer says
  that types were missing.
- Every answer says how many requests it cost.
- A renewed token is read again from the env file after a rejected login.
- `servicenow-sparring doctor`, `--version` and `--help`. The doctor command checks the Aggregate API, the release
  property and the account's roles, not only the tables.
- Two more prompts: `review_upgrade` and `assess_change`.
- `npm run call` runs one tool from the shell. `npm run origin-check` measures `sn_origin` on your instance; with
  `--sheet` it writes one line per judged record, for checking the verdicts by hand.
- `sn_upgrade_skips` and the upgrade evidence of `sn_origin` show `target`, the name the upgrade gives the record,
  next to the file name.
- `sn_origin` judges the entry of a system field (`sys_id`, `sys_created_on` and the like) by the package of its
  table. Such entries belong to no package, and were half of the records it could not decide. Every `unknown` now
  says why in `explanation`.

### Changed

- `sn_schema`: `includeInherited` defaults to true. `columnCount` and `inheritedColumnCount` became `fieldCount`,
  `ownFieldCount` and `returned`. A column carries `mandatory`, `readOnly`, `choice` and `inactive` only when true.
- `sn_origin`: new fields `created`, `capturedBy`, `evidence.versions.current`, `evidence.upgradeSkips`; a new value
  `changed_without_capture` of `divergence`. `sysId` and `updateName` can no longer be given together.
- `sn_delta`: `createdBy` became `changedBy` and also matches the user of the last change.
- `sn_upgrade_skips`: `upgrade` defaults to `latest_family`. `byDisposition` and `byType` are exact lists for the
  whole filter instead of counts within the page.
- `sn_query`: the `query` in the answer is the one that was sent. It differs from the input where properties that
  hold secrets were left out.
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
- A field that holds a secret was withheld from the answer, but could be used in a condition or a sort. "Starts
  with a", "starts with b": the number of matches gives a value away piece by piece. Such a field can now only be
  asked whether it is filled. A query that compares or sorts by the value of system properties leaves out the
  properties of a password type and those without a type; a count per property value is refused.
- The value of a system property was passed on when neither its type nor its name came back, when its type was
  empty, and through a database view whose dictionary could not be read.
- With tables closed on the machine, the names behind a list of references into a closed table were passed on, and
  so were display values of fields whose type could not be read. A hint about a misspelled field named fields of a
  closed table. A reference into a closed table could be compared with text or sorted by, which works on the names
  of the records there.
- A field to count by that could not be verified was sent to the Aggregate API when no row was visible to check
  it against.
- A token renewed between two rejected requests was not tried for a minute, because the pause after the first
  rejection stayed in force.
- The lines of the audit log could stand in another order than the requests.

## 0.2.0 (2026-11-19)

First public release: eight read-only tools, a field-name check against the dictionary before every query, exact
totals, and a statement of what each tool cannot know.
