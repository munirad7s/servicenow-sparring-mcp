# What ServiceNow does with an encoded query

The Table API does not reject a condition it cannot use. It either drops the condition and answers with every row,
or it applies something else and answers with no row. Both look like an answer. For a tool that is asked "is this
true on the instance?", both are wrong evidence.

This page lists what was measured, and what the server does about it. Each form was sent as `sysparm_query` to
`GET /api/now/table/incident` on one instance of the Australia release in November 2026, and the `X-Total-Count`
header was compared with the count of the unfiltered table and with the count of a correct form of the same
condition. Other releases can behave differently; `test/query.test.ts` holds the same list as test cases.

One setting changes the first table below. The system property `glide.invalid_query.returns_no_rows` was not set
on that instance, which is the default. Set to `true`, it is documented to make a query the instance cannot use
return no rows instead of all rows, though not in every case. `sn_instance` reports the property.

## Dropped: the instance answers as if the condition were not there

| Form | Example | The server |
|---|---|---|
| A field the table does not have | `actve=true` | refuses, and names similar fields |
| A field name with an upper-case letter | `Active=false` | refuses |
| A dot-walk through a list field (`glide_list`) | `watch_list.email=a@example.org` | refuses |
| An unknown field behind `ref_<child table>.` | `ref_incident.zzz=1` on `task` | refuses |
| An unknown field of a database view | `inc_actve=true` on `incident_sla` | refuses |
| `ON` or `NOTON` without its three parts | `sys_created_onONToday` | refuses |
| `BETWEEN` without its second value | `priorityBETWEEN2` | refuses |
| `NOTLIKE` written without the space | `close_notesNOTLIKEx` | refuses |
| A second condition written after `^^` | `active=false^^priority=1` | sends it as one condition, with a warning |
| An unknown field in `ORDERBY` | `ORDERBYzzz` | refuses |
| `LIKE`, `NOT LIKE`, `STARTSWITH`, `ENDSWITH` or `CONTAINS` without a value | `close_notesLIKE` | refuses |
| `NOT IN` without a value | `close_notesNOT IN` | refuses |
| `GROUPBY<field>` | `active=true^GROUPBYstate` | refuses: use the `groupBy` input, which counts through the Aggregate API |

`^^` is how ServiceNow writes a literal `^` inside a value. `active=false^^priority=1` is therefore one condition on
`active`; the part about `priority` is not applied.

A value of the wrong kind belongs here too. The instance does not reject it:

