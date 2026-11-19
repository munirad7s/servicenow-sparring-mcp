# Security

## Reporting a problem

Please report security problems privately: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for them.

Especially welcome:

- any way to make the server send a request that is not a `GET` to the Table API or the Aggregate API
- any input that reaches the instance without passing the checks in `src/query.ts`
- any answer that presents "could not be read" as "nothing found"

## What the server promises

It sends only HTTP `GET` requests to `/api/now/table/<table>` and `/api/now/stats/<table>`. It refuses queries that
contain `javascript:`. It does not follow redirects and requires `https`.

It does not control what an instance does while answering a read. See "What read-only means here" in the
[README](README.md), and give the server an account that cannot write.

## Credentials

Credentials are read from environment variables or an env file you name. They are sent only to the configured
instance, in the `Authorization` header. They are never written to an answer or a log.
