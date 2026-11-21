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
| `sn_plugins` | Which plugins and applications are installed, and which applications were developed here? |
| `sn_delta` | What was changed on this instance, by whom and when? |
| `sn_origin` | Is this record out-of-the-box, customized, or customer-created? |
| `sn_dependencies` | What configuration is attached to this table, or to this field? |
| `sn_upgrade_skips` | What did the upgrade skip, who had changed it, and what still needs a review? |

It also serves three MCP prompts, `verify_claim`, `review_upgrade` and `assess_change`, and one resource,
`servicenow-sparring://limitations`.

## Evidence you can run again

Every answer that is not an error names where it came from, what it cost, and how complete it is:

```json
{
  "instance": "example.service-now.com",
  "fetchedAt": "2026-11-20T02:14:07.512Z",
  "requests": 6,
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

`requests` is 6 here because it is the first call on this table: five of them looked at the table itself. The
next call on it costs one. An error is shorter: its kind, a message, a hint, and the table it is about where
there is one. More examples, also of refusals: [docs/examples.md](docs/examples.md).

The Table API mostly does not reject a condition it cannot use. It drops the condition and answers with every
row, or it matches nothing. Both look like an answer. Five rules keep the evidence from lying:

1. **A query on a field that does not exist is refused.** ServiceNow drops a condition on an unknown field and
   answers unfiltered. One typo would turn "no match" into "here are some records". Field names, dot-walks
   included, are checked against the instance dictionary before anything is sent, and the error names similar
   fields. Where the dictionary cannot be used, the names are checked against a row of the table itself. Where
   neither works and the table is not empty, a filtered query is not sent. A database view is its own case: it
   can list the fields it takes from a table it joins, and the instance drops a condition on any other field of
   that table (measured: 11,759 of 11,759 rows for a value nobody has), and on some that it lists. Its
   definition does not say which, so before a view is filtered, sorted or counted by a field, the instance is
   asked two things: for the rows where that field is empty and filled at once, which has to be none, and for
   one row where it is either, which has to be there: it comes back, or, where this account is not shown it,
   the count says that it exists. The first shows an instance that drops the condition, the second one that is
   set to answer what it cannot use with no rows. Without both the query is refused, unless the view has no
   row at all: then nothing can be proven, and nothing can come back either.
   How the instance is set is not read for this: a setting can be changed between the reading and the query.
   The same is asked where it cannot be read whether a name stands for a table or a view.
2. **A condition the instance would drop or misread is refused.** A dot-walk through a list field, a date
   condition with a missing part, an operator written the wrong way, a `LIKE` without a value. A date in a form it
   cannot read, where `>` then matches every row. `active=yes`, which returns the inactive rows.
   [docs/encoded-queries.md](docs/encoded-queries.md) lists the forms that one live instance dropped, misread or
   answered with nothing, and the forms that are refused because they are documented to run script. These checks
   go by the type of a field. Where the dictionary cannot be read and the names are checked against a row
   instead, the type is not known and the form of a value is not checked; `fieldCheck` says which way the names
   were verified.
3. **A value that cannot match is refused or explained.** `state=Resolved` matches nothing, because the field
   stores `6`. That query is refused, and the error names the stored value. `caller_id=Abel Tuter` matches nothing,
   because a reference is compared with a sys_id. That answer comes with the reason. `assignment_group!=Service
   Desk` leaves no row out at all, because no row holds the name: that query is refused once the server has looked
   the value up and found no record with it as its sys_id. Where the table behind the reference is closed on this
   machine, cannot be read or gives no total, the value is not looked up: the query is sent, and the answer says
   that it was not checked. A value that cannot be a sys_id at all, by its length or its characters, is refused
   before that. `assigned_to!=<sys_id>` leaves out every row without an assignee, and the answer says
   that too. The check of choice values needs `sys_choice` to be readable. It covers the fields of the table,
   inherited ones included, the fields of a database view, and fields reached through a reference, and goes by
   the active choices of the nearest table that has a list of its own: the label of a choice that was set
   inactive is not known to it. Where the check could not be made, the answer says so.
4. **Counts say what they count.** `total` is what matched on the server before row-level access rules; `returned`
   is what is in the answer. When rows were withheld, the answer says so. Three things can stand between a table
   and its answer without a trace in it: business rules that run on every read and add conditions depending on
   who asks, archive rules that move records into another table, and a rotation that drops old rows. Where a
   table has one of them, the answer says so and names the query that shows it.
5. **"Could not be checked" is never "nothing found".** A table this account cannot read is an error of kind `acl`.
   A tool that depends on it marks that part `not_checked` or `unknown`.

## What "read-only" means here

The server sends only HTTP `GET` requests, and only to two endpoints of the one configured instance: the Table API
(`/api/now/table/<table>`) and the Aggregate API (`/api/now/stats/<table>`). There is no function and no code path
that creates, updates or deletes anything. Tests hold that: one scans the source for any other HTTP method and any
other way to reach the network, one records every request the eight functions send. They run in CI on every push
to `main` and on every pull request.
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
With a token in place of a user name and a password they cannot: a token does not say whose it is, so the roles
are reported as unknown.

More guards: table names and field names are validated before they reach a URL; a value read from the instance is
checked like any other before it goes into the next query; `https` is required (`http` only for `localhost`);
redirects are not followed; requests time out; an answer larger than 10 MB is not read to the end. Until the
instance has accepted the login once, requests go one at a time, so a wrong password costs one rejected login, not
one for every request in flight.

## What leaves the instance

Everything a function returns goes to the MCP client, and from there to the model it uses. If that model runs at a
provider, the data leaves your network. Five things limit what can go that way:

- **The account.** The server reads what its account may read, and nothing else. This is the limit that counts.
- **Secrets are withheld.** Fields of a password type or an encrypted type, and system properties of a password
  type, come back as `[withheld: this field holds a secret]`. The Table API would hand them out as stored. The
  server knows the type of a field from the dictionary. Where it cannot read the type, it withholds a field whose
  name suggests a secret (password, token, secret, api_key; a field called just "key" is not taken for one), and
  the answer says that types were missing. The value of a system property that is reached through a reference,
  a database view, or a table that holds rows of `sys_properties` under another name (a table below it, its
  archive, a part of it) comes without its type, so it is withheld there whatever it holds: read it from
  `sys_properties`. That needs the table to be known as one that holds properties. An account that cannot read
  what a table extends does not know a table below `sys_properties` as one, and reads its field `value` as it
  is: withholding every field of that name there would withhold the text of every journal entry. On a database view whose definition the account may not read, a field called `value`, or
  ending in `_value`, counts as such a value, and the answer says that this is why it was withheld.
- **A field that holds a secret cannot be found out by trying.** "Starts with a", "starts with b": the number of
  matches would give a value away piece by piece, and so would the order of rows sorted by it. A field that holds
  a secret can be asked whether it is filled, and nothing else. A query that compares or sorts by the value of
  system properties leaves out the properties of a password type and those without a type, and says so; a count
  per property value is refused. A text search reads fields it does not name: it is refused on a table that has
  a field with a secret or a field that carries whole records, and on a table whose fields cannot be read
  completely. This holds for fields of a secret type, for the values of system properties and for fields that
  carry whole records. It does not hold for a secret that somebody wrote into an ordinary text, a script for
  one: the server takes it out of the text it returns, as the next point says, but a condition on that field
  still tells whether the text contains a given piece. Secrets belong in fields made for them.
- **A record inside a text is cleaned.** The payload of a captured change, of a version, of an upgrade entry or of
  a deleted record is the whole record as text. What looks like a secret in it is taken out, by the name of its
  element, and a system property in it is judged as one read from its table. Such a payload can be read, but not
  searched. The comparison of two payloads that an instance stores beside them (`payload_diff`) is not passed on
  at all: read the payload. The same is done with every text of every answer, whichever function gives it: a script that holds
  `"api_key": "…"`, or a list or an object behind such a key (`"tokens": ["…"]`), comes back with that value
  taken out, and the answer says so. A text of the instance is read before it is shortened, where a message
  quotes it or a long value is cut, and a cell that comes as an object where an instance sends text is passed
  on as the text it is written as, so that a key and its value are read together. The one text that is passed
  on as it is, is the `query` of an answer: that is what was sent, in the words of the call. It goes by the name of an XML element, or of a JSON key in quotes.
  An element is recognised where it holds text and closes: one that holds further elements is not taken out,
  and neither is `true` or `false`, which is a switch and no secret. A secret
  under a name that suggests nothing is not recognised, nor one written another way: a key whose letters are
  written as escapes, or markup whose brackets are written as numbered entities (measured: none of 6,631
  captured changes on the test instance writes markup that way). And what a name suggests need not be a secret.
  Read over 24,811 texts of the test instance, the rule took something out of 158, and most of that was counts
  of tokens, templates of connection records and cursors of paged answers: `[withheld]` says that the name
  suggests a secret, not that there was one. One name is set aside: `document_key`, the record a row belongs
  to, is passed on where it holds a sys_id. It stood in 825 of the 6,631 captured changes, in the values of
  workflows and flows, and was nine tenths of all that the rule took out.
- **Tables can be closed on your side.** `SERVICENOW_TABLE_DENY=sys_user,sys_user_*` keeps the rows of those tables
  away from the server. `SERVICENOW_TABLE_ALLOW` names the only tables the server may ask for; that list has to
  include the tables the server reads for its own checks (`npm run doctor` lists them, `sys_*` covers most). The
  functions also walk references into `sys_package`, `sys_upgrade_history_log`, `sys_ui_section`, `sys_ui_list`,
  `sys_user`, `sys_user_role` and `domain`, which the doctor does not list on lines of their own. A name can end
  in `*`. A table that both lists name is closed, and an empty `SERVICENOW_TABLE_ALLOW` allows every table that
  is not denied. One set of rules decides for every request, whichever function sends it:

  - A closed table is not asked for, and it is not reached through a dot-walk or a database view. `sn_schema`
    and `sn_dependencies` do not describe it either.
  - A child table of a closed table is closed too, because its rows are rows of that table, and so is a child of
    that child, under whatever name. The server asks the instance which tables are below the closed ones,
    however deep, and sends nothing where it cannot establish that list. It trusts the list only after the
    instance has shown that it filters by what a table extends: each level of parents is asked for a table that
    is two things at once, which has to match nothing. With `SERVICENOW_TABLE_ALLOW` this means: a table on the
    list is closed all the same if a table between it and the one you query is not on it.
  - A part of a rotated table, and the archive of a table, are closed with the table whose rows they hold.
    Measured: `syslog0003` extends nothing, is read like any table, and answered with 655,964 rows of `syslog`
    and of its child tables; an archive table, `ar_<table>`, extends nothing either. Which tables are parts of
    which, the instance lists in `sys_table_rotation_schedule`, and the server goes by that list: measured, 319
    of 327 parts are named after their table with four digits, and 8 with one. The list is remembered for ten
    minutes, and a part that the instance creates in between is not on it: so a table whose name is that of a
    rotated table with digits behind it counts as a part of it, on the list or not. Which tables are rotated is
    read from the list and from the rotations themselves (`sys_table_rotation`), because a rotation that has no
    part yet is not on the list: 3 of 49 on the test instance. Where the rotations cannot be read, such a
    rotation is not known, and its first part is a table like any other until the list has it. Where the list
    cannot be read, a table whose name ends in digits counts as a part of the table without them. Where the
    table is open and has a closed table below it, its parts and its archive are closed all the same: ask the
    table itself, which leaves those rows out. The archive of a table the deny list names is closed also where
    the instance no longer has the table.
  - What the instance lists neither as a table nor as a database view counts as closed, and so does a database
    view that joins another view, or that comes back without a table it joins: nothing says whose rows it holds.
  - A parent table answers without the rows of its closed child tables. The same holds where a query walks a
    reference into such a parent, or reads it through a database view. Those rows are left out by a condition on
    the class of a row, and an instance that drops that condition would answer with them. So it is first asked
    for rows whose class is two things at once: empty and filled, one of two names, where a list has a pattern
    beginning with two, and, where a row shows its class, of that class and not of it. Where one of these matches
    anything, the request is not sent. These questions are requests to the table itself: they ask for a sys_id
    and, at last, for the class of one row, and nothing of the answers is passed on. A table without rows proves
    nothing this way, so its answer holds for that one request and is not remembered. An instance that is set to
    answer a query it cannot use with no rows looks like a table without rows here, so where no row shows a class
    the table is asked for a row with or without one: none, from a table that has rows, and the request is not
    sent, because it would come back empty.
  - The name behind a reference is left out where the record can be a row of a closed table: the reference points
    into one, or into a table that has one below it, or it cannot be told where it points. This goes for single
    references, lists and the labels of counted groups. Such a reference can be compared with a sys_id, but not
    with text and not sorted by, because both work on the names. A text search is refused on a table that has
    such a reference: measured, it finds a record by the name behind one.
  - Other kinds of fields show names as well. Measured: a condition shows the names behind the sys_ids it holds,
    and an attachment field the name of its file. What a field shows beside its stored value is passed on for
    the kinds of fields that were measured to show nothing of other records (a label, a date in another form, a
    number with its unit). For any other kind the stored value comes alone while tables are closed.
  - The readable name and the payload of a captured change are withheld where its record is in a closed table,
    and the names of other records are taken out of the payloads that are passed on. That goes by the tables a
    payload names. One that names none, or more than forty, cannot be judged and is withheld as soon as any
    table is closed, whichever table that is. The same goes for deleted,
    archived and linked records, for what another instance sent for comparison, for what one scope may use of
    another, and for the records people picked in reference fields. An update name is judged in small letters,
    as the instance compares it, and a table the deny list names counts whether or not the instance still has
    it. Mostly a name is `<table>_<sys_id>`, but what stands before a sys_id is taken for the table only where
    the instance has a table of that name: measured, `sys_ui_form_sections_<sys_id>` is a record of
    `sys_ui_form`. Three kinds of records are captured under a name that begins with another word than their
    table, and the server knows those: the choices of a field (`sys_choice_set`), the related lists of a form
    (`sys_ui_related_list`) and the versions of a workflow (`wf_workflow_version`). They were found on one
    instance; another can have more, and closing such a table then does not keep the names of its captured
    changes back. A linked application file is a copy of a record of another table: read from its own table the
    row says which, read as a row of `sys_metadata` it does not, so that table answers without those rows. The
    entry for a deleted application file keeps the name of the record that was deleted and is treated the same
    way. A text search is refused on a table that holds such names, and on one that points to it.
  - Some of the tables that hold such names show them as their own: measured, a reference into the table of
    deleted records shows the name of the record that was deleted, one into the log of archived records the name
    of the archived record, and one into the entries for deleted application files the name of the deleted file.
    Behind a reference nothing says which table that record was of. So while tables are closed, the name behind
    a reference into one of these tables is left out, it cannot be compared with text or sorted by, and the answer
    says to read the names from the table itself, where each one is judged by the table of its record.
  - A table can show a record it points to as its own name: its display field is then a reference. Measured: 673
    tables of one instance do, and a reference into such a table shows the name behind that second reference (48
    of 60 fields). With users closed, ten of ten cells of a field two tables away carried the name of a user. So
    the server reads what the table behind a reference shows as its name, and follows it from table to table.
    Where that leads into a closed table, or to a record of any table, the name is left out like one behind a
    reference into a closed table. Where it cannot be told what a row shows (the entries cannot be read, or a
    dictionary override moves the display field), the name is left out as well. The overrides are read from
    `sys_dictionary_override` under the same rules as any table: a list that closes it, or does not name it,
    takes the name off every reference, so name it on `SERVICENOW_TABLE_ALLOW` (`sys_*` does).
  - The text of comments and work notes is rows of `sys_journal_field`: it is left out where that table is closed.
  - The server's own look-ups follow the same rules. Six tables are read without them, because the rules are
    decided from them: `sys_db_object`, `sys_db_view`, `sys_db_view_table`, `sys_dictionary` and, for the parts
    of rotated tables, `sys_table_rotation_schedule` and `sys_table_rotation`. Do not close the first four; a
    list that closes `sys_db_object` or `sys_dictionary` through a parent table closes everything. For
    `SERVICENOW_TABLE_ALLOW` that means it has to name `sys_metadata`, which the two extend: `sys_*` does. A
    list that names one of the last two as closed makes the server go by the names of tables instead. And to
    prove that the instance leaves the rows of a closed table out of a table above it, the server asks that
    table for a sys_id and for the class of one row: those answers are not passed on.
  - Where the server cannot establish which tables a request reads from, it does not send it. That includes
    what is too large to establish. The rows of closed tables are left out of a table above them by naming their
    classes in the query, and a query has a length: with more closed tables below a table than fit into 6,000
    characters, that table is refused, and one of its open child tables has to be asked. Measured: with a table
    closed that has 1,348 tables below it, its parent was refused that way. The server follows a table to its
    parents through 32 levels, reads up to 2,000 tables per question about what a deny list closes and 3,000
    below a table with an allow list, and follows what a table shows as its name through six tables. Beyond
    any of these it does not guess: the request is refused, and where it is the name behind a reference that
    leads further than six tables, that name is left out and the row is read without it.

  A closed table is reported as "could not be checked", as an error of kind `blocked`.

  What is closed is the rows of a table and the names of its records. Closing a table does not cover:

  - **How the table is built.** Its fields, labels and choices are records of `sys_dictionary`,
    `sys_documentation` and `sys_choice`, and the rules on it are records of `sys_script` and the like.
    `sn_schema` and `sn_dependencies` refuse a closed table, but a query on those tables answers.
  - **That a record of an open table points to a closed one.** The sys_id stays in the row and can be counted
    by; the name behind it is left out. The same goes for the update name of a captured change
    (`<table>_<sys_id>`): it says that a record was changed, not what the record holds.
  - **Text that happens to carry something from it,** such as the user name in `sys_created_by`, the author in
    the text of a journal entry, or a field of your own that stores the name of a record as text. The server
    keeps names back on the tables it knows to hold them, which are the ones named above.
  - **Tables that record the content of others,** such as `sys_audit`, `sys_history_line`, `sys_journal_field`
    and `live_profile`. Close those as well if they matter.

Record content that comes back (names, descriptions, scripts, error texts) is data from the instance. The server
tells the agent to treat it as data, never as an instruction, and it cuts long values. It cannot make an agent obey.

To see afterwards what an agent asked, set `SERVICENOW_AUDIT_LOG` to a file, with its full path. The server
appends one line per request:

```json
{"time":"2026-11-20T02:14:07.101Z","tool":"sn_query","api":"table","table":"sys_script","query":"collection=incident^active=true","fields":["name","when"],"status":200,"sent":1,"rows":2,"total":83,"ms":212}
```

`status` is the HTTP status of the answer. Where a request failed without a status that says so, it is the kind of
failure in its place (for example `timeout`, `network`, `invalid_response` or `too_large`), so that a 200 always
stands for an answer that was read.
`sent` is the number of HTTP requests this took: 0 for a request that was refused or held back, 2 after a retry.
A call that was refused because of a closed table has its line as well, with the status `blocked`, also where it
was refused before any request was made: the log is there to show what was tried.
The file holds no credentials and no record content. A query can contain values, so keep it as private as the
instance; on Linux and macOS it is created readable by its owner only, on Windows it takes the access rules of
its folder. The lines stand in the order the requests ended. If the file
cannot be written, the server says so once on its error output and keeps answering. If it takes lines more slowly
than they come, ten thousand of them wait at most: further ones are dropped, and a line in their place says how
many. The npm scripts do not write it.

## Requests, caching and pauses

- A list that is longer than one answer is read by pages (`nextOffset`). A sorted query on a table is sent with
  the sys_id as a sort key, added at the end where the query does not sort by it already, so that every row
  comes once: without it, rows that are equal in what the
  query sorts by change places between pages (measured: 989 different rows in a thousand captured changes read
  newest first). The `query` of an answer shows the key. A row of a database view has no sys_id of its own: its
  keys are the sys_ids of the tables the view joins, where the view carries them, and the answer says so where
  it does not, because the rows of such a view cannot all be told apart.
- One `sn_query` is one request, plus what the first use of a table takes: one to read what the table is, one
  for every 500 fields of its dictionary, three to look for rules that filter, archive or rotate it, and more
  where a value has to be looked up. Measured on the tables of one instance: five to seven. On a database view,
  one more to read which fields it takes, and two for each field it is filtered, sorted or counted by for the
  first time in ten minutes; three where the one row asked for is hidden from this account, and four, each time
  anew, while the view has no row. A sorted read asks the same of the sys_id of every table the view joins,
  which are its last sort keys. The second of the two asks for one row and not for how many there are:
  measured on eight views, the count took up to eleven seconds where the row alone came in a tenth of one. At
  most twenty fields of a view are proven for the conditions and sorts of one call, and one more for the field
  it counts by; a plain field outside the list of the view is asked about where its name is checked, and the
  sort keys where the order is made, and neither counts among the twenty. The other
  functions cost more: `sn_origin` 2 to 6 as measured on seven kinds of records, and a few more where a record
  has to be looked up in several places, `sn_upgrade_skips` about 10, `sn_dependencies` 25 to 35 (about 18 for
  one field), `sn_instance` about 50. Every answer carries its count in `requests`. At most eight requests are
  with the instance at a time, whichever function sends them.
- With tables closed on the machine, the first calls cost more: the server has to establish which tables are
  closed, what a table is a child or a parent of, and that the instance applies the conditions it relies on.
  Measured on a fresh server with one table closed: 27 requests for the first query on its parent, then 1 for the
  next and 6 for the first on another table; 3 of the 27 list the tables below the closed one where there are
  1,348 of them. With a list of the only tables that may be read, a first `sn_instance` took 156 requests with
  three entries on the list and 172 with eleven, in eleven to nineteen seconds, and a second one about 40; with
  no table closed it takes 52. A read with display values asks, once in ten
  minutes, what the tables behind its references are and what a row of each shows as its name: three requests
  for up to forty tables as a rule, and more where their names are long or they have parents that are read as
  well. Measured with users closed, the first read of twenty incidents with display values
  took 10 requests.
- One call sends at most 500 requests and ends with an error after that. A call needs that many only where it
  names hundreds of things that each have to be looked up. A call that has run for 90 seconds sends no further
  request, and ends the same way where it needs one; where the limit for one request is set above 30 seconds, a
  call has three times that. A request that is on its way at that moment is waited for, so a call whose last
  request is slow can take longer and still answer. Measured on a connection that adds 0.8 seconds to every
  request: the first `sn_instance` with a list of the only tables that may be read took 65 seconds. A request whose path and parameters would be longer
  than 8,000 characters is not sent: measured, an instance took 8,177 and answered HTTP 414 to 8,178, whatever
  the name of its host, and a caret, a comma or an equals sign takes three of them.
- A login that is rejected in the middle of a call, or an instance that can no longer be reached, ends the call
  with that error, whichever look-up it happened in. So does an answer that is not the answer of an instance: a
  page in place of data, or a refusal that is not in the JSON an instance refuses with, as a proxy in front of
  it sends. Five statuses are read by themselves, whoever sends them: 401 is a rejected login, 429 is waited
  out once, and 413, 414 and 431 are about the size of the one request. One request that runs out of time does not: where the answer does not depend on it, the answer says
  what could not be read.
- With tables closed, the server looks at the table of tables once in thirty seconds: how many tables there
  are, and which was changed last. Every answer about the tables of the instance stands behind that look: what
  a table is and extends, which names are tables, which tables are closed or below a table, and which are parts
  of a rotated one. That is one request, answered with under a hundred bytes (measured: about
  120 milliseconds). Where either differs, everything it remembers about tables is read anew. A table created below
  a closed one holds rows of it from its first row on, and without this look it was read through its parents
  until the lists were ten minutes old. Thirty seconds remain. The definition of a database view and the fields
  of a table are still kept for ten minutes: a view that is changed to join a closed table, or a reference that
  is pointed at one, is seen after that.
- The dictionary of a table is read up to 5,000 entries, the table with its parents taken together, and the
  choices of a field up to 2,000, every language taken together. Beyond that it counts as read in part: the
  answer says so, and a check that needs the whole of it is not made.
- What the dictionary says about a table is kept for ten minutes for the checks of `sn_query`. A field that is
  missing from an entry older than 30 seconds is looked up once more, so a field created during a session is
  found. `sn_schema` reads the dictionary anew for every call, for a database view also that of the tables it
  joins.
- `sn_query` says how many rows match, and on a table or view of millions of rows that count is what takes
  long. With `count: false` it reads the rows without it. Measured, twenty rows each time: of a view of four
  million rows in 0.1 seconds against 10.5 with the count, of a table of 3.5 million rows filtered by one field
  in 2.5 seconds against 5 to 37, of the same table searched for a word in 7 seconds against 14; on tables of
  some thousand rows it makes no difference. The answer then has no total, `truncated` says only that the page
  is full, and rows this account may not see cannot be told from rows that are not there: the answer says so.
  A counted read that does not come in time names the count as the likely reason.
- Whether the instance answers a query it cannot use with no rows (`glide.invalid_query.returns_no_rows`) is
  read by `sn_dependencies`, which tells an empty category from a condition that was not understood by it, and
  kept for thirty seconds. No other answer depends on what that property was when it was read.
- A `429 Too Many Requests` is waited out once, for at most five seconds.
- After a rejected login the server sends nothing for 60 seconds, unless the env file holds new credentials. While
  the instance has never answered, a request that fails to get an answer of it pauses the server for 15 seconds:
  a connection that fails, a request that runs out of time, a redirect, or an answer that is not the answer of
  an instance.
- One request of a function can be sent up to three times: once more with new credentials after a rejected
  login, and once more after a `429`. The audit log shows that as `sent`.

## Setup

Needs Node.js 22 or newer.

```bash
git clone https://github.com/munirad7s/servicenow-sparring-mcp.git
cd servicenow-sparring-mcp
npm install
```

`npm install` also builds the server into `dist/`.

Without a checkout, `npx` can fetch and build it from GitHub. The first start takes about fifteen seconds; add
`#v0.4.4` to the name to stay on one release. Checked on Linux with npm 11.

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
| `SERVICENOW_TIMEOUT_MS` | Optional request timeout, default 30000, between 1000 and 120000 |

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
account can read each one (44 of them; the tables behind the references named above are not on lines of their
own), and finally the release, the Aggregate API and the roles of the account. Nothing has to be installed on the
instance. It ends with 1 where no table can be read, or where the instance drops a condition the functions rely
on. A table that cannot be read, an Aggregate API that cannot be used, or roles that cannot be told are said in
its lines and do not change how it ends.

