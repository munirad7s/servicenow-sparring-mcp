# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0 a minor version can change the shape of an
answer; such changes are listed under "Changed".

## Unreleased

Two reviews, and this time before the release that carries the answers to them: one of the fixes of 0.4.3, and
one of the answers to that. The first rated 10 of 13 as holding for the case they were written for and not for
another, the second 5 of 8, with the same pattern as before: a rule that stood where the fault was found and not
where every path runs through.

### Security

- **"No table of that name" could be older than the look that keeps the lists of tables fresh.** With a list of
  the only tables that may be read, the name of a captured change is judged by the tables it can begin with.
  Which of those names are tables was remembered for ten minutes, and that answer did not stand behind the look
  at the table of tables. A table created in between, and not on the list, was not known: the name was read as
  a record of an open table with a shorter name, and `sn_origin` passed on what an upgrade entry says about the
  record. Every answer about the tables of an instance stands behind the look now, in the one place where such
  answers are given: what a table is and extends, which names are tables, which tables are closed, which are
  below a table, and which are parts of a rotated one.
- **An element and a list that reach into each other kept a secret, whichever was taken out first.** 0.4.2 read
  the elements whose name suggests a secret before the lists and objects behind such a key, 0.4.3 after. Each
  order has a text that keeps something: an element that ends inside a list takes the key of the list along, so
  that the rest of the list stays, and a list that never closes takes the end of the element around it, so that
  what stands before the list stays. All of them are found in the text as it came now, before anything is taken
  out, and what overlaps is taken out as one.
- **Taking one thing out can make the next one recognisable.** An element that holds another element is none
  that holds text, until the inner one is gone. A text is read until a reading finds nothing more, and only
  then is it quoted or cut: cut after one reading, the end that the next reading needed was gone.
- **Text of the instance was shortened before it was read, in more places than the error of a request.** A
  warning that quotes a value of the instance keeps sixty or eighty characters of it, and a long value of a row
  is cut to fit an answer. Both are read for secrets first now, in the one function that quotes and the one
  that cuts, whichever tool calls them.
- A cell that came as an object or a list, where an instance sends a text or a value with what it shows for it,
  is passed on as the text it is written as: read piece by piece, a key and its value were never seen together,
  and `{"otp": 482913}` stayed. A value with its display value is passed on as those two and nothing else.
- **What was read before everything about tables was dropped is not remembered after it.** A look-up that was
  under way when the look at the table of tables found a change wrote what it had read into what is remembered,
  and brought the old state back for ten minutes.
- **A look that came without what it looks for is no "nothing changed".** Where the number of tables or the time
  of the last change did not come back, two looks were alike whatever happened between them. Such a look
  drops what is remembered, every time.
- **A setting that cannot be read is neither on nor off.** Whether the instance answers a query it cannot use
  with no rows decides what counts as proof that a database view applies a condition. Where the property came
  back without a value, or did not come back and the instance did not say that there is none, it counted as
  off. It counts as not known now, and the stricter proof is asked for.

### Fixed

- Counts under keys that become one key, because the same part was taken out of both, are added and not lost,
  and a key called like something every object has (`__proto__`) is kept.
- A sys_id written in capitals is traced by `sn_origin` like the one in small letters.
- A company code that comes back without a value that can be read is a failed read: it was kept for ten minutes
  as "not set".
- A note that stands for something taken out is not cut in two where a long text is shortened.
- `npm run compare`: a direct read that brings no list is no answer to hold anything against, also where the
  status says 200; where neither the server nor the direct read got a list, that is a difference and the run
  ends with 1; and a setting that cannot be read is not taken for "off".

### Looked at, and left as it is

- A table that the list of rotated tables names as a part of one rotation is taken as that, also where its name
  reads like a part of another. A review pointed out that this goes wrong for ten minutes if a part is moved
  from one rotation to another. No part is: an instance creates the parts of a rotation under its name.

## 0.4.3 (2026-11-20)

Three reviews of 0.4.2, the day it came out: whether its fixes hold, which changes of one line no test would
notice, and the documents against the code once more. The first rated 13 of 15 fixes as holding for the case they
were written for and not for another. The second named fifteen changes, and all fifteen went unnoticed when they
were run. Each has its test now.

