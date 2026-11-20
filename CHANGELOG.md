# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0 a minor version can change the shape of an
answer; such changes are listed under "Changed".

## Unreleased

### Fixed

- **A list read page by page brought some rows twice and missed others.** Measured: where rows are equal in what
  a query sorts by, the instance gives them another place from one page to the next. `sn_delta` sorts captured
  changes by the time of their last change, and most of them share it with a neighbour (244 of 299 in a row): ten
  pages of a hundred were 989 different rows, so eleven customizations were listed twice and eleven never. The entries of
  upgrades were 153 of 158, a query sorted by type 753 of 1,000. Every sorted query is now sent with the sys_id
  as its last sort key, in the direction of the key before it, which costs nothing when measured on a table of
  3.5 million rows. Each of these reads then brought every row once. The answer names the query as it was sent.
  A query that asks for no order is sent as before: read by pages it brought no row twice.
- **The thirty largest groups were not the same thirty on every call.** Measured: the instance gives the groups of
  a count another order from one request to the next, three orders in five requests. `sn_delta` and
  `sn_upgrade_skips` now put groups of the same size in the order of their names, as `sn_query` did already.
- **`sn_origin` gave up on a record that stores no update name.** Measured: a third of the application files of
  an instance store none, because they were never captured. Dictionary entries and labels were already found by
  what they describe. For any other class the answer was `unknown`, with the claim that such a record is captured
  as part of another one. That is true for the parts of flows and actions, and wrong for 10,804 files of the test
  instance, among them 6,079 roles of access controls and 2,765 access controls: the other records of those
  classes are named `<table>_<sys_id>`, and changes to them are captured under such names. `sn_origin` now reads
  the first and the last five names of the class. Where all are built that way, it judges the record under the
  name it would get and says so; where no record of the class carries a name, or the names follow another rule,
  the verdict stays `unknown` and the warning says which of the two it is. Such a call costs 6 requests, not 1.

### Added

- **`npm run compare`** holds the server against the instance asked directly, past everything the server does to
  a request. It reads the dictionary a second time, one table of the parent chain after the other, and compares
  each field with what `sn_schema` says; and it sends a few hundred encoded queries both ways. On the test
  instance: 2,727 fields of 55 tables without a difference, and of 331 queries 311 with the same total and the
  same first rows, 18 refused as intended, two sent with a condition added on purpose (properties that hold a
  secret). It also reads whole rows both ways (2,019 cells: 60 differ, each marked as withheld, as cut, or as a
  time kept in UTC) and counts per value (21 of 21 the same as the Aggregate API). It ends with 1 if anything
  differs, so it can run before a release. Its first run found the rows that change places between pages.
- **A list of counts that was cut did not say so.** `sn_delta` and `sn_upgrade_skips` list the thirty largest
  groups of `byType` (and `byDisposition`). Where there were more, the rest was left out without a word, and a sum
  over the list came out below `total`. Both now say how many groups there are, and `sn_delta` how many rows the
  ones left out hold between them.

## 0.4.0 (2026-11-20)

Found by three reviews of 0.3.4, by a fourth round on the fixes, and by measuring on a live instance what they
claimed about the platform. The fourth round found three mistakes in fixes of the same day, before a release.
A minor version, because two answers changed their shape: see "Changed".

### Security

- **A closed table could be read through the parts it is stored in.** Measured: a rotated table is spread over
  parts. `syslog0003` extends nothing, is read like any table, and answered with 655,964 rows of `syslog` and of
  its child tables. An archive table, `ar_<table>`, extends nothing either. Both are closed now with the table
  whose rows they hold, and where that table is open and has a closed table below it, they are closed all the
  same. Which tables are parts, the instance lists in `sys_table_rotation_schedule`, and that list decides:
  measured, 319 of 327 parts are named after their table with four digits and 8 with one. Where the list cannot
  be read, a name that ends in digits counts. An archive or a part of a table that carries payloads and names
  (`ar_sys_update_xml`) is read like that table.
- **An update name in capitals got past the check.** Measured: the instance finds `sys_script_<sys_id>` under
  `SYS_SCRIPT_<sys_id>`. `sn_origin` then answered with the readable name and the change history of a record of
  a closed table. A name is judged in small letters now. A name that begins with nothing that can be a table
  counts as one that cannot be told.
