# What ServiceNow does with an encoded query

The Table API does not reject a condition it cannot use. It either drops the condition and answers with every row,
or it applies something else and answers with no row. Both look like an answer. For a tool that is asked "is this
true on the instance?", both are wrong evidence.

This page lists what was measured, and what the server does about it. Each form was sent as `sysparm_query` to
`GET /api/now/table/incident` on one instance of the Australia release in November 2026, and the `X-Total-Count`
header was compared with the count of the unfiltered table and with the count of a correct form of the same
condition. Other releases can behave differently; `test/query.test.ts` holds the same list as test cases.

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
| `>`, `>=`, `<` or `<=` without a value | `priority>` | refuses: on a number or a date it matched nothing, on a text field the empty rows |

## Applied, but not as written

| Form | What the instance does | The server |
|---|---|---|
| Text after `ISEMPTY` or `ISNOTEMPTY` | ignores it: `activeISEMPTY=false` means "is empty" | refuses |
| `SAMEAS` with a unit it does not know | compares the exact values instead | refuses units other than `year`, `month`, `week`, `day`, `hour` |
| `GT_FIELD` with `@day` behind the field | answers with a different count than without | refuses: these operators take a plain field |
| `^OR` in front of a text search | applies something, but not an "or" | refuses |
| `!=`, `NOT IN`, `NOT LIKE` | leaves out the rows where the field is empty: of 82 incidents, 33 without an assignee, `assigned_to!=<sys_id nobody has>` returns 49 | sends it, with a warning that names `^OR<field>ISEMPTY` |

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
- `ref_<child table>.<field>` on a parent table reaches a field of the child table.
- `=` without a value is applied as "is empty", and `!=` without a value as "is not empty", on text, reference,
  number, date and boolean fields alike.
- A condition written behind an `ORDERBY` is applied.
- Three carets in a row are read as a literal `^` followed by a separator: `active=false^^^priority=1` applies both
  conditions.

## Not measured

Related-list queries (`RLQUERY … ENDRLQUERY`), tag conditions by id (`sys_tags.<id>`), catalog variables
(`variables.<id>`), `MATCH_RGX`, `MATCH_PAT` and `TRENDBY` are refused, because the server cannot check their field
names against the dictionary. Tags and variables are refused wherever a field can stand: in a condition, behind a
dot-walk, in a sort, and as the second field of a comparison. `IN_HIERARCHY` with a sys_id is accepted on the
strength of its documentation only.

The refusal of a choice label looks at the English labels of fields of the queried table, and of fields a database
view takes from its tables. A field reached by a dot-walk is not checked, and the answer says so.