### Security

- **A list of closed tables could be older than the look that is meant to keep it fresh.** The look at the table
  of tables stood in front of the rules for a request, not in front of the lists themselves. `sn_origin` judges
  an update name before it asks those rules: called first, it read the list of closed tables without a look,
  and the first look afterwards found nothing to compare with and kept the list. A table created below a closed
  one in between was read through its parents until the list was ten minutes old. The look stands in front of
  every list of tables now, and the first one starts from nothing.
- **A rule for the name of a record did not hold behind a reference into a table below the one it is written
  for.** 0.4.2 made such a rule hold for a table below and for a view over one, read directly. Through a
  reference the rule was looked up by the table the reference points to and by the table that defines the
  field, and not by the tables between them. They are all asked now. As before: no instance measured has a
  table below one of these.
- **Asked about two tables at once, an override that came back without its table moved nothing.** Where a
  dictionary override moves what a table shows as its name, the name behind a reference into that table is left
  out. Asked about one table, an override that matches is enough. Asked about several, it was placed by the
  table it names, and one that named none was dropped: the name stayed. Such an override now leaves the
  question open for all of them, and each is asked by itself.
- **A key of an answer is a text as well.** `sn_origin` counts versions per source and uses the source as a key.
  Every text of an answer is read for what looks like a secret; the keys were not. They are now.
- **The words of an instance in an error were shortened before they were read.** A message keeps 300 characters
  of them. An element that closes behind that was no longer recognised, and what stood in it stayed. They are
  read first and shortened afterwards.
- **`sn_origin` could judge another record.** Asked by a sys_id, it looks for a name that ends in it. A name that
  came back was taken as it was: an instance that drops the condition answers with the newest row of the table,
  which is another record. A name is taken only where it ends in the sys_id that was asked for.

### Fixed

- What counts as a refusal by the instance is its own form: an error with a message in it, as measured with 400,
  401, 403 and 404. `{"error":"denied"}` from a gateway counted as one in 0.4.2.
- A row is an object of fields. An answer whose rows are lists is no answer of an instance and is refused; in
  0.4.2 such a list was passed on under a key of its own, past the fields that were asked for.
- What the list of rotated tables says about a table goes before what its name looks like. A part listed for one
  rotated table was also taken for a part of another whose name it begins with, and closed with that one.
- A list or an object behind a key that looks like a secret is taken out before the elements inside it are read,
  each bracket is closed by its own kind, and nothing is counted twice: neither a value inside such a list, nor
  what an earlier reading took out.
- A first row that is larger than an answer has its values cut to no less than eighty characters, so that a note
  of the server in place of a value is never cut in two, and the answer says where the row is still larger.
- The company code that tells a company's own applications from installed ones was read once and kept until the
  server was restarted. It is kept for ten minutes, like what is read of the dictionary.
- `npm run compare`: a direct read counts as answered only where a list came back; a view with rows that
  `sn_schema` does not describe makes it end with 1; and on an instance that answers a query it cannot use with
  no rows, an empty answer to "empty and filled at once" is no longer taken as proof that a view applies a
  condition.

### Documents

Corrected, each against the code: which refusals are read by their status alone (401, 429, 413, 414, 431); that
a call which has run for 90 seconds sends no further request, and still answers where it needs none; that at
most twenty fields of a view are proven for the conditions and sorts of a call, and one more for the field it
counts by; that the `query` of an answer is passed on as it was sent; which elements the reading for secrets
recognises; that the value of a property below `sys_properties` is withheld only where the table is known as
one; what is read of the dictionary and of choices at most; that a payload which names no table is withheld as
soon as any table is closed; how `sn_origin` decides "created here" and "unknown"; and that only the login is
read again from the env file. Measured for them: a text operator on a date compares the stored text (`LIKE2026-06`
found the 111 rows of June, as a range does); 0.4.2 and 0.4.1 give the same answer for 514 of 519 records, and
the other five are records that 0.4.1 called not found although versions of them are recorded; on a connection
that adds 0.8 seconds to every request, the costliest first call took 65 seconds.