- **The list of child tables could be short without a sign.** Measured: a condition the instance cannot use is
  dropped, and where it stands behind another in a chain of `^OR` it then matches nothing. For an account that
  may read what a table extends and may not filter by it, the tables named on a list would have come back and
  none of their child tables. The name of a table and each level of its parents are now asked alone for a table
  that is two things at once, which has to match nothing, before a list is trusted, and the lists ask with the
  condition that was proven. Several such questions in one query prove nothing: measured, a part of a query
  joined by `^NQ` whose conditions are dropped adds no rows. A name read from the table of tables has to be the
  name of a table before it goes into a query: one that carried a condition would have rewritten the condition
  that leaves the rows of closed tables out.
- The proof that the instance applies a condition on the class of a row asked only whether the class is empty and
  filled at once. It now asks the same for "is one of", where a list has a pattern for "starts with", and, where
  a row shows its class, for "is not one of", which is the condition that leaves the rows out: an instance can
  allow one kind of condition and not the other. A table without rows answered every such question with nothing,
  and that answer was remembered for the rows that came later. It holds for one request now, and a proof is kept
  for ten minutes, not for good.
- **A linked application file gave away the record it links to.** Measured: such a file is named after that
  record, through a field it inherits, and carries it as its payload. The check for names went by the table that
  defines a field and missed it. Read from its own table, the name is now held against the table the row names;
  read as rows of `sys_metadata`, where nothing says which table the record is of, linked files are left out
  while tables are closed, and their captured changes count as those of a closed table.
- **A payload hid the table of a record behind the way it was written:** a `>` inside an attribute in front of
  the one that names the table, an element that was never ended, a second wrapper, a name in capitals or with a
  prefix, a document inside a CDATA section without an action on its record, markup written with entities, by
  name or by number. A payload that names more than forty tables is withheld without looking at each, and so is
  the captured change of a linked file that does not say what it copies.
- **The secret scrubber missed a value** behind an attribute that holds `>`, in a value split over two CDATA
  sections, in an element with a prefix (`wsse:Password`), behind a closing tag with a blank in it, in markup
  written with entities, behind an escaped `/` or `=` or a line break in JSON inside a JSON string, and in a
  system property whose record carried a second element called "type" or the text `</sys_properties>` inside a
  CDATA section. Checked on 1,292 real payloads of an instance, 2.3 MB: the old and the new reading take out the
  same 359 values, and the new one finds one more table, a record carried inside another.
- A parent chain that one request could not read to its end was taken for complete where the next request came
  back empty: a table nine levels below a table that is not on the list of readable ones passed for open.
- A database view that came back without a table it joins passed every check that goes by those tables. A view
  that joins another view was refused by a query and still described by `sn_schema`.
- A table the deny list names counts for the names of its records whether or not the instance still lists it:
  the captured changes of a table that was dropped are still there.
- What a field shows beside its stored value is passed on only for the kinds of fields measured to show nothing
  of other records. Measured for each of the 167 kinds of fields of one instance: 35 show something other than
  they store, among them a condition, which shows the names behind the sys_ids it holds, and an attachment
  field, which shows the name of its file.
- A field of a database view is judged by the table it comes from also where the dictionary of that table cannot
  be read, and by its name where the definition of the view cannot be read either: there a field called `value`
  counts as the value of a system property, and the answer says that this is why. Before, the value of a system
  property, a payload or the name of a record of another table passed there unrecognised.
- More tables whose rows carry names of records of other tables: what another instance sent for comparison, what
  one scope may use of another, and the records people picked in reference fields.
- With a list of the only tables that may be read, the server went on reading `sys_db_object` and
  `sys_dictionary` where the list closed them through their parent. That closes everything now, as the README
  said, and the message names the table that is missing from the list.
- A text search is refused on a table below the table of system properties, and, while tables are closed, on a
  table that holds the names of records of other tables or points to one. A text search refused because of a
  closed table is reported as that, `blocked`, where it was reported as a mistake in the input.

### Fixed

- **A login rejected in the middle of a call** made `sn_plugins` say that a table is closed on this machine, and
  `sn_dependencies` answer with every category unchecked. A rejected login, an instance that can no longer be
  reached and the limit of requests now end the call they happen in, whichever look-up caught them: the client
  notes the failure, and it is the answer of the call. A setting of the instance that could not be read because
  of a time limit was remembered as "unknown" for ten minutes.
