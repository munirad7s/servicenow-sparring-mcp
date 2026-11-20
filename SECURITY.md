# Security

## Reporting a problem

Please report security problems privately: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for them. Reports are answered within a week. Fixes go into
the latest release; older releases are not patched.

Especially welcome:

- any way to make the server send a request that is not a `GET` to the Table API or the Aggregate API
- any input that reaches the instance without passing the checks in `src/query.ts`
- any answer that presents "could not be read" as "nothing found", or an unfiltered result as a filtered one
- any way to get a credential into an answer, an error message or a log

## What the server promises

- It sends only HTTP `GET` requests to `/api/now/table/<table>` and `/api/now/stats/<table>` of the one configured
  instance. It does not follow redirects.
- It requires `https`. The one exception is `http://localhost` and `http://127.0.0.1`, for a local test server.
- It refuses queries that would make the instance run script: values with `javascript:`, and `DYNAMIC` conditions.
- It writes nothing to disk, except the audit log when `SERVICENOW_AUDIT_LOG` names a file.
- It reads its settings from the environment and from an env file that is named explicitly. Only `SERVICENOW_*`
  keys are taken from that file, and the process environment is not changed. The `doctor` command and the npm
  scripts, which a person runs in a folder of their choice, also read a file named `.env` there when no
  `SERVICENOW_*` variable is set. The server itself does not.

Requests are built in `src/client.ts`, input is checked in `src/query.ts`, settings are read in `src/config.ts`.
The rules for tables that are closed on the machine are in `src/closed.ts`; the client asks them for every request,
whichever function sends it. What is taken out of an answer before it leaves the server is decided in
`src/tools/shared.ts` and `src/tools/query.ts`.
The tests that hold these promises are in `test/repo.test.ts`, `test/client.test.ts`, `test/config.test.ts` and
`test/tools.test.ts`. They are a regression guard. They run in CI on every push; they are not a sandbox.

## What it does not control

- What an instance does while answering a read: `before query` business rules, remote tables, logging. See "What
  read-only means here" in the [README](README.md).
- What happens to an answer. Everything a tool returns goes to the MCP client and to the model behind it. If that
  model runs at a provider, the data leaves your network. The account's access rules, and the table lists described
  in the README, decide what can be read at all.
- What an agent does with an answer. Text in a record can try to instruct the agent. The server labels record
  content as data, cuts long values, and quotes error texts of the instance as data; it cannot make an agent
  ignore them.

## Credentials

Credentials are read from environment variables or the env file you name. They are sent only to the configured
instance, in the `Authorization` header. They are never written to an answer, an error message or the audit log.
Fields that hold secrets on the instance (password types, encrypted fields, system properties of a password type)
are replaced by a note before an answer leaves the server. That needs the type of the field, which comes from the
dictionary. Where the type cannot be read, a field is withheld if its name suggests a secret, and the answer says
that types were missing. A secret in a field with a harmless name and an unreadable type would pass.

Give the server an account of its own, with read roles and the role `snc_read_only`. `sn_instance` and the doctor
command report whether the account has that role.