It also asks the instance about each field the server filters by in queries it writes itself: those of
`sn_delta`, `sn_origin`, `sn_upgrade_skips` and `sn_plugins`, and those it reads the dictionary with, 63 fields of
22 tables. It asks for the rows where the field is empty and filled at once. An instance that applies the
condition answers with none. One that does not know the field drops the condition and answers with rows; the
functions would then answer unfiltered there, and `doctor` ends with 1 and names the field. A field of a table
the account cannot read is not asked about. On the test instance 60 of the 63 could be asked, and all 60 are
applied.

Which roles the account needs depends on the access rules of your instance. Start with a read-only account and let
`doctor` show what it cannot read; the functions report such a source as "could not be checked".

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

- Without a checkout: `"command": "npx"` and `"args": ["-y", "github:munirad7s/servicenow-sparring-mcp#v0.4.4"]`.
- On Windows, write paths with forward slashes or doubled backslashes: `"C:/tools/instance.env"`.
- A desktop app may not see a `node` that a version manager installed. Then give the full path of the `node`
  program as `command`.
- The client does not start the server in the folder of this repository. That is why the env file needs an
  absolute path.

### Signing in with a token

Where basic authentication is switched off, give the server an OAuth access token in `SERVICENOW_TOKEN`. The server
does not fetch tokens itself: a token request is a `POST`, and this code base contains no request other than `GET`.