- `sn_origin` said "not found" for a record that a table had left out with the rows of its closed child tables,
  and "out of the box" where the instance gave no total for the entries of upgrades, so that a newer entry could
  be hidden. Whether rows were left out is read from the query that was sent: a name that says which table its
  record is of still gets "not found". Where the entries of upgrades cannot be read at all, the verdict stands
  as before, and the answer now says that a change nobody captured was not looked for.
- **A call refused because of a closed table left no line in the audit log** where it was refused before any
  request was made, which is most of them. It has one now, with what was asked.
- **One call could send 1,460 requests** by naming 730 tables that do not exist. A call ends after 500 now. The
  same condition is looked up once however often it stands in a query, and a list that could not be read is
  asked for once.
- With a list of the only tables that may be read, the names of labels and dictionary entries were withheld
  although their table was on the list: only the four longest beginnings of a name were looked up. A name whose
  beginning cannot be a table ended the call with an error. The tables of a page of names are asked for
  together now: measured, `sn_delta` with 200 rows stays at 32 requests.
- A name that ends in a sys_id mostly says which table its record is of. With business rules closed, the names
  of script includes were withheld as well, because `sys_script_include_…` also begins with `sys_script`. What
  stands before the sys_id is now taken for the table where the instance has a table of that name. Measured:
  `sys_ui_form_sections_<sys_id>` is a record of `sys_ui_form`, and no table is called `sys_ui_form_sections`.
- **A request longer than the instance takes is not sent.** Measured: an address of 8,218 characters was taken
  and one of 8,223 answered with HTTP 414, and a caret, a comma or an equals sign takes three of them. The limits
  counted the characters of the query, so a query of 3,000 characters could fail that way.
- Five more inputs cost their length squared: many elements that share one end with blanks behind it, wrappers
  that never end, an update name of thousands of words, a run of CDATA sections with many elements in front of
  it (3.5 seconds for 121 KB), and closing tags that end nothing (7.4 seconds for 109 KB). Eighteen shapes of
  hostile text of about a megabyte each now take under half a second each.
- Rows nested thousands of levels deep ended the call with an error of the runtime. They are an answer that
  cannot be used now.
- The audit writer holds at most ten thousand lines that wait to be written, and says how many it dropped.
- `NSAMEAS` leaves out the rows where the second field is empty as well, and the answer says so. Measured: 48
  incidents had a caller and nobody who resolved them, and the condition matched the 28 that had two people.
- `sn_schema` judges whether a table is closed by what it extends and joins now, not by what was read up to ten
  minutes ago. For a field of a database view it named the joined table as the one that defines the field, so an
  update name built from it was wrong for a field the joined table inherits: it names both now, and says that a
  view applies neither dictionary overrides nor the labels of child tables.
- `NSAMEAS` is looked at field by field: asking for the empty rows of one of the two fields leaves the warning
  about the other.
- **Nothing held the number of requests that are with the instance at a time.** The README said eight, and the
  functions kept to it where they knew what they were asking for. Measured with a list of the only tables that
  may be read: `sn_delta` with 200 rows had 13 requests with the instance at once, because it looks up the table
  of every row it returns at the same moment. With more kinds of records among the rows it would be more, and an
  instance answers a burst with "too many requests". The limit is in the client now, for every request of every
  function: the same call stays at eight and takes no longer.
- `sn_dependencies` counted the tables below a table five levels deep. Measured: of the 1,348 tables below `cmdb`
  on one instance, 95 are deeper, and the answer said 1,253. It counts nine levels now, as far as one condition
  walks, and says so where a table sits at the ninth, below which nothing is counted.
- The query of every category of `sn_dependencies` is held by a test: what applies to a child table always, never,
  or only with a flag on the record was measured once, and a changed word would have changed an answer unseen.
- **Thirteen of the rules this round added were held by no test**, found by a sixth and a seventh run of
  single-line changes, over 146 lines of the new code. Among them: a proof is kept for ten minutes and not for
  good; an answer that says "no row matches" and carries a row is no proof; a reference into the table of
  application files loses the name behind it; a refusal is written to the audit log once; a login rejected at
  the last request of a call ends the call as well. Each has a test now.
- Four more rules without a test, found by a fifth run of single-line changes over 30 lines of the configuration,
  the paging and the error texts: the first row of an answer is always shown, however large (reading on would
  otherwise never get past it); a refusal by the instance counts as a login that worked; the roles of the account
  are looked up only with a user name that can stand in a query; a user name without a password is named as that.