## 0.4.2 (2026-11-20)

Five reviews of 0.4.1, each from one corner: whether its fixes hold, whether the rules for closed tables hold,
which changes of one line no test would notice, whether the documents say what the code does, and what makes a
call slow or keeps it from coming back. They named about ninety points. Each claim about how an instance
behaves was measured before anything was changed, and the measuring decided several of them: the limit on the
length of a request sits on its first line, not on its address; a group never comes with a label that was not
asked for; a date written with single digits or a `T` is read like one written in full; and none of the eight
tables with a rule for the names of records has a table below it. Of 17 changes that one review expected no test
to notice, 8 were not noticed; each has its test now.

### Security

- **A rule for a table did not hold for a table below it, or for a view over one.** What keeps back the name of a
  record of a closed table in a captured change, a version or a deleted file was looked up by the table a field is
  read on. A table that extends one of those, and a database view that joins such a table, were read without it.
  The rules are looked up along the parents now, and the tables below a table of copies are left out of a read
  through a table above. Measured on the test instance: none of the eight tables with such a rule has a table
  below it, so this closes a door no real answer went through.
- **A document id that a table shows as its name was taken for a reference to one table.** A document id points to
  a record of any table. 238 of 1,721 dictionary entries of that type name a table all the same, and the server
  read that as "shows a record of that table": with that table open, the name came through. A document id counts
  as pointing anywhere now. An entry that comes without its type is no longer read as a plain field either; what
  such a table shows counts as untold.
- **A part of a rotated table that the list does not know yet.** Such a part was told by cutting the digits off
  its name. The name is held against the names of the rotated tables now, and the rotations themselves are read
  as well: 3 of 49 on the test instance have no part yet, so their first part would have been a table nobody knew
  as one.
- **A table created below a closed one was read through its parents for up to ten minutes.** Which tables are
  below a closed one is read once and kept for ten minutes. A table created in that time holds rows of the
  closed one from its first row on, and a read of a table above it answered with them. With tables closed, the
  server now looks at the table of tables once in thirty seconds: how many there are, and which was changed
  last. One request of under a hundred bytes, about 120 milliseconds when measured. Where that differs, or can no
  longer be read, everything remembered about tables is read anew. Thirty seconds remain, and the definitions of
  views and fields are still kept for ten minutes; the README says so.
- **What looks like a secret was taken out of a text only by `sn_query`.** The name of a captured change, of a
  record or of an upgrade entry is a text as well, and `sn_delta`, `sn_origin`, `sn_dependencies` and
  `sn_upgrade_skips` passed such texts on as they came. Every text of every answer is read now, and the words of
  an instance in an error message too. An answer says so where that changed a text.
- **A list or an object behind a key that looks like a secret stayed.** `"tokens": ["…"]` and
  `"credentials": {…}` are the usual forms, and only a text or a number behind such a key was taken out. The
  whole list or object is taken out now, up to the bracket that closes it; where none does, the text is cut
  there.
- **A system property the server reads by name was passed on whatever its type.** `sn_instance`, `sn_origin` and
  the doctor read a few properties by fixed names. The names are fixed, the type of a property is set on the
  instance: one of a password type is not passed on now, as `sn_query` always held it.
- In a payload, the name behind a reference is taken out also where the quotes around it are written as numbered
  entities (`&#34;`, `&#x27;`). Measured on 6,631 captured changes: 6,611 write the quote plain and none as an
  entity, so this is for an instance that writes them otherwise.
- A row of the table of tables that came without a parent field it was asked for counted as a table without that
  parent. It counts as unread now, as a row without the table name always did.
- A view that joins a table whose place could not be read: its fields named like the value of a system property
  are withheld by name, as they already were for a view the instance does not list.

### Looked at, and left as it is

- **A condition on an ordinary text field still tells whether the text contains a given piece.** A review showed
  that a secret written into a script can be read that way piece by piece, although the server takes it out of
  the text it returns. Closing that would mean refusing every search in scripts, which is what the server is
  used for, and a rule for the forms it recognises would stop the search that names the key and not the one
  that names what stands behind the value. The README and SECURITY.md say so now: only fields of a secret type,
  the values of system properties and fields that carry whole records are closed to comparisons.