A token expires. If it lives in the file named by `SERVICENOW_ENV_FILE`, a helper of yours can write a new one
there; the server reads the file again when the instance rejects a login. Only the login is read again: another
address, other lists of tables, another limit or another audit log take a restart. An instance that answers with a redirect
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
| Who delivered the record? | the class of the package it belongs to (`sys_metadata.sys_package`), and for an installed application its scope | `provenance`: vendor, installed application, company application, custom application, global scope, or unknown |
| Was it changed here? | customer update rows (`sys_update_xml`), the version marked current (`sys_update_version`), and the newest entry of an upgrade that refused to overwrite it (`upgrade_history_task`) | `divergence`: customer changes captured, changed without capture, no customer changes captured, or unknown |
| Was it created here, or delivered? | delivered: a vendor version of the record exists, or, inside a delivered package, the record is older than its first captured change. Here, in both cases only where no vendor version exists: the record is not older than its first capture, or it belongs to no package and has a captured change | `created`: here, delivered, or unknown |
| Who made the captured changes? | the authors of the update rows; where none is left, the author of a current version that came from an update set | `capturedBy`: people, system accounts, nobody, or unknown |

"No vendor version exists" is said only where the versions of every source could be counted and each source is one
the tool classifies. A version from an update set counts as a capture also where its update row is gone. "Older
than its first captured change" means by more than five seconds: a record made here is captured as it is saved,
and the two are written a moment apart.