### Changed

- With tables closed on the machine, the first calls cost more requests, because more is proven before it is
  relied on. Measured on a fresh server: 15 requests to list the 1,349 tables below a closed one, where it was 5,
  and 18 for the first query on the parent of a closed table.
- A text search refused because of a closed table has the error kind `blocked`, not `validation`.
- In `sn_schema`, `definedOn` of a field of a database view is the table that defines the field. The table the
  view joins is `joinedFrom`.

## 0.3.4 (2026-11-20)

### Security

- The rows of closed child tables are left out of a parent table by a condition on the class of a row. An
  instance that drops that condition, for an account that may not filter by the field, would answer with those
  rows and without a sign. 0.3.2 asked for proof on database views only. Now a table and a reference are asked
  the same question first: rows whose class is empty and filled at once, which has to match nothing. Not seen on
  an instance: the test account is an administrator, and it passes.
- **Dependencies with known advisories.** The lock file held the MCP SDK at 1.29.0 and zod at 4.4.3, and `npm
  audit` listed nine advisories against them and what they bring along (one critical, four high, four moderate).
  Most are about the HTTP transports and the OAuth client of the SDK, which this server does not use: it speaks
  over stdio only. One is about zod, which checks every input of every function. The package now asks for the SDK
  from 1.32.2 and zod from 4.6.7, so that no installation resolves to an older one, and `npm audit` lists nothing.
  Checked with the unit tests, the live test, and a call over stdio against the built server.

### Fixed

- **Thirty-one rules were held by no test:** a change to any of them went unnoticed. Found by taking a rule out
  or turning it round, one line at a time, and running the tests: 194 lines in four runs. Each of the 31 has a
  test now.
  - The rules for closed tables, 66 lines, 14 unnoticed. Among them: a child table and a database view are
    refused for the request of any tool, not only for a query the agent wrote; `sn_schema` and `sn_dependencies`
    refuse a closed table; a misspelled field of a closed child table is not answered with the names that are
    close; a payload that names no table is withheld.
  - Secrets, the parser and the client, 49 lines, 8 unnoticed. Among them: the value of a system property behind
    a reference whose table cannot be read, a text search on a table whose fields are partly hidden, the
    comparison of two payloads, and the time limit of a request.
  - `sn_origin` and the other functions, 41 lines, 7 unnoticed: a change captured by a job and by a person counts
    as one by a person, a failed file is no local change also where the instance lists its own codes, "not
    reverted" is not "reverted", an account is the same in whatever case it is written, and `sn_upgrade_skips`
    keeps back the name of a record of a closed table.
  - The checks on values and field names, 38 lines, 2 unnoticed: a time of day that does not exist, and a table
    whose fields cannot be read while tables are closed.
- Three checks that could not be reached, or only repeated another, are gone.

## 0.3.3 (2026-11-20)

### Security

- **A text from the instance could keep the server busy for minutes.** Every text an answer carries is searched
  for secrets, and a payload for the tables of its records. Both were done with patterns that look for an end from
  every beginning. A text of 40,000 elements that open a CDATA section and never end it (half a megabyte) took 3
  seconds, one of 40,000 property records that are never closed (1.2 MB) took 11, and the time grows with the
  square of the length, up to the 10 MB an answer may have. Whoever can write a long text into a record the agent
  reads could stall the server that way. Both are now read in one pass that never searches a stretch twice: the
  same texts take 11 and 28 milliseconds. Checked against the old code on 721 texts of the test instance
  (payloads, scripts, deleted records): the same result on every one. The first case since 0.3.1, the second
  since 0.3.2. Found without a reviewer, by timing the new code on hostile input.
- A secret inside markup that sits in a CDATA section of another element was passed on: a record inside a text
  inside a record. It is read like the outer one.

## 0.3.2 (2026-11-20)

Six reviews of 0.3.1 by a second model, each from another corner, three more of the reworked code, and what they
found. Every claim about the platform was measured on an instance before anything was changed; the numbers are in
`docs/encoded-queries.md`.

### Security

- **A text search sent without a list of fields skipped every check on secrets.** A text search names no field, so
  a call without `fields` named none at all, and the check ended early: `123TEXTQUERY321=…` on `sys_user` was sent,
  and on `sys_properties` it was sent without leaving out the properties that hold secrets. Since 0.3.1, which
  added that protection. A text search is now also refused where the fields of the table cannot be read
  completely, where a field without a type has a name that suggests a secret, and on a table with a field that
  carries whole records.
