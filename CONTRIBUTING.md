# Contributing

Thank you for helping. A few rules keep this project what it is.

## The rules

1. **Reads only.** No tool and no code path may send anything but `GET`. `test/repo.test.ts` fails the build
   otherwise. A feature that needs a write does not belong here.
2. **No unchecked input.** Everything that ends up in a URL or an encoded query passes through `src/query.ts`.
   What cannot be checked is refused.
3. **Say what is not known.** A tool that cannot read a source reports "not checked" or "unknown". It never returns
   an empty list in its place. New tools list their own gaps in `src/limitations.ts`.
4. **Measure before you claim.** A statement about ServiceNow behaviour in code, tests or docs was checked on an
   instance or in the documentation. Say which.
5. **No private data.** No instance names, host names, user names or record content in code, tests, docs or
   commit messages. Tests use `example.service-now.com`.

## Working on it

```bash
npm install
npm test            # fake instance, no network
npm run typecheck
npm run smoke       # read-only, against your configured instance
```

Add a unit test with every change. If you change how a tool reads the instance, run `npm run smoke` against a real
instance and say in the pull request which release it was.