| Delivered by | Changed here | Created | Verdict |
|---|---|---|---|
| custom application | any | | `custom_application_file` |
| company application: installed, with the company's own prefix in its scope | any | | `custom_application_file` |
| platform or installed application | no | | `out_of_box_as_captured` |
| platform or installed application | yes | delivered | `customized` |
| platform or installed application | yes | here | `customer_created` |
| platform or installed application | an upgrade found it changed, nothing is captured | not decided | `customized` |
| installed application | a change is captured | not decided | `unknown` |
| platform | a change is captured | not decided | `customized`, or `unknown` where its versions could not be counted |
| no package (global scope, or a record outside the application files) | yes | delivered: a vendor version exists | `customized` |
| no package | yes | here | `customer_created` |
| no package | yes | not decided | `unknown` |
| no package | no | delivered: a vendor version exists | `out_of_box_as_captured` |
| no package | no | otherwise | `unknown` |
| a package that cannot be read, a package of a class without a rule, an application customization | any | | `unknown` |
| any but a custom or company application | not decided: evidence is not readable, rows of it are hidden, or it came without a total, and what is in view does not decide by itself | | `unknown` |
| no record answers | the newest update row in view deleted it, and none is hidden | | `deleted_here` |
| no record answers | nothing is recorded under the name: no update row, no version, no entry of an upgrade | | `not_found` |
| no record answers | otherwise | | `unknown` |

