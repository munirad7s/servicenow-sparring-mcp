**What changes, and why**

**How it was checked**

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass
- [ ] a unit test covers the change
- [ ] if a tool reads the instance differently: `npm run smoke` passes against a real instance. Release:

**Still true**

- [ ] the server sends nothing but `GET`
- [ ] a part that could not be read is reported as such, not as empty
- [ ] no instance name, host, user name or record content in code, tests, docs or commit messages