| Form | Example | What the instance does | The server |
|---|---|---|---|
| A date it cannot read | `sys_created_on>01.01.2026`, `>01/01/2026`, `>yesterday`, `>2026`, `>2026-13-45 00:00:00` | `>` and `>=` match every row, `<` and `=` match none | refuses, and names the form: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` |
| A value other than `true`, `false`, `1` or `0` on a true/false field | `active=yes`, `active=on`, `active=2` | reads it as false: `active=yes` returned the 29 inactive rows, not the 53 active ones | refuses |
| A value that is not a number on a number field | `reassignment_count=abc`, `!=abc`, `>abc`, `IN1;2;3` | matches nothing, also with `!=`. The same on fields of the types currency, price, percent complete, order index, integer time and auto increment | refuses |
| `LIKE`, `NOT LIKE`, `STARTSWITH`, `ENDSWITH` or `CONTAINS` on a number field | `priorityLIKE1` | matches nothing: 0 rows where `priority=1` finds 27 | refuses |
| The same operators on a true/false field | `activeLIKEtrue` | returns the rows where the field is false | refuses |
| A duration written as a number or a time | `business_duration>3600`, `>01:00:00` | `>3600` matches every filled row, `>01:00:00` none: a duration is stored as a date counted from 1970-01-01 | refuses, and names the form: `1970-01-01 01:00:00` for one hour |
| A time of day written as a time | `start_time=08:00:00`, `>12:00:00` | `=` and `>` match nothing, `<12:00:00` every row: a time of day is stored as a point in time on 1970-01-01 | refuses, and names the form: `1970-01-01 08:00:00` |
| `BETWEEN` or `ON` on a true/false field | `activeBETWEENfoo@bar`, `activeONa@b@c` | returns the rows where the field is false: 29 of 82 | refuses: these are for dates |
| A name in place of a sys_id behind `!=` or `NOT IN` | `assignment_group!=Service Desk` | leaves no row out: all 40 incidents with a group came back, the 12 of that group among them. By name, `assignment_group.name!=Service Desk`, it is 28 | looks the value up in the referenced table and refuses where no record has it as its sys_id. A sys_id is not always 32 hex digits: `global` and `Default view` are sys_ids |
| A field of a database view that the view does not filter by. A view can list the fields it takes from a table it joins, and drops a condition on any other: 11,759 of 11,759 rows for a value nobody has. On some views it answers 403 instead. A sort by such a field does nothing. It also dropped the condition on one of eight fields a list did name | `<prefix>_<field>=x` | asks first for the rows where the field is empty and filled at once (`<field>ISEMPTY^<field>ISNOTEMPTY`): with none it sends the query, with rows or an error it refuses. Asked once in ten minutes per field, and only kept while the view has rows |

Read as dates, when measured: `2026-01-01 00:00:00`, `2026-01-01`, `2026-1-1`, `2026-01-01 00:00`,
`2026-01-01T00:00:00` with and without a `Z`, and also `20260101` and `2026/01/01`, which the server refuses all
the same to keep one form.

## Matches nothing: the answer is a zero that says nothing

| Form | Example | The server |
|---|---|---|
| The label of a choice instead of its stored value, with `=`, `!=`, `IN` or `NOT IN` | `state=New`, `state!=New` | refuses, and names the stored value |
| A condition on tags | `sys_tagsISEMPTY`, and `sys_tagsISNOTEMPTY` as well | refuses |
| A name in place of the sys_id of a reference | `caller_id=Abel Tuter` | sends it, and explains the empty result |
| `<>` for "not equal" | `state<>6` | refuses: use `!=` |
| `VALCHANGES`, `CHANGESFROM`, `CHANGESTO` | `stateCHANGESTO6` | refuses: these work only inside a business rule |
| `EXCLUDING` | `stateEXCLUDING1,2` | refuses: use `NOT IN` |
| `EMPTYSTRING` | `close_notesEMPTYSTRING` | refuses: use `ISEMPTYSTRING` or `ISEMPTY` |
| `DOESNOTHAVE` | `watch_listDOESNOTHAVEx` | refuses |
| `RELATIVEGT` and its siblings with the unit `day`, `week` or `second` | `sys_created_onRELATIVEGT@day@ago@365` | refuses: the units that work are `year`, `quarter`, `month`, `dayofweek`, `hour`, `minute` |
| `MORETHAN` or `LESSTHAN` between two plain fields | `reassignment_countMORETHANreopen_count` | refuses: use `GT_FIELD` or `LT_FIELD` |
| `MORETHAN` or `LESSTHAN` with the unit `minute`, `second` or `dayofweek` | `closed_atMORETHANopened_at@minute@after@240` | refuses: the units that work are `year`, `quarter`, `month`, `week`, `day`, `hour` |
| `INSTANCEOF` or `IN_HIERARCHY` without a value | `sys_class_nameINSTANCEOF` | refuses |
| `IN` without a value | `close_notesIN` | refuses: it matched none of the 53 rows with an empty field |
| `IN` or `NOT IN` with nothing but commas | `reassignment_countIN,` | refuses: it matched nothing. An empty entry among others is skipped: `priorityIN1,` matched what `priorityIN1` did |
| `NULL` behind an operator other than `=` and `!=` | `sys_created_on>NULL`, `<NULL`, `BETWEENNULL@NULL`, `assigned_toINNULL` | refuses: each matched none of 82 rows |
| `ON` on a number field | `reassignment_countONfoo@bar@baz` | refuses: it matched nothing |
| A text search without a word | `123TEXTQUERY321=` | refuses: it matched nothing |
| A text search on a database view | `123TEXTQUERY321=printer` on `incident_sla` | refuses, and names the tables to search: on thirty views that join a table with a text index it matched no row, where the same search finds rows on the table |
| A condition joined to a text search with `^OR` | `123TEXTQUERY321=printer^ORpriority=1` | refuses: it matched none of the 27 rows with priority 1 |
| A word on a choice that stores numbers | `priority=High` | refuses, and lists the values with their labels |
| `>`, `>=`, `<` or `<=` without a value | `priority>` | refuses: on a number or a date it matched nothing, on a text field the empty rows |

## Applied, but not as written

| Form | What the instance does | The server |
|---|---|---|
| Text after `ISEMPTY` or `ISNOTEMPTY` | ignores it: `activeISEMPTY=false` means "is empty" | refuses |
| `SAMEAS` with a unit it does not know | compares the exact values instead | refuses units other than `year`, `month`, `week`, `day`, `hour` |
| `GT_FIELD` with `@day` behind the field | answers with a different count than without | refuses: these operators take a plain field |
| `^OR` in front of a text search | applies something, but not an "or" | refuses |
| A condition on a journal field such as `work_notes` or `comments` | does not look at that field: `work_notesISEMPTY` and `work_notesISNOTEMPTY` both returned the same 36 of 82 incidents, and `work_notesLIKEa` returned 34 incidents although only 24 work notes exist | refuses, and names the exact source: `sys_journal_field` with `element=work_notes^valueLIKE<text>` |
| `!=`, `NOT IN`, `NOT LIKE`, `NSAMEAS` | leaves out the rows where the field is empty: of 82 incidents, 33 without an assignee, `assigned_to!=<sys_id nobody has>` returns 49. `assigned_toNSAMEASopened_by` returned 47: the 2 rows where both are the same person are left out, and the 33 without an assignee as well | sends it, with a warning that names `^OR<field>ISEMPTY`, unless the query asks for the empty rows itself |
| A part of a query that holds no condition, joined by `^NQ` | is no part: `EQ^NQpriority=1`, `ORDERBYnumber^NQpriority=1` and `priority=1^NQ` match what `priority=1` does | where the server has to add a condition of its own, it adds it only to the parts that have one: added to an empty part it made that part match everything (29 rows where 10 was the answer) |
| A sort by a field in which rows are equal, read page by page | gives those rows another place from one page to the next. A thousand captured changes, newest first, in ten pages of a hundred, were 989 different rows: eleven came twice and eleven never. Sorted by type it was 753, the entries of upgrades 153 of 158. Most of these rows share their time with a neighbour: 244 of 299 in a row. Asked six times, one page of them came back the same each time, and it is the next page that does not fit; a sort by the name behind a reference changed its first rows from one request to the next, three answers in six | adds the sys_id as the last sort key, in the direction of the key before it: `ORDERBYDESCsys_updated_on` is sent as `ORDERBYDESCsys_updated_on^ORDERBYDESCsys_id`. Every such read then brought a thousand of a thousand, also in a query of several parts or with several keys. The answer names the query as it was sent |

## Runs script on the instance

| Form | Example | The server |
|---|---|---|
| A value that starts with `javascript:` | `sys_created_on>javascript:gs.daysAgo(7)` | refuses, also with upper case, spaces, invisible characters or look-alike letters in the word |
| `DYNAMIC`, `IN_HIERARCHY_DYNAMIC` | `assigned_toDYNAMIC<sys_id>` | refuses: the condition runs the script of a stored filter option |
| `DATEPART` | needs a `javascript:` value | refuses |

These were not sent to the instance for measurement. They are refused because of what they are documented to do.

## Reads a secret piece by piece

| Form | Example | The server |
|---|---|---|
| A condition on a field of a password or encrypted type | `user_passwordSTARTSWITH$s$a` | refuses; `ISEMPTY` and `ISNOTEMPTY` are allowed |
| A sort by such a field, or a comparison of another field with it | `ORDERBYuser_password` | refuses |
| A condition on, or a sort by, the value of system properties | `valueLIKEhttp` on `sys_properties` | sends it with `typeNOT INpassword,password2` added to every part of the query, and says so |
| The same through a database view or a reference | `prop_valueLIKEhttp` | refuses |

The instance applies each of these as written. The number of matches would tell whether a guess was right, and
repeated guesses would spell out a value that the answer itself withholds. The added condition also leaves out the
properties without a type, because `NOT IN` skips empty fields. That is wanted: without a type, a value is withheld
by the name of its property, and a name cannot be written into this condition.

## Works as expected

`=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `NOT LIKE`, `CONTAINS`, `STARTSWITH`, `ENDSWITH`, `IN`, `NOT IN`,
`ISEMPTY`, `ISNOTEMPTY`, `ISEMPTYSTRING`, `ANYTHING`, `BETWEEN<a>@<b>`, `ON` and `NOTON` with
`<label>@<start>@<end>`, `INSTANCEOF<table>`, `SAMEAS` and `NSAMEAS`, `GT_FIELD`, `LT_FIELD`,
`GT_OR_EQUALS_FIELD`, `LT_OR_EQUALS_FIELD`, `MORETHAN` and `LESSTHAN` with `<field>@<unit>@<before|after>@<n>`,
the `RELATIVE` operators with `@<unit>@<ago|ahead>@<n>`.

