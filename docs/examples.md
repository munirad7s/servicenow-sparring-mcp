# What the answers look like

These answers come from the stand-in instance of the test suite, so the names and numbers are invented. The shape
is what an agent receives; long parts are shortened with "…". `requests` is the count of a call on a table the
server has looked at before: the first call on a table costs five to seven more, for its field names and for the
rules that filter, archive or rotate it.

## A misspelled field

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "query": "actve=true" } }
```

```json
{
  "error": "validation",
  "message": "Unknown field. actve: \"actve\" is not a field of \"incident\" (similar: active). ServiceNow ignores a condition on an unknown field and answers unfiltered, so nothing was sent.",
  "table": "incident",
  "hint": "Nothing was sent to the instance. Correct the input and call again."
}
```

Sent as it is, the instance would have answered with every incident.

## A label where the stored value belongs

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "query": "state=Resolved" } }
```

```json
{
  "error": "validation",
  "message": "\"state\" stores the value of a choice, not its label: \"Resolved\" is the label of \"6\". Write 6 instead. With the label ServiceNow does not compare what was meant, and the answer would mislead. Nothing was sent.",
  "table": "incident",
  "hint": "Nothing was sent to the instance. Correct the input and call again."
}
```

Sent as it is, the instance would have answered "0 incidents".

## A condition without a value

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "query": "short_descriptionLIKE" } }
```

```json
{
  "error": "validation",
  "message": "Cannot check the query term \"short_descriptionLIKE\": LIKE needs a value. Without one ServiceNow drops the condition or matches nothing; to ask for empty fields use ISEMPTY or ISNOTEMPTY. Supported: …",
  "table": "incident",
  "hint": "Nothing was sent to the instance. Correct the input and call again."
}
```

Sent as it is, the instance would have answered with every incident. This is what a query looks like when an agent
builds it from a variable that turned out empty.

## A question about a secret

```json
{ "tool": "sn_query", "arguments": { "table": "sys_user", "query": "user_passwordSTARTSWITHa", "fields": ["user_name"] } }
```

```json
{
  "error": "validation",
  "message": "\"user_password\" holds a secret. It can be neither compared nor sorted by: the number of matches would give its value away piece by piece. Asking whether it is filled works: ISEMPTY, ISNOTEMPTY. Nothing was sent.",
  "table": "sys_user",
  "hint": "Nothing was sent to the instance. Correct the input and call again."
}
```

## "Is not", and the rows it leaves out

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "query": "assigned_to!=0123456789abcdef0123456789abcdef", "fields": ["number"], "limit": 1 } }
```

```json
{
  "instance": "example.service-now.com",
  "fetchedAt": "2026-11-20T02:14:07.512Z",
  "requests": 1,
  "warnings": [
    "\"!=\", \"NOT IN\" and \"NOT LIKE\" leave out rows where the field is empty (assigned_to). To count those rows too, add ^ORassigned_toISEMPTY behind the condition."
  ],
  "table": "incident",
  "query": "assigned_to!=0123456789abcdef0123456789abcdef",
  "total": 49,
  "returned": 1,
  "offset": 0,
  "truncated": true,
  "nextOffset": 1,
  "fieldCheck": "all field names verified against sys_dictionary",
  "records": [{ "number": "INC0000001" }]
}
```

On the instance this was measured on, 82 incidents exist and 33 of them have no assignee. "Not assigned to this
user" returns 49.

## An empty result with a likely reason

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "query": "caller_id=Abel Tuter", "fields": ["number"] } }
```

```json
{
  "instance": "example.service-now.com",
  "fetchedAt": "2026-11-20T02:14:07.512Z",
  "requests": 1,
  "warnings": [
    "\"caller_id\" is a reference to sys_user. \"=\" compares with a sys_id, and \"Abel Tuter\" does not look like one: that can be why nothing matched. To match by name use caller_id.<field>=… or caller_idLIKE…."
  ],
  "table": "incident",
  "query": "caller_id=Abel Tuter",
  "total": 0,
  "returned": 0,
  "offset": 0,
  "truncated": false,
  "fieldCheck": "all field names verified against sys_dictionary",
  "records": []
}
```

## Counting instead of reading

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "groupBy": "state" } }
```

```json
{
  "instance": "example.service-now.com",
  "fetchedAt": "2026-11-20T02:14:07.512Z",
  "requests": 1,
  "warnings": [],
  "table": "incident",
  "query": "",
  "total": 32,
  "returned": 2,
  "offset": 0,
  "truncated": false,
  "fieldCheck": "all field names verified against sys_dictionary",
  "records": [],
  "groupBy": "state",
  "groups": [
    { "value": "1", "count": 24, "display": "New" },
    { "value": "6", "count": 8, "display": "Resolved" }
  ]
}
```

## A name where a reference stores a sys_id

```json
{ "tool": "sn_query", "arguments": { "table": "incident", "query": "assignment_group!=Service Desk", "fields": ["sys_id"], "limit": 1 } }
```

```json
{
  "error": "validation",
  "message": "\"assignment_group\" is a reference to sys_user_group and stores a sys_id, and no record there has the sys_id \"Service Desk\". With a name, \"!=\" leaves no row out: measured, the answer then counts the rows it was meant to exclude. To leave out a record by one of its fields write assignment_group.<field>!=…, for example assignment_group.name!=Service Desk. If \"Service Desk\" is a sys_id after all, write assignment_group.sys_id!=Service Desk. Nothing was sent.",
  "table": "incident",
  "hint": "Nothing was sent to the instance. Correct the input and call again."
}
```