- **Closed tables are now decided in one place, for every request of every function** (`src/closed.ts`). Until
  now each function had to remember the rules, and several did not:
  - A query on a parent table returned rows of the child tables of a closed table. With `cmdb_ci_server` on the
    deny list, a query on `cmdb_ci` left out the rows of that class and nothing else: the Linux and Windows
    servers came back. Measured on one instance: 19 rows were left out where 41 belong to the closed table. The
    server now asks the instance once which tables are below the closed ones, eight levels down. The question
    checks itself, and where its answer cannot be trusted nothing is sent. Since 0.3.0.
  - The name behind a reference came back where the reference points to a child table of a closed table, to a
    parent table of one, or to a target that did not come back from the dictionary. The same went for the labels
    of counted groups, and such a reference could be compared with text and sorted by.
  - A dot-walk into a parent table, and a database view that joins one, read the rows of its closed child tables.
  - `sn_origin` read a record of a closed table, by its update name and through the table of application files,
    and returned when it was created and by whom. `sn_upgrade_skips`, `sn_dependencies` and the look-up of the
    account's roles walked references into closed tables. `sn_plugins` read store applications from the parent
    table when their own table was closed.
  - `sn_query` passed on the readable name of a captured record of a closed table (`target_name`,
    `record_name`), which the other functions withheld, and let it be compared, sorted and counted.
  - A payload was judged by the first record it carries. Measured: 127 of 150 payloads carry more than one. Now
    every table in it counts, a payload that names none is withheld, and the names of other records are taken out
    of the payloads that are passed on.
  - A text search finds a record by the name behind one of its references (measured). It is refused on a table
    that points into a closed one.
  - With a list of the only tables that may be read, a table on the list came back as rows of its parent where a
    table between the two is not on the list: `task,u_*` let a `u_` table below a closed table through. Such a
    table is closed, and where the tables below a table cannot be listed, nothing is sent.
  - What the instance lists neither as a table nor as a database view was read as if nothing were closed. It
    counts as closed now, and so does a database view that joins another view.
  - The text of comments and work notes is rows of `sys_journal_field`. It is left out where that table is closed.
  - `sn_schema` and `sn_dependencies` described a closed table: its fields, its rules, its child tables. Both
    refuse it now, and a field name that does not exist on a closed table is no longer answered with the names
    that do.
  - The server's own look-ups went past the rules: for business rules that hide rows, archive rules, rotation,
    choices, labels and dictionary overrides. Only the four tables the rules themselves are decided from are read
    without them now (`sys_db_object`, `sys_db_view`, `sys_db_view_table`, `sys_dictionary`). A list that closes
    `sys_db_object` or `sys_dictionary` through a parent table closes everything, and the answer says so.
  - The names of deleted, archived and linked records (`sys_audit_delete.display_value`,
    `sys_archive_log.display_value`, `sys_metadata_link.sys_name`) were passed on where the record is in a closed
    table.
  - An update name was matched against the first table name that fits. `task_sla_<sys_id>` fits `task` as well:
    the longest table that exists decides now, and a record without an update name counts as closed.
  - The list of tables below a closed one ended eight levels down. Measured on one instance: 5 of 10,806 tables
    have a parent eight levels up, none nine, so a larger instance can have tables the list missed. The server
    asks again for what is below a table it finds at the eighth level, and follows every chain up to its root.
  - The lists of child tables are built from conditions on the parent of a table. An account that may not read
    that field could be answered as if they were not there: the named table would come back, and none below
    it. The instance now has to show one table together with its parent before a list is trusted. (Not seen on
    an instance: the test account is an administrator.)
  - `sn_origin`, asked by the sys_id of a record of a closed table, found its update name through a captured
    change and read its history. It stops there now. Where application files of closed tables were left out of
    its look-up, it no longer says "not found" of a record that can be one of them.
  - A record inside a payload was seen only where it carries an action. An element directly inside a wrapper
    counts now, with or without one.
  - A name behind "is not" on a reference was looked up in the referenced table. Where rows of that table are
    closed, the look-up said "no such record" of a record that is there, and so told which sys_id belongs to a
    closed table. No look-up is made there, and the answer says so.
  - A database view can list the fields it shows of a table. Before the server leaves the rows of closed child
    tables out of a view, it asks the view a question that has to match nothing. Where it matches, the instance
    drops conditions on the class of that table, and the view is not read.