Also measured:

- `OR` and `NQ` work at the start of a query too, with and without a `^` in front.
- `^EQ` in the middle of a query does not end it: conditions behind it still apply.
- A `GOTO` in front of a condition, as the list search writes it, changes nothing.
- `LIKE` and `STARTSWITH` on a reference field match its display value. `=` and `IN` compare with the sys_id.
  `ORDERBY` on a reference sorts by the display value. Where the referenced table is closed on the machine that
  runs the server, the server therefore refuses a text comparison with the reference, and a sort by it.
- A string is compared without regard to case: `category=Inquiry` finds `inquiry`.
- An underscore in a value is an underscore, not "any one character" as in the pattern of a database:
  `nameSTARTSWITHsys_` on the table of tables returned 2,294 names, all of which begin with `sys_`, where 154 more
  begin with `sys` and another character. `nameLIKEs_a` returned 444 names, not the 1,505 a pattern would match,
  and `nameENDSWITH_list` 23, not 37.
- `ref_<child table>.<field>` on a parent table reaches a field of the child table.
- `=` without a value is applied as "is empty", and `!=` without a value as "is not empty", on text, reference,
  number, date and boolean fields alike. `=NULL` and `!=NULL` mean the same: 717 of 771 users had no login time
  with `ISEMPTY`, with `=NULL` and with `=`, and 54 with each of the three ways to write "is not empty".