Inside an installed application both happen often, a file made here and a delivered file changed here, so an
undecided case stays undecided. In a platform package a file made here is rare (5 of 1,885 changed files on the
test instance), so there a captured change means `customized` unless the dates show that the file was made with
its first capture.

Three kinds of record need a detour. A dictionary entry or a field label that was never captured stores no update
name; asked for by the name it would get, it is found by the table and field that name describes. A record of
another class that stores no name is looked up under the name its class gives its records: the first and the last
five names of the class are read, and where all of them are one word that can be the name of a table, followed
by the sys_id of their record, the record is judged under the name it would get. That word is the table as a
rule, and the same word for all ten is what counts. A warning says so. Where no record of the class carries a
name, where not all of them are in view, or where the names follow another rule, the verdict is `unknown`. And
the entry of
a system field belongs to no package, because the platform generates it together with the table: for it, the
package of the table answers the first question, and the answer says so. The system fields are `sys_id`,
`sys_created_on`, `sys_created_by`, `sys_updated_on`, `sys_updated_by`, `sys_mod_count`, `sys_class_name`,
`sys_class_path`, `sys_domain` and `sys_domain_path`. Where the package of the table cannot be read, the verdict
is `unknown`.

An application a company develops on one instance and installs on another from its own repository arrives there
like an application from the store. Its scope tells them apart: it begins with `x_`, followed by the company code
of the instance (`glide.appcreator.company.code`). Such a file is reported as `custom_application_file`, not as
out-of-the-box. This rule follows the naming of scoped applications; the test instance has no such application, so
it is not measured.