- **A secret under a disguised name is not recognised.** A JSON key whose letters are written as escapes, and
  markup whose brackets are written as numbered entities, pass. Measured: none of 6,631 captured changes writes
  markup that way. What the server takes out of a text is a net for the usual forms, and the documents say so.
- **What a view joins and where a reference points is still kept for ten minutes.** The look at the table of
  tables, once in thirty seconds, sees a table that was created, removed or moved, not a view or a field that
  was changed.
- **A field called `value` is read as it is by an account that cannot read the table of tables.** A review asked
  to withhold it there, because a table below `sys_properties` would not be known as one. That would withhold
  the text of every journal entry for such an account, and no instance measured has a table below
  `sys_properties`.

### Changed

- With tables closed, a first read with display values costs fewer requests. 0.4.1 asked about each table
  behind a reference by itself, three requests a table: what it is, what a row of it shows as its name, and
  whether a dictionary override moves that. They are asked together now, three requests for up to forty tables.
  Measured with users closed, the first read of twenty incidents with display values: 10 requests where 0.4.1
  took 27. Five other tables that took 12 to 30 take 9 or 10.

### Fixed

- **A page from what stands in front of the instance was taken for a refusal by the instance.** A proxy that
  answered HTTP 403 or 404 with a page was reported as "this account may not read the table" or "no such table",
  and it counted as a login the instance had taken. Measured: an instance refuses in JSON with an error in it,
  with 400, 401, 403 and 404 alike. A refusal below 500 that is not that is reported as no answer of an instance
  now, ends the call it comes in, and holds the next request back for a moment while no instance has answered.
  HTTP 414 is the exception: measured, it comes as a page, and it is about the one request.
- **A call had no limit in time.** Each request has one, 30 seconds unless set otherwise, and a call may send 500.
  Against an instance that answers each of them slowly, a call could run for minutes after the client had given
  up on it. A call sends no further request once it has run for 90 seconds, or for three times the limit of one
  request where that is set higher, and ends with an error that says so.
- A row comes with the fields that were asked for and no others, and a count per value with a label only where
  one was asked for. Measured, an instance sends neither unasked (five fields counted per value, with the
  parameter left out, "false" and "true"); what is not an instance is not trusted to, because the checks on what
  a row shows are made for the fields of the request.
- A count that is no number ends the call it comes in, like every other answer that is not the answer of an
  instance.
- The length a request may have was given as that of its address. It is the path with its parameters: measured,
  8,177 characters were taken and 8,178 answered with HTTP 414, whatever the name of the host.
- **A field name that every object answers to passed for a field of a row.** Where the dictionary of a table
  cannot be read, the names in a call are checked against a row of the table. `constructor` is in every row
  without being a field of it, so a condition on it was sent, the instance dropped it and answered with every
  row, and the answer said the names had been verified. The same slip was in the note about fields the instance
  left out, and in the count of versions per source of `sn_origin`, where a source of that name turned the count
  into text.
- **Texts made to be read slowly.** Two expressions took time with the square of the length of a text: measured,
  14 seconds for a tag with an attribute name of 80,000 characters and no value, and 2.7 seconds for 76,000
  characters of opening tags of a system property, written with entities, that never close. A payload can be a
  megabyte. Both take a millisecond now. After that, 1,996 long texts built from repeated pieces were timed
  through the two functions that read payloads: none took more than 300 milliseconds.
- **Work that grew with what an answer carried.** A database view may be filtered, sorted or counted by twenty
  fields in one call: each has to be proven by questions to the instance, one after the other, and a query naming
  150 would have asked for minutes. The rules for closed tables no longer search for names that look like a field
  they do not know: nobody read them, and each search compared with every field of the table. What is kept of the
  dictionary has a size: a name as wide as an instance stores one (measured: 80 characters), a label 200. Two
  tables of a view that come with the same sys_id are no usable definition.