- A blank around a value is ignored: `priority= 1`, `active= true` and `sys_created_on> 2026-03-03` matched what
  they match without it, and so did `categoryINinquiry, software`.
- A dot-walked field of an empty reference is empty: `assignment_group.nameISEMPTY` matched the 42 incidents
  without a group, and `assignment_group.name!=X^ORassignment_group.nameISEMPTY` the 28 of other groups and those 42.
- A text search finds a record by the name behind one of its references. A caller whose name stood in no text
  field of an incident was found on all 8 of his incidents. Where a table is closed on the machine that runs the
  server, a text search on a table that points into it is therefore refused.
- A list field (`glide_list`) with one entry is matched by `=`, `IN`, `LIKE` and `CONTAINS` alike.
- `^NQ` works in the Aggregate API as in the Table API: the groups of a query with two parts added up to the
  3,619 rows the Table API counted, not to the sum of the parts.
- A condition written behind an `ORDERBY` is applied.
- A second sort key costs nothing where it runs the way of the first: on a table of 3.5 million rows, newest
  first took 878 ms and with the sys_id falling as a second key 928 ms. With the sys_id rising it took 4,212 ms.
- A sort in one part of a query joined by `^NQ` holds for the whole answer, and so does a key added at its end.
  A sort key behind `^EQ` is applied as well, and one behind a text search: the same 11 incidents matched with
  the key and without, in the order asked for.
- A caret at the end of a query, followed by one more sort key, is read as a caret inside a value: the key is no
  key then, and the sort before it is dropped with it. The server takes such a caret off before it adds its key.
- A query that asks for no order, read by pages, brought no row twice: a thousand captured changes, 186
  dictionary entries and 110 labels. The instance does not promise that. For a list that has to be complete, give
  an order.
- `sys_id` as a sort key does no harm on a database view, which has no field of that name: the rows and the total
  were the same with it and without. The same on four remote tables, whose rows a script makes up.
- The Aggregate API gives the groups of a count another order from one request to the next: five requests for
  the dictionary entries per type brought three orders. The server puts groups in the order of their size, and
  groups of one size in the order of their values, so that a list of groups read by pages holds each group once.
- `^OR` binds to the condition before it, tighter than `^`, in the Table API and in the Aggregate API alike. Of 82
  incidents, 10 were inactive with priority 1 and 4 had priority 2, all of them active:
  `active=false^priority=1^ORpriority=2` matched 10 in both, not 14, and so did the same conditions in another
  order. The conditions the server adds to a query rest on this.