"Changed here" is decided on stored codes, not on labels: an account that reads German gets "Übersprungen" where
an English one gets "Skipped". Among the entries of upgrades, the newest one that says "not overwritten because it
differs" counts, also when a later patch failed on the same file, unless it was reviewed as reverted or a newer
vendor version has become the current one since. The ten newest entries are read, and the five newest are shown
in the answer: an entry that decides can be one that is not shown, so run the query the answer names to see all
of them. Where no change is captured, none of the ten says "differs" and there are more, it is not known
whether the record was changed. Where the instance does not list which code means what, the codes
of a new instance are used, and the answer says so. A record that was deleted once and made again is not called
deleted.

Asked by a sys_id alone, a record that no longer answers is looked for by the names that end in that sys_id:
among the captured changes, then the versions, then the entries of upgrades. Only where none of them knows it
is the verdict `not_found`. Entries of upgrades that the account cannot read are a missing witness: the verdict
stands without them, and a warning says what was not looked for.

An `unknown` always comes with its reason in `explanation`.

### What was measured

On one instance of the Australia release, with `npm run origin-check`:

- **Against the upgrade engine.** The last family upgrade skipped 79 files because it found them changed. For 77
  of them `sn_origin` answers `customized`. The other two are system properties: the file carries the sys_id the
  vendor gave the property, the instance holds the property under another one, so no record answers to the file
  name and the verdict is `unknown`. This is not an independent confirmation for all 77: 36 of them have no
  customer update at all, and `sn_origin` knows about them only because it reads what the upgrade found. Before it
  did, it called those 36 out-of-the-box.
- **Random application files, six samples:** 7 of 200, 12 of 200, 14 of 198, 23 of 198, 29 of 300 and 27 of 297
  are `unknown`, the rest `out_of_box_as_captured` but for a handful that were made or changed here. The share
  differs that much between samples, so read it as "about one in thirteen". Nearly all of the unknown ones belong
  to no package, or only to the global scope (26 of the 27 in the last sample): the parts of flows and actions,
  access controls and their roles, entries and labels of fields that are no system fields, and the tables of the
  text index.