- With tables closed, an answer that called the table of field lists of views a view itself made the server read
  that table to find out what it is, and the read waited for its own answer: the call never came back. No
  instance answers that way; the tables a view is defined in are not taken for views now.
- **`sn_origin`, asked by a sys_id, said "not found" without looking everywhere.** Where no record answered and
  no captured change ended in the sys_id, the verdict was `not_found`, though a version or an entry of an upgrade
  can be left under it: an update row goes with its update set, the version stays. Both are asked for by the
  sys_id now, one request each (measured: 0.2 seconds on 49,263 versions). Where the versions cannot be read, the
  verdict is `unknown`; entries of upgrades that cannot be read are a missing witness, and the answer says so.
- `sn_origin` reads the entries of upgrades by their codes. Where the instance did not list which code means
  "skipped" or "reverted", it used the codes of a new instance without a word. The answer says so now, as
  `sn_upgrade_skips` did.
- **One row could be larger than an answer.** Long values are cut and rows are dropped from the end, but the first
  row is always shown, and eighty fields of 2,000 characters are 160,000 with no long value among them. The
  texts of such a row are cut to what fits, and the answer says so.
- A refusal said "Nothing was sent" where the look-ups that led to it had been sent: what a table is, which
  fields it has, whether a value exists. It says "The request was not sent" now, which is what was meant.
- The doctor lists `sys_table_rotation_schedule` among the tables the server reads.
- `npm run compare`: a count per class that stopped after its first groups was still counted as passed, a count
  that failed could take back a row of a closed table that an earlier count had found, and a read that the server
  failed was passed over without asking whether the instance answers it. The first two are no pass now, and the
  third is a difference where the instance answers when asked directly.
- **A request that the instance ended because it ran too long was reported as an unknown failure.** Measured: a
  count per value of a text field of a table of 3.5 million rows came back after 61 seconds with HTTP 500 and
  "Transaction cancelled: maximum execution time exceeded". That is a request that ran out of time, and it is
  reported as one now, with the same advice. The server's own limit is usually reached before; a limit set above
  a minute is not.

## 0.4.1 (2026-11-20)

Found by measuring, not by reading: every function was held against the instance asked directly, and each
difference was followed up. Two of them were answers this server exists to prevent. After that, three reviews:
one of these changes, one of the fixes of 0.4.0, and one of the fixes that followed. Every claim of theirs was
measured before anything was changed, and several did not hold: an underscore in a value is no wildcard, and the
Aggregate API applies a condition on the class of a row wherever the Table API does. Those are noted in
`docs/encoded-queries.md`. The gravest finding came from following up one of them on the instance: with a table
closed, the names of its records came back two tables away.

### Security

- **The name of a record in a closed table came back two tables away.** A table can show a record it points to as
  its own name: its display field is then a reference. Measured: 673 tables of the test instance do, 46 of them
  show a user, and a reference into such a table shows the name behind that second reference (48 of 60 fields
  tried). The server left the name behind a reference out only where the reference itself points into a closed
  table. With users closed, ten of ten cells of a field two tables away carried the name of a user; with groups
  closed twenty of twenty; a count per value carried the names as labels, and a sort or a comparison with text by
  such a field was answered. That holds for every release that could close tables. The server now reads what the
  table behind a reference shows as its name and follows it from table to table: where that leads into a closed
  table, to a record of any table, or cannot be told, the name is left out, and comparing or sorting by the
  reference is refused. A read with display values costs two more requests for each table its references point
  into, once in ten minutes. On eight ordinary tables with users closed, no other name was left out because of it.
- **The name of a deleted record of a closed table came back behind a reference.** Measured: the table of
  deleted records shows the name of the record that was deleted as its own display value, and 83,948 rows of
  another table point into it; the log of archived records and the entries for deleted application files do the
  same. Read from those tables, a name was already judged by the table of its record. Behind a reference nothing
  says which table that was: with a table closed, 20 of 20 cells carried the name of a deleted record of it, a
  count per reference its label, and a comparison with text and a sort by the reference were answered. The name
  behind a reference into one of these tables is now left out while tables are closed, and comparing it with
  text or sorting by it is refused. `npm run compare -- --closed` tries this way round as well.