- A text search and a condition on the class work together, in both APIs and in either order. A search word found
  109 tasks, 11 of them incidents: with `^sys_class_nameNOT INincident^ORsys_class_nameISEMPTY` behind it, or in
  front of it, it found 98.
- Tables go deep. Of the 10,806 tables of one instance, 5 have a parent eight levels up and none has one nine
  levels up. The server reads eight levels in one request and asks again for what is below a table it finds at
  the eighth.
- A database view can list the fields it shows of a table (103 of 558 views do). A condition on the class of a
  joined table, `<prefix>_sys_class_name`, was applied on views whose list leaves that field out: a view of 44
  rows, 7 of them incidents, answered with 37 where incidents were left out. The server does not rely on it. Before
  it leaves rows out of a view this way, it asks the view for rows whose class is two things at once (empty and
  filled, and one of two names), which has to match nothing.
- A journal field comes back empty unless display values are asked for: the stored value of `work_notes` had
  length 0 where its display value had 1,020 characters. The entries are rows of `sys_journal_field`. The server
  says so when such a field is read without `displayValue`.
- A date and time in a condition is compared as UTC, not in the time zone of the account. With an account seven
  hours behind UTC, `sys_created_on=<value>` matched a record with its stored value and not with the value the
  list shows. The server returns the stored UTC value of a timestamp for that reason.
- The Aggregate API returned every group also where there were thousands: counted by `name`, the groups of
  `sys_dictionary` add up to all 299,720 rows.
- The Aggregate API can refuse a field that the Table API accepts. Counting `sys_metadata` by `sys_class_name`
  was answered with HTTP 403, "Field(s) present in the query do not have permission to be read", for an
  administrator, while `sys_class_name=sys_script` as a condition works. The server reports that as "could not be
  checked" and says that the field is the reason, not the table.
- Three carets in a row are read as a literal `^` followed by a separator: `active=false^^^priority=1` applies both
  conditions.
- Two carets in front of a keyword stay a literal `^`. Of 82 incidents, 48 had the category "inquiry" and 13
  "software": `category=inquiry^^NQcategory=software` matched none, in both APIs, and so did the same with `^^OR`,
  `^^EQ` and `^^ORDERBY`. The server reads them the same way.
- A condition on a field the instance does not know is dropped, and what that does depends on where it stands.
  Alone, or joined with `^`, the query answers as if it were not there: `nosuchfield=xyz` returned all 10,806
  tables. First in a chain of `^OR`, it takes the chain with it: `nosuchfield=xyz^ORname=sys_db_object` returned
  all 10,806. Behind another condition in the chain, it matches nothing: `name=sys_db_object^ORnosuchfield=xyz`
  returned 1. And a part of a query joined by `^NQ` whose conditions are all dropped adds no rows:
  `nosuchISEMPTY^nosuchISNOTEMPTY^NQname=sys_db_object` returned 1. So a question that has to match nothing
  proves that a condition is applied only where it stands alone in its query, and the server asks it that way.
- A rotated table is stored in parts. `sys_table_rotation_schedule` lists them: 357 entries for 49 tables on one
  instance, of which 319 are named after the table with four digits (`syslog0003`), 8 with one digit
  (`sys_replication_queue2`), and 30 name the table itself. `syslog0003` extends nothing, is read through the
  Table API like any table, and held 655,964 rows whose class is `syslog` or one of its child tables. The child
  tables have parts of their own, which extend the parts of the parent. An archive table, `ar_<table>`, extends
  nothing either. The server closes all of them with the table whose rows they hold, and goes by the list, not by
  the name, where it can read the list.
- An update name is compared without regard to case as well: `name=SYS_SCRIPT_<sys_id>` found the captured change
  of `sys_script_<sys_id>`, and the same in `sys_update_version` and `sys_metadata`.
- What stands before the sys_id at the end of an update name is mostly the table of the record, but not always:
  `sys_ui_form_sections_<sys_id>` is a record of `sys_ui_form`, and no table is called `sys_ui_form_sections`,
  while `sys_ui_list_control_<sys_id>` and `sys_dictionary_override_<sys_id>` are records of tables of exactly
  those names. The server asks the instance whether such a table exists before it takes the name that way.
- A linked application file (`sys_metadata_link`) is named after the record it links to: its `sys_name`, a field
  it inherits from `sys_metadata`, is the display name of that record, and its payload is the whole record in a
  CDATA section. Of 92 on one instance, 16 linked to records of one table and carried their names.