- **Records without a stored name.** A third of all application files (390,091 of 1,236,273) store no update
  name. 326,132 of them are dictionary entries and labels, found by what they describe. Of the other 63,959,
  10,804 are of a class whose other records are named `<table>_<sys_id>`: roles of access controls (6,079),
  access controls (2,765), tables (702), views (181) and 21 smaller classes. They are looked up under that name.
  For up to 120 of them per class, nothing was recorded under it, while other records of the same classes have
  such entries (64 captured changes to roles of access controls, 557 to access controls). 53,134 are of one of
  21 classes of which no record carries a name, mostly the parts of flows and actions: no captured change and no
  version on the instance is named after one of these classes, so they stay `unknown`. 19 are of a class that
  names its records another way (lists and choice sets).
- **195 random captured changes:** 97 `customer_created`, 70 `customized`, 27 `custom_application_file`, 1
  `deleted_here`. Of the 70 customized records, 59 were captured under system accounts and 11 by people.
- **This release against the one before, on the same 519 records** (0.4.2 against 0.4.1): for 145 files that
  upgrades have entries for, 150 application files and 150 captured changes, no answer differs in verdict,
  provenance, divergence, created or `capturedBy`. Of 74 records asked for by the sys_id at the end of the name
  of a version, 5 were `not_found` before and are `unknown` now: no record answers and no captured change is
  left, but versions are, and the answer says what they show. An earlier pair of releases was held against each
  other on 670 records the same way, with no verdict changed.
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
  yet, such a change is invisible here. Where the account may not read the entries of upgrades
  (`upgrade_history_task`), the verdict stands on the captured changes alone, and the answer says so.
- **"Customized" is the platform's word, not a statement about people.** On this instance most of the customized
  records were changed by installations, upgrades and jobs (59 of 70 in the sample), and 2,783 of all 6,631
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
  scripts and conditions that only name the table or field, the flow behind a record trigger, access controls
  on every table (`*`, `*.field`; asked for one field, also those on every field of the table, `table.*`),
  reports or integrations. Workflows that are not published are left out whatever is asked for, the tables
  below a table are counted nine levels down and the first fifty are named. The answer lists what is not covered.
- `sn_upgrade_skips` lists records an upgrade did not overwrite and that have a review entry. Each one needs a
  review. It is not a prediction that something breaks, and it describes only the instance that answered. For each
  entry it says who made the captured changes to the record: people, system accounts only, or nobody; where
  that could not be counted, the entry comes without it and a warning says why. Where the history of upgrades
  cannot be read, it lists the entries of every upgrade, and where no family upgrade is among the last thirty,
  those of the latest one: the answer says which it took.
- Encoded queries are parsed with a strict grammar. Related-list queries (`RLQUERY`), tag conditions, catalog
  variables and the shorthand operators `*`, `%`, `!*` are refused, because they cannot be checked.
- One answer carries about 60,000 characters of rows. Longer values are cut and marked, and the first row is
  always shown: where it is larger than that by itself, its values are cut further, to no less than eighty
  characters each. A row of many hundred fields stays larger than the budget then, and the answer says by how
  much. `sn_schema` cuts its list of
  fields the same way; `sn_plugins` and `sn_dependencies` bound their answers by the number of entries.
- The people and the system accounts behind captured changes are told apart by the user name: an empty author,
  `system`, `guest` and a name with `@snc.` in it count as system accounts. An account of your own that a job or
  an integration runs under counts as a person.
- `sn_query` warns about business rules that run on every read of the table asked for and of its parents. Rules
  on the table `global` run on every table: only `sn_instance` counts those.
- A count per value asks the Aggregate API for every group and shows a page of them, so each page of a long list
  of groups costs the whole count again. A list field is counted by its whole content: a row with "a,b" and a
  row with "a" are two groups, and the answer says so. A journal field cannot be counted by.

The resource `servicenow-sparring://limitations` carries the full list to the agent.

## Development

```bash
npm test              # unit tests against a fake instance, no network
npm run typecheck
npm run smoke         # end-to-end against the configured instance, read-only
npm run call -- sn_schema '{"table":"incident","filter":"assign"}'
npm run origin-check  # measures sn_origin on the configured instance, with about 1,200 requests for samples of 100
npm run compare       # holds sn_schema and sn_query against the instance asked directly, about 1,300 requests
```

`npm run smoke` drives the real server through an MCP client and exits with 1 if a check fails. It prints counts and
verdicts, never record content. Its last part asks the same instance through a second server on which the user
table is closed, and checks that no row and no name of a user comes back. `npm run call` runs one function from the shell and prints what an agent would
receive. In the Windows command prompt, write the JSON with escaped double quotes instead of single quotes:
`"{\"table\":\"incident\"}"`.

`npm run compare` asks the instance a second time, past everything the server does to a request, and ends with 1
if anything differs. It reads the dictionary one table of the parent chain after the other and compares each
field with what `sn_schema` says: type, reference, mandatory, read-only, length, deactivated, whether it takes
its values from a choice list, the table that defines it, and its label. And it sends a few hundred encoded
queries to the Table API as they are and through `sn_query`: one the server passes on has to bring the same total
and the same first rows, and the ones it refuses on purpose are counted apart. It reads rows both ways, for a
fixed selection of fields, and compares them cell by cell: a cell may differ where the server marks it, as
withheld or as cut, and where it keeps a time as it is stored, in UTC. And it holds counts per value against the
Aggregate API, read by pages, and tries up to twelve of the fields that each of up to twelve database views
lists. It prints counts, and for a difference the field or the query concerned, never a value. A read that the
server fails and the instance answers when asked directly is a difference; one that neither answers is counted
as left out, and so is a query the server refuses for a field the instance does not have, so look at those
counts as well as at how it ends. A view with rows that `sn_schema` does not describe makes it end with 1. Run
it with no table closed on the machine.