- **A secret inside a document that itself stands in a CDATA section passed.** The end of an inner section is
  written `]]]]><![CDATA[>` there, the element was never seen to end, and its content was passed on, as was every
  record of a property behind it. The same for markup written with entities that carries such a section: fifteen
  payloads of the test instance are written that way, none of them around a secret. The record of a property
  whose closing tag carries a blank, a prefix or capitals was not seen to end either, and a table named behind
  an entity with zeros in front (`&#00000060;`) was not found. On 1,292 real payloads the output is the same as
  that of 0.4.0.
- **The value of a system property could be read through a database view** in two cases the fix of 0.4.0 left
  out: a view over a table that extends `sys_properties`, and a view on an instance where the account cannot
  read the table of tables, so that the server did not know it for a view. Where it cannot be read what a joined
  table extends, the field that is named like the value of a property counts as one.
- **"Is not one of" went out unproven.** It is the condition that leaves the rows of closed tables out, and it
  was asked by itself only where the row asked for came back with its class. Where rows have a class and that
  row is hidden, or comes without the field, or the question for it fails, the request is refused now.
- **Records captured under a name that does not begin with their table kept their names.** Measured over 6,631
  captured changes, whose payload names the table, and over the application files of 1,998 classes: the choices
  of a field are captured as `sys_choice_<table>_<field>` and are a record of `sys_choice_set`, the related lists
  of a form as `sys_ui_related_<table>_<view>` (`sys_ui_related_list`), and a version of a workflow under the name
  of the workflow (`wf_workflow_version`). Closing one of those tables did not keep the names of its captured
  changes back. The server knows the three rules now. The entry for a deleted application file
  (`sys_metadata_delete`) keeps the name of the record that was deleted: read from its own table it is judged by
  its update name, and `sys_metadata` answers without those rows while tables are closed. An update name or a
  table name that names such an entry counts as a record that cannot be told, as one that names a linked
  application file does: `sn_origin` could be made to read the entry with its name.
- **A table could come back as "no table".** What the server remembers about names is bounded, and the answer
  was read back from it: a table whose entry had to make room while the same call asked about more names counted
  as no table. Under a list of the only tables that may be read, a record of a closed table could then pass for
  one of the open table its name also begins with.
- **A new part of a rotated table could be read until the list of parts was read again.** The list is remembered
  for ten minutes, and a part that the instance creates in between is not on it. A name that reads like a part of
  a table the list knows as rotated now counts as a part of it, on the list or not.

### Fixed

- **On a database view, a condition the instance drops was sent, and the answer was unfiltered.** A view can
  list the fields it takes from a table it joins; 103 of the 558 views of the test instance do. The server took
  every field of a joined table for a field of the view. Measured on 40 such views: the instance drops a condition
  on a field outside the list and answers with every row, 11,759 of 11,759 for a value nobody has, or refuses it
  with 403. A sort by such a field does nothing. It also dropped the condition on one of eight fields that a list
  did name, and on 3 of 28 fields reached through a reference of the view. That is the answer this server exists
  to prevent, and the definition of a view does not say which fields are affected. So the instance is asked:
  before a view is filtered, sorted or counted by a field, the server asks for the rows where that field, as the
  query writes it, is empty and filled at once. An instance that applies the condition answers with none; one that
  drops it answers with rows, and the query is not sent. An instance can also be set to answer a query it cannot
  use with no rows: there the view has to show a row for "empty or filled" as well. An answer is kept for ten
  minutes; one from a view without rows proves nothing and is not kept. The lists are read as well
  (`sys_db_view_table_field`): a field outside one is no field of the view, unless the instance passes that
  question for it, as it does for a few system fields a row carries beyond its list. `sn_schema` leaves the
  fields outside a list out and says how many; where the lists cannot be read, it lists every field with a
  warning. The first query that filters a view by a field costs two more requests per field. The same question is
  asked where the server cannot read whether a name stands for a table or a view.
