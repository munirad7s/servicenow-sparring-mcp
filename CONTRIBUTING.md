# Contributing

Thank you for helping. A few rules keep this project what it is.

## The rules

1. **Reads only.** No tool and no code path may send anything but `GET`. `test/repo.test.ts` fails otherwise. A
   feature that needs a write does not belong here.
2. **No unchecked input.** Everything that ends up in a URL or an encoded query passes through `src/query.ts`.
   What cannot be checked is refused. A value read from the instance is checked like any other before it goes into
   the next query.
3. **Say what is not known.** A tool that cannot read a source reports "not checked" or "unknown". It never returns
   an empty list in its place. New tools list their own gaps in `src/limitations.ts`.
4. **Measure before you claim.** A statement about ServiceNow behaviour in code, tests or docs was checked on an
   instance or in the documentation. Say which. `docs/encoded-queries.md` shows the form.
5. **No private data.** No instance names, host names, user names or record content in code, tests, docs or
   commit messages. Tests use `example.service-now.com` and addresses at `example.org`. `test/repo.test.ts` scans
   for instance hosts, local paths, mail addresses and invisible characters.

## Working on it

```bash
npm install
npm test             # fake instance, no network
npm run typecheck
npm run build
npm run doctor       # what the configured account can read
npm run smoke        # read-only, end to end against your instance
npm run call -- sn_schema '{"table":"incident","filter":"assign"}'
```

In the Windows command prompt, write the JSON for `npm run call` with escaped double quotes instead of single
quotes: `"{\"table\":\"incident\"}"`.

Add a unit test with every change. The fake instance in `test/fake.ts` behaves like the Table API where the tools
depend on it: it leaves unknown fields out of a row, and it answers "Invalid table" for a table without a route.

`npm test` does not check types: run `npm run typecheck` as well, as CI does. Before a release, run `npm audit`:
0.3.3 went out with nine advisories against its locked dependencies that nobody had looked for.

A rule that keeps something back (a secret, a row of a closed table, a verdict that is not established) needs a
test that fails without it. To see whether it has one, take the rule out or turn it round, one line at a time,
and run the tests. For 0.3.4 and 0.4.0 that was done for 370 lines, and 48 of the changes went unnoticed.

If you change how a tool reads the instance, run `npm run smoke` against a real instance and say in the pull request
which release it was. If you change `sn_origin`, run `npm run origin-check` before and after.