- **Secrets inside a text:** a secret in JSON that sits in a JSON string was passed on where its value carries an
  escape (`\\u003d`, `\\/`), and so was the value of a system property whose type stands in CDATA. The values
  `sn_query` counts by with `groupBy` are cleaned like every other text, and long ones are cut.
- A request the rules for closed tables refuse was not written to the audit log, although the README said so.
- **Secrets inside a payload:** the value of a system property was passed on where its type carried an attribute
  or was empty, a text shorter than 20 characters was not looked at, and a value of another record in the same
  payload was taken out by mistake. JSON keys such as `x-api-key` and `accessKey`, numbers, and JSON inside a JSON
  string are recognised.
- `ref_<the table itself>.<field>` was refused only where the dictionary was fully readable.
- A system property whose name and type both come back empty is withheld.
- A payload reached through a reference could be searched where the dictionary was not readable.
- Deleted records are kept whole as text (`sys_audit_delete.payload`; 41,281 on the test instance), and so are
  archived records and linked application files. These fields are treated like the payload of a captured change:
  cleaned of secrets, not searchable, and withheld where the record is in a closed table.

### Added

- **A choice label is refused behind a dot-walk too.** `parent_incident.category=Inquiry / Help` was answered with
  0 rows and a note that the values "could not be checked", and so was every correct query of that shape. The
  values are now compared with the choice list of the table the reference points to.
- **A name where a reference stores a sys_id is refused behind "is not".** Measured: `assignment_group!=Service
  Desk` returned every incident that has a group, the ones of that group included. The value is looked up first,
  because not every sys_id is 32 hex digits.
- **`sn_query` with `groupBy` says how many different values there are** (`totalGroups`), and pages through the
  groups with `offset`.
- **`sn_upgrade_skips` says for each entry who made the captured changes to the record:** people, system
  accounts only, or nobody. "What did people here change that the upgrade skipped" needed one `sn_origin` call per
  entry before. `excludeErrors` leaves out the files the upgrade could not apply. `sn_dependencies` says the same
  for each item that has a captured change (`capturedBy`).
- `sn_schema` names each dictionary override that applies to a field, with its sys_id (`overrideRecords`), the
  table a label comes from where a child table relabels a field (`labelFrom`), and for a field of a database
  view its name on the table it comes from (`sourceField`). The description says what `mandatory` does not cover.
- `sn_delta` with `peopleOnly` still counts the rows it leaves out, and `since` takes a time of day as well.
- `sn_plugins` lists the applications developed on the instance as well (`customApps`), which `sn_instance`
  only counted.
- A word on a choice that stores numbers (`priority=High`) is refused with the list of values and labels.
- `sn_query` says when it could not check whether business rules hide rows, whether records are archived, or
  whether the table is rotated. Until now a failed look-up was silence.

### Fixed

- **A condition the server adds made a query match too much** where a part of the query held no condition:
  `EQ^NQpriority=1` with an added condition returned every row the condition allows. Measured: such a part is no
  part to the instance.
- Values the instance does not reject and answers wrongly, each measured: `NULL` behind an operator other than
  `=` and `!=`, `BETWEEN` and `ON` on a true/false field, `ON` on a number field, a day that does not exist, a
  list of nothing but commas, a text search without a word, a condition joined to a text search with `^OR`, a
  bare time on a time-of-day field (`start_time>12:00:00` matched nothing, `<12:00:00` every row), and a word on
  a field of the types currency, price, percent complete, order index, integer time and auto increment.
- A refusal says where the question can be asked instead: for a related-list query, a tag, a catalog variable, a
  dot-walk through a list field and `DYNAMIC`.
- The warning about rows with an empty field came also where the query asked for those rows itself, and for
  `!=NULL`, which asks for the opposite. It now comes for `NSAMEAS` as well, which leaves them out too.