- **A list read page by page brought some rows twice and missed others.** Measured: where rows are equal in what
  a query sorts by, the instance gives them another place from one page to the next. `sn_delta` sorts captured
  changes by the time of their last change, and most of them share it with a neighbour (244 of 299 in a row): ten
  pages of a hundred were 989 different rows, so eleven customizations were listed twice and eleven never. The
  entries of upgrades were 153 of 158, a query sorted by type 753 of 1,000. Every sorted query is now sent with
  the sys_id as its last sort key, in the direction of the key before it, which costs nothing when measured on a
  table of 3.5 million rows. Each of these reads then brought every row once. The answer names the query as it
  was sent. A row of a database view has no sys_id of its own: read sorted by pages, three views brought 322, 396
  and 298 different rows of 400. Such a read now takes the sys_ids of the tables the view joins as keys, where
  the view carries them, and eight views then brought 400 of 400; where it does not carry them, the answer says
  that rows can come twice. On a large view the keys cost time (one of 12,489 rows: 9 seconds with one key, 23
  with three), and a read that runs out of time says so. The lists the server reads whole for its own checks are
  sorted by the sys_id as well.
- **A text search on a database view found nothing.** Measured on thirty views that join a table with a text
  index: the search matched no row on the view where it finds rows on the table. "No rows" was the answer. The
  search is refused now, with the tables to search instead.
- **The thirty largest groups were not the same thirty on every call.** Measured: the instance gives the groups of
  a count another order from one request to the next, three orders in five requests. `sn_delta` and
  `sn_upgrade_skips` now put groups of the same size in the order of their names, as `sn_query` did already.
- **A table without rows could be counted as one group.** Measured: counted per class, 2 of 51 tables without rows
  and 15 views answer with one group of no rows and an empty value. Such a group is left out.
- **`sn_origin` gave up on a record that stores no update name.** Measured: a third of the application files of
  an instance store none, because they were never captured. Dictionary entries and labels were already found by
  what they describe. For any other class the answer was `unknown`, with the claim that such a record is captured
  as part of another one. That is true for the parts of flows and actions, and wrong for 10,804 files of the test
  instance, among them 6,079 roles of access controls and 2,765 access controls: the other records of those
  classes are named by their table and their sys_id, and changes to them are captured under such names.
  `sn_origin` now reads the first and the last five names of the class. Where all of them end in the sys_id of
  their record and begin with the same word, it judges the record under the name it would get and says so;
  otherwise the verdict stays `unknown` and the warning says what was found. Such a call costs 6 requests, not 1.
  It no longer takes a row of a database view for a record, and it does not trust the names of a class of which
  rows are hidden from the account.
- **A list of counts that was cut did not say so.** `sn_delta` and `sn_upgrade_skips` list the thirty largest
  groups of `byType` (and `byDisposition`). Where there were more, the rest was left out without a word, and a sum
  over the list came out below `total`. Both now say how many groups there are, and `sn_delta` how many rows the
  ones left out hold between them.
- **An answer that is JSON but not that of an instance did not end the call.** A gateway that answers `{}` with
  HTTP 200 in the middle of a call was thrown as one failed look-up, and a function that catches those answered
  "could not be read", where the same failure as an HTML page ended the call. It ends the call now and does not
  count as an accepted login. So does a request that is held back after a timeout while nothing has ever
  answered. A request that ran out of time after a login had been rejected and renewed stopped the queue as if
  the instance had never answered, and ended the calls behind it: that timeout is now about the one request. The
  audit log wrote the status 200 for a request that failed with an answer of HTTP 200 (too large, an error
  inside it, no list, a count that is no number): it writes the kind of failure now.
- **A page of update names could cost hundreds of requests.** Under a list of the only tables that may be read,
  every beginning of every update name on a page is asked about. In a test with two hundred names that share no
  beginning, that cost 368 requests in `sn_delta` and ended `sn_query` at the 500 a call may send. Measured on
  the instance: no name of 76,000 has more than fifteen beginnings, and the most a page of two hundred had
  between them was 433. A page now asks about two thousand at most, says how many names it left out, and treats
  those as records whose table cannot be told. Where the look-up itself fails, the answer says that as well. What
  each table that was found extends was asked for with one more request per table, two hundred for a page whose
  names begin with two hundred open tables: it is read with the look-up now.