- The entry for a deleted application file (`sys_metadata_delete`) keeps the name and the update name of the
  record that was deleted. One instance had 2,010 such entries; the update names of 400 of them began with 48
  tables, none with `sys_metadata_delete`.
- The table of deleted records (`sys_audit_delete`) shows the name of the record that was deleted as its own
  display value, and other tables point into it: `sys_audit_relation.audit_delete` on 83,948 rows of one instance.
  59 of 60 such references showed the name of the deleted record. The log of archived records (`sys_archive_log`)
  does the same, 20 of 20, and the entries for deleted application files 71 of 100. With a table closed, 20 of 20
  cells of such a reference carried the name of a deleted record of it, and a count per reference its label,
  until the server left those names out as well.
- The display field of a table can itself be a reference: 673 tables of one instance show a reference, a list or
  a document id as their own name (604, 9 and 60), 46 of them a user. A reference into such a table shows the
  name behind the second reference: of 60 fields with filled references into one of them, 48 did, 340 of 459
  cells. With a table closed, the name of one of its records came back two tables away: 10 of 10, 20 of 20 and 2
  of 2 cells in three trials, with a label on every counted group, until the server followed the display field.
  14 of 842 dictionary overrides move the display field of a table.
- Three kinds of records are captured under a name that begins with another word than their table: the choices
  of a field as `sys_choice_<table>_<field>`, a record of `sys_choice_set`; the related lists of a form as
  `sys_ui_related_<table>_<view>`, a record of `sys_ui_related_list`; and a version of a workflow under the name
  of the workflow, `wf_workflow_<sys_id>`, a record of `wf_workflow_version`. Measured over 6,631 captured
  changes, whose payload names the table of the record, and over the application files of 1,998 classes. Where
  tables are closed, the server takes a name of such a beginning for a record of those tables as well. An
  instance can have more rules of this kind than this one had records of.
- Counted per value, a table without rows mostly answers with an empty list, but not always: counted per class,
  2 of 51 tables without rows and 15 views answered with one group of no rows and an empty value. The server
  leaves such a group out.
- A condition on the class of a row that the Table API applies is applied by the Aggregate API as well, as far as
  measured: "empty and filled at once" on the class of 120 parent tables, on 400 class fields of database views and
  behind 150 references matched nothing through both wherever both answered. In 8 cases the Aggregate API
  answered HTTP 400 where the Table API applied the condition, and in 3 the Table API answered HTTP 403 where a
  plain count through the Aggregate API went through.
- Update names have few beginnings a table could be named by. Of 76,000 names (captured changes, versions and
  application files) none had more than fifteen, and the most a page of two hundred had between them was 433.
- What a field shows beside its stored value depends on its kind. Of the 167 kinds of fields of one instance, 35
  showed something else for at least one row: a reference, a list and an attachment field the name of a record;
  a condition a sentence with the names behind its sys_ids; a choice, a class and a stage their label; dates,
  times and durations another form; a currency its unit.
- `NSAMEAS` leaves out the rows where either field is empty. Of 82 incidents, 48 had a caller and nobody who
  resolved them and 28 had two different people there: `caller_idNSAMEASresolved_by` matched the 28.
- An instance takes a request up to a length. One instance took an address of 8,218 characters and answered HTTP
  414 to one of 8,223, whatever it consisted of. `^`, `,` and `=` are written with three characters there, so a
  query of 2,701 carets was the longest of its kind. The server does not send a request longer than 8,000.

## Not measured

Related-list queries (`RLQUERY … ENDRLQUERY`), tag conditions by id (`sys_tags.<id>`), catalog variables
(`variables.<id>`), `MATCH_RGX`, `MATCH_PAT` and `TRENDBY` are refused, because the server cannot check their field
names against the dictionary. Tags and variables are refused wherever a field can stand: in a condition, behind a
dot-walk, in a sort, and as the second field of a comparison. `IN_HIERARCHY` with a sys_id is accepted on the
strength of its documentation only.

The refusal of a choice label looks at the labels, in every language the instance has, of fields of the queried
table, of fields a database view takes from its tables, and of fields reached by a dot-walk. For a dot-walk the list
is the one of the table the reference points to: a child table of it can carry a list of its own, which is not
looked at. Where a list cannot be read, the answer says that the values were not checked.