Sent as it is, the instance would have answered with every incident that has a group, those of the Service Desk
included. The server looks the value up first, because a sys_id is not always 32 hex digits.

## What did people here change that the upgrade skipped?

```json
{ "tool": "sn_upgrade_skips", "arguments": { "excludeErrors": true, "limit": 3 } }
```

```json
{
  "instance": "example.service-now.com",
  "requests": 10,
  "warnings": [],
  "table": "upgrade_history_task",
  "query": "upgrade_detail.upgrade_history=…^upgrade_detail.dispositionIN4,10^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id",
  "total": 79,
  "returned": 3,
  "truncated": true,
  "nextOffset": 3,
  "upgrade": { "from": "glide-zurich-…", "to": "glide-australia-…", "finished": "2026-09-25 17:41:09", "kind": "family" },
  "byDisposition": [{ "name": "Skipped", "count": 42 }, { "name": "Skipped Manual Merge", "count": 37 }],
  "notReviewed": 79,
  "records": [
    { "file": "sys_script_…", "target": "Example rule", "type": "Business Rule", "disposition": "Skipped Manual Merge", "review": "Not Reviewed", "capturedBy": "people", "…": "…" },
    { "file": "sys_ui_action_…", "target": "Example action", "type": "UI Action", "disposition": "Skipped", "review": "Not Reviewed", "capturedBy": "system_accounts", "…": "…" },
    { "file": "sys_properties_…", "target": "example.property", "type": "System Property", "disposition": "Skipped", "review": "Not Reviewed", "capturedBy": "nobody", "…": "…" }
  ],
  "capturedBy": { "people": 1, "system_accounts": 1, "nobody": 1 }
}
```

`capturedBy` says who made the captured changes to each record: a person, only installations, upgrades and jobs,
or nobody. "Nobody" does not mean unchanged: the upgrade found the record different, so it was changed without
being captured.

## Is this business rule out-of-the-box?

```json
{ "tool": "sn_origin", "arguments": { "sysId": "0123456789abcdef0123456789abcdef" } }
```

```json
{
  "instance": "example.service-now.com",
  "fetchedAt": "2026-11-20T02:14:07.512Z",
  "requests": 4,
  "warnings": [],
  "verdict": "customized",
  "explanation": "Delivered with the platform or an installed application, and changed on this instance.",
  "provenance": "vendor",
  "divergence": "customer_changes_captured",
  "created": "delivered",
  "capturedBy": "people",
  "record": {
    "sysId": "0123456789abcdef0123456789abcdef",
    "table": "sys_script",
    "name": "Example rule",
    "updateName": "sys_script_0123456789abcdef0123456789abcdef",
    "package": "Incident",
    "packageClass": "sys_plugins",
    "scope": "Global",
    "createdOn": "2019-03-01 00:00:00",
    "createdBy": "admin",
    "updatedOn": "2026-03-01 10:00:00",
    "updatedBy": "abel"
  },
  "evidence": {
    "customerUpdates": {
      "table": "sys_update_xml",
      "query": "name=sys_script_0123456789abcdef0123456789abcdef^ORDERBYDESCsys_updated_on^ORDERBYDESCsys_id",
      "readable": true,
      "total": 1,
      "firstCapturedOn": "2026-03-01 10:00:00",
      "rows": [
        {
          "name": "sys_script_0123456789abcdef0123456789abcdef",
          "action": "INSERT_OR_UPDATE",
          "type": "Business Rule",
          "update_set": { "value": "…", "display": "Incident form rework" },
          "replace_on_upgrade": "false",
          "sys_created_by": "abel",
          "sys_created_on": "2026-03-01 10:00:00",
          "sys_updated_by": "abel",
          "sys_updated_on": "2026-03-01 10:00:00"
        }
      ]
    },
    "versions": {
      "table": "sys_update_version",
      "query": "name=sys_script_0123456789abcdef0123456789abcdef^ORDERBYstate^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id",
      "readable": true,
      "total": 2,
      "bySource": { "sys_update_set": 1, "sys_upgrade_history": 1 },
      "current": { "state": "current", "source_table": "sys_update_set", "sys_created_on": "2026-03-01 10:00:00", "sys_created_by": "abel" },
      "rows": ["…"]
    },
    "upgradeSkips": {
      "table": "upgrade_history_task",
      "query": "upgrade_detail.file_name=sys_script_0123456789abcdef0123456789abcdef^ORDERBYDESCsys_created_on^ORDERBYDESCsys_id",
      "readable": true,
      "total": 0,
      "rows": []
    }
  },
  "caveats": ["…"]
}
```

How to read it: the record belongs to a platform plugin (`provenance`), a customer update exists for it
(`divergence`), a version from an upgrade exists, so it was delivered and not created here (`created`), and the
captured change was made by a person (`capturedBy`). Each part of `evidence` names the table and the query to run
it again with `sn_query`.

## Calling a function from the shell

In a checkout, `npm run call` prints what an agent would receive:

```bash
npm run call -- sn_schema '{"table":"incident","filter":"assign"}'
```