With `--closed` it asks the other question, for each table named: with that table closed, does anything of it
come through?

```bash
npm run compare -- --closed incident sys_user
```

It reads from the instance itself what belongs to the table (the tables below and above it, the fields that point
into it, the views that join it, the captured changes to its records) and tries the ways round that it knows
through a server of its own: the table and its child tables, rows and totals through the tables above, names
behind references, conditions, sorts and counts through a reference, text searches, views, and the names of
captured changes. A row, a name or a count of the closed table that comes back is a finding, and it ends with 1.
A check counts as passed only where the server refuses because of the closed table, or answers without anything
of it: a refusal for another reason is listed apart, because it proves nothing about the closed table. The trial
closes a table by a deny list, and per table it tries the table itself and five tables below it, eight fields
that point into it (not those of tables whose names begin with `sys_`, `var__`, `ts_` or `v_`) and six views. It
does not try a dot-walk of more than one step, the parts of a rotated table, a view that joins a view, or records
captured under a name that does not begin with their table. A check that could not be run, because a read or a
count it is built on failed, is listed and makes it end with 1 as well.

To check the verdicts of `sn_origin` by hand, let it write a sheet:

```bash
npm run --silent origin-check -- 25 --sheet > sheet.csv
```

That is one line per judged record instead of counts: up to 25 files the last upgrade skipped, up to 25 random
application files and up to 25 random captured changes, each with its verdict, a link that opens the record, and
two empty columns for your own verdict. A sample is smaller where the instance has fewer such records, or where
a record could not be judged. The sheet names records of your instance, so keep it to yourself.

What was tested, and what was not:

- Live against one instance on the Australia release, with an administrator account that did not have
  `snc_read_only`. How narrower roles and that role change what the functions can read was not measured. That
  includes access rules that restrict which fields an account may filter by (`query_range`, `query_match`): the
  test instance has more than 9,000 of them, and an administrator passes them all.
- The test instance has no domain separation, no application installed from a company's own repository, and an
  account that reads English. What the server does for those cases follows the documentation and is covered by
  unit tests only.
- Tables closed on the machine were tried live with three lists (a deny list of one table, one of a table with
  child tables and a pattern, and an allow list): the rows, names and counts came out as described, and
  `npm run smoke` repeats the first of them, and a second with business rules closed: the names of 37 captured
  changes to business rules were withheld and those of 21 to script includes passed on. More trials: with the
  table closed that stands eight levels above the deepest tables of the instance, all 1,349 tables below it were
  found in 15 requests; a database view of 44 rows, 7 of them of a closed child table, answered with 37; with
  `syslog` closed, its parts were refused, and so was the one-digit part of another rotated table when that was
  closed; with form layouts closed, the names of their captured changes were withheld; with one table closed
  that application files link to, 17 of 92 linked files came back without name and payload.
  `npm run compare -- --closed` repeats such trials from what the instance itself says belongs to a table: for
  twelve tables, among them one with 132 tables below it and one with 1,347, 684 checks passed without a finding,
  and two more were refused by the instance itself, which proves nothing either way. Before 0.4.2, with the
  stricter count of what is a pass: 282 checks on five tables, no finding, one refused by the instance. With the rule that takes
  the names off references switched off for a trial, it reported eight findings, and sixteen on three tables
  with the two rules switched off that follow a name to the table it comes from. That is a trial on one
  instance, not a proof: the rules are in `src/closed.ts`, and the unit tests hold them. What an account sees
  that may not read or filter by what a table extends was not tried, because the test account is an
  administrator: the server asks for proof of both and closes everything without it. Those proofs were only ever
  seen to pass.
- Against the instance asked directly, with `npm run compare`: in the last run 2,410 fields of 36 tables came
  out the same in every property compared, and so did seven earlier runs with other tables at random (2,727
  fields of 55 tables in one of them). Of 331 encoded queries, 298 brought the same total and the same rows as
  the Table API, 13 more the same rows once the sort has its last key, 18 were refused as intended, and two went
  out with a condition added on purpose: a comparison on the value of a system property leaves out the
  properties that hold a secret, and the answer says so. Of 2,019 cells in 24 reads of rows, 62 differed,
  each one marked: 32 values withheld or cut, and 30 times that the server keeps as they are stored, in UTC,
  where the instance shows them in the time zone of the account. 21 counts per value came out the same as the
  Aggregate API, each group once. Six sorted lists of tables and five of database views, read page by page,
  brought 3,733 rows and none twice. The first run showed one more difference, and it was the instance: rows that
  are equal in what a query sorts by change places between pages. A thousand captured changes read newest first,
  in ten pages, were 989 different rows. The server now sends the sys_id as the last sort key of every sorted
  query, and the same read brings a thousand.
- Database views with a field list, tried on 30 of them by `npm run compare`, after the 40 that were measured by
  hand: of 31 conditions on a field outside the list that no row carries, the instance dropped 15 and refused 16
  with 403 when asked directly; the server asked its question for each, and sent none of the 31 queries. Of 54
  system fields a row carried beyond its list, 52 passed the proof and were used. Of 123 fields that the lists
  of 12 views name, the instance applied a condition on 122, and the server sent it; it dropped the condition on
  one, and the server refused that one. `npm run compare` repeats the last trial.
- On another release, run `npm run doctor`, `npm run smoke` and `npm run compare` first.
- Signing in with a token is covered by unit tests only.
- CI runs the unit tests on Linux, Windows and macOS.

See [CHANGELOG.md](CHANGELOG.md) for what changed. Contributions are welcome, see
[CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE). Not affiliated with ServiceNow, Inc. "ServiceNow" is a trademark of ServiceNow, Inc.