- A field that holds a secret can be asked whether it is filled also as `=NULL` and `!=NULL`.
- A journal field read without a list of fields came back empty without a word, and could be counted by.
- **`sn_origin` overclaimed in seven cases and abstained in four where it need not have.** It no longer says
  "created here" for a record whose package it could not read (read from its own table because the table of
  application files was not readable, or the entry of a system field whose table could not be looked up); it no
  longer takes an answer without a total for a complete one; "deleted" is not said over an update row it cannot
  see; a version from a source it does not classify counts as a possible vendor version; two records that spell
  the same update name are not told apart by guessing; a version from an update set counts as a capture where
  its update row is gone; and an update row without an author counts as a system account, as in `sn_delta`. It
  now decides from a vendor version in view where the versions could not be counted, from a vendor's current
  version where earlier versions could not be counted, and finds a field by its update name where the table of
  application files could not be asked. It sends no request whose answer it would not use: 1 instead of 4 for a
  record the account may not read. Checked on the test instance against 0.3.1, on the same 670 records: no
  verdict differs, and 77 of the 79 files the upgrade skipped as changed are `customized`, as before.
- `sn_dependencies` listed the choices of a parent table beside those of the table where it could not count
  which table they belong to, listed every language of a choice when inactive ones were asked for, and listed
  unpublished workflow versions then. It names what it does not see for a field: client scripts that run when
  a form loads or is submitted.
- `sn_plugins` and `sn_instance` treat an application table that is closed on the machine as "could not be
  checked", and `sn_instance` says when it could not check for domain separation.
- The disposition and review codes of upgrade entries are read from the instance without an exception: "not
  reviewed" was the built-in code 1. A failure to read them is not remembered for ten minutes any more, and
  neither is a failure to read the company code.
- A renewed token is tried also where the request had waited for the rate limit before.
- **A login the instance rejects, and an instance that does not answer, were reported as "blocked" while tables
  were closed on the machine.** `sn_instance` then succeeded and listed every source as blocked. Such a failure is
  passed on as what it is, by every function.
- `sn_origin` took an answer without a total for a complete one in three more places: a delete was called the
  newest change, an empty answer of the table of application files was taken for "no such file", and "no version
  is marked current" for established.
- `sn_upgrade_skips` with `excludeErrors` and `onlySkipped: false` left out the entries without a disposition
  (measured: "NOT IN" skips empty fields). It says when it took the codes of failures from its built-in list, and
  refuses the two inputs together where every skipped disposition is a failure, instead of sending a query without
  a value.
- Of several names behind `NOT IN` on a reference, only the first three were looked up. All of them are now, in
  one request.
- The note that "is not" leaves out empty rows was dropped as soon as an "is empty" stood anywhere in the query.
  It is dropped only where the two are joined with `^OR`. Measured in both APIs: `^OR` binds to the condition
  before it.
- Groups of the same size had no fixed order, so that a group could come twice or not at all when paging with
  `offset`.
- `sn_delta` accepted a day that does not exist for `since`, which the instance answers with every row.
- A rotation entry or a company code that is hidden from the account was read as "not rotated" and "not set".
- `sn_dependencies` returns each query as it was sent, with what the rules for closed tables added.
- `ref_<the table itself>.<field>` is refused by its name alone: the refusal needed a readable table of tables.
- The warning that only installations are on the captured rows of a record applies to accounts written in
  another case as well (`System`), as the instance compares them.
- **`sn_dependencies` took an empty category for "nothing attached" on an instance that answers a query it cannot
  use with no rows** (`glide.invalid_query.returns_no_rows`, a setting of hardened instances). Its check that a
  condition was understood needs a row to look at. Where no row matches and that setting is on, or cannot be read,
  the fields of the condition are looked up in the dictionary instead.

## 0.3.1 (2026-11-20)

### Security

- **The value of a system property that holds a secret was handed out under another name.** Measured: the Table
  API accepts `ref_sys_properties.value` on `sys_properties` itself and returns the field under that name. The
  server took that for a path into a child table and passed the value on. 0.3.0 has this defect. Found by review.
- **The payload of a captured change, of a version or of an upgrade entry carries the whole record, secrets
  included, and was passed on as it is.** What looks like a secret is now taken out of such a text (the content of
  an element or the value of a key whose name suggests one, and the value of a property of a password type), the
  payload of a record in a closed table is withheld, and a payload can no longer be searched, sorted or counted
  by. The comparison of two payloads (`payload_diff`) is not passed on. The name pattern was checked against the
  1,090 secret fields of one instance and widened; it knows all but a handful.