- **Two inputs cost far more than their length.** A text with many beginnings of an element and blanks inside
  one closing tag was read once per beginning, and a table name that can be read as an archive and as a part in
  many ways took ten seconds for eighty characters.
- **On an instance that answers a query it cannot use with no rows, the check before a class condition proved
  nothing.** Every question that has to match nothing is answered with nothing there, also for a field the
  instance cannot use, and the request then came back empty: "no rows" of a table that has some. Where no row
  shows a class, the table is now asked for a row with or without one, and for any row.

### Changed

No answer changed its shape. What a caller can notice:

- The `query` of an answer to a sorted query ends in `^ORDERBYsys_id` or `^ORDERBYDESCsys_id`, and on a database
  view in the sys_ids of the tables it joins: that is what was sent.
- On a database view, a query that the instance would answer unfiltered is refused, and so is a text search.
  That includes a field outside the list of the view that is only asked for as a field to return: the instance
  left it out of the row before, and the answer said so.
- `sn_schema` lists fewer fields for a view that carries a field list.
- `sn_origin` answers with a verdict for some records it called `unknown` before, and such a call costs 6
  requests where it cost 1.
- While tables are closed, a reference into the table of deleted records, the log of archived records or the
  entries for deleted application files comes as a sys_id without the name, and cannot be compared with text or
  sorted by. The same goes for a reference into a table that shows a record of a closed table as its own name.
- While tables are closed, `sys_metadata` answers without the entries for deleted application files, and a
  captured change named `sys_choice_…`, `sys_ui_related_…` or `wf_workflow_…` comes without its readable name
  where `sys_choice_set`, `sys_ui_related_list` or `wf_workflow_version` is closed.
- A call ends with an error where a gateway answers with JSON that is no answer of an instance.
- In the audit log, a request that failed never has the status 200.
- `doctor` ends with 1 where the instance drops a condition on a field the functions filter by.

### Added

- **`doctor` asks the instance whether it applies a condition on each field the functions filter by.** The
  server writes queries of its own on fields of the platform, for four of its functions and to read the
  dictionary (63 fields of 22 tables), and does not look those fields up before each call. An instance that does
  not know one of them, on another release for example, would drop the condition and answer with every row.
  `doctor` asks each field once, names the ones that are dropped, and ends with 1 for them. It tells a field
  that is applied from a table without rows, and from an instance that answers the field with nothing.
- **`npm run compare`** holds the server against the instance asked directly, past everything the server does to a
  request. It reads the dictionary a second time, one table of the parent chain after the other, and compares each
  field with what `sn_schema` says; and it sends a few hundred encoded queries both ways. On the test instance, in
  the last run: 2,214 fields of 36 tables without a difference, and of 331 queries 298 with the same total and the
  same rows, 13 more once the sort has its last key, 18 refused as intended, and two sent with a condition added
  on purpose (properties that hold a secret). It also reads whole rows both ways (2,019 cells: 60 differ, each
  marked as withheld, as cut, or as a time kept in UTC) and counts per value (21 of 21 the same as the Aggregate
  API), reads sorted lists of tables and views page by page and looks for a row that comes twice (6 lists of
  tables and 5 of views, 3,733 rows, none twice), and asks each field a view lists both ways (122 applied and
  sent, one dropped and refused). It ends with 1 if anything differs, so it can run before a release. Its first
  run found the rows that change places between pages, and a later one the field of a view that the instance drops
  although the view lists it. With `--closed <tables>` it starts a server on which a table is closed and tries the
  ways round it that it knows, from what the instance itself says belongs to the table: for twelve tables on the
  test instance, among them one with 132 tables below it and one with 1,347, 684 checks passed, none found
  anything, and two were refused by the instance itself, which proves nothing. A check counts as passed only where
  the server refuses because of the closed table or answers without anything of it, and a direct read that fails
  counts as a check that could not be run. With the two rules for names behind references switched off, it
  reported 16 findings on three tables.

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