- **A closed table could be read through its child tables and through its parent.** A contact is a user: with
  `sys_user` closed, `customer_contact` answered. And `task` answers with every incident. A child of a closed
  table is now closed too, and a query on a parent leaves the rows of closed child tables out with a condition on
  `sys_class_name`. `sn_delta`, `sn_upgrade_skips` and `sn_origin` no longer pass on the readable name of a record
  in a closed table.
- **A text search could probe a field that holds a secret**, because it looks into fields the query does not name.
  It is refused on a table that has such a field, and on `sys_properties` the properties that hold secrets are
  left out of it.
- A dictionary entry that came back without its type counted as proof that a field holds no secret and points into
  no closed table. Now the name of the field decides, as where the entry is missing.
- With tables closed, a field that can point to any table could still be compared with text.
- Choice values and labels went into messages unquoted.

### Added

- `sn_query` says when business rules run on every read of the queried table. Such a "before query" rule can hide
  rows depending on who asks, and the total counts only what it lets through. Measured: 183 active rules of that
  kind on one instance, among them two that apply to incident and ten that apply to customer service cases.
- `sn_query` says when the queried table archives its records (an active archive rule moves them into another
  table) and when it is rotated (a table such as `syslog` keeps a few weeks and drops the rest). Measured: 40 active
  archive rules and 49 rotated tables on one instance. An empty answer for last year means little on such a table.
- `sn_instance` counts the business rules that run on every read of every table (`queryRulesOnEveryTable`).
- `sn_instance` names two settings that change what every answer means: whether the instance separates its data
  into domains (`domains`, read from the table of that name), which limits every row and count to the domains of
  the account, and `glide.invalid_query.returns_no_rows`, which turns a query the instance cannot use into an
  empty answer instead of an unfiltered one.

### Fixed

- **A query on the value of system properties that begins with `NQ` came back unfiltered.** The condition that
  keeps secrets out was put in front of the first part of the query, where it formed a part of its own that
  matched every property without a secret. Found by review; 0.3.0 has this defect.
- **A value of the wrong kind was sent, and the instance does not reject it.** Measured: with a date it cannot
  read (`01.01.2026`, `yesterday`), `>` matches every row; `active=yes` returns the rows where the field is false;
  a word on a number field matches nothing, also with `!=`; `LIKE` on a number field matches nothing where `=`
  finds rows; a duration compared with a number of seconds matches every filled row. All of these are refused,
  and the error says how to write the value.
- **`sn_origin` decided "changed here" on English labels.** An account that reads another language gets
  "Übersprungen" for "Skipped", and a skipped file was then reported as out-of-the-box. The decision is now made
  on the stored codes.
- **`sn_origin` looked only at the newest entry of an upgrade.** A patch that failed on a file hid the family
  upgrade before it that had found the file changed. It called a record deleted when any old update row was a
  delete, also where a newer one had made it again. It missed the current version among more than ten, and called
  a record unchanged whose current version comes from a source it does not know.
- **`sn_origin` reported an application the company develops itself as out-of-the-box** when it was installed from
  the company's repository. It is recognised by the company's prefix in its scope.
- `sn_origin` answered "not found" for a dictionary entry whose sys_id is a word, failed completely when
  `sys_metadata` could not be read, treated a record whose package cannot be read as one without a package, and
  judged a field whose name merely begins with `sys_` by its table. It now needs four requests where it needed
  five.
- **A condition on a journal field was sent, and a journal field read without display values came back empty
  without a word.** Measured: `work_notesISEMPTY` and `work_notesISNOTEMPTY` return the same rows, and
  `work_notesLIKEa` finds more incidents than there are work notes. Such a condition is refused, with the query on
  `sys_journal_field` that answers the question exactly. An empty journal field in an answer is explained.
- The label of a choice was recognised in English only. An account that reads another language is shown other
  labels, and a choice made in a German session has no English one. Labels of every language count now.
- `sn_dependencies` with a field listed the choices of a parent table next to the table's own, which replace
  them, and never flagged a captured change for choices and form sections, because those carry no update name of
  their own. Their changes are captured under the name of the choice list or of the form section, and are found
  there now.
- `sn_dependencies` listed, as fields that reference a table, every field that references one of its parents too:
  496 for incident, of which 172 point at incident itself. It lists those that point at the table itself.
- `sn_instance` reported "0 roles" where the lookup of the account through the user table returned nothing.
- A timestamp was returned with both its stored and its shown form where the account shows dates in another
  format. A count per value of a list field now says that it counts whole lists, not entries.
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
