# Contributing

Thanks for helping improve Support Bundle Investigator.

## Development setup

Use Node.js 20 or Node.js 22 and newer (CI currently verifies 20, 22, and 24),
then install the locked dependency graph:

```bash
npm ci
```

Before opening a pull request, run the same checks as CI:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm audit
npm run pack:smoke
```

Add or update tests for behavior changes. Prefer focused unit tests, then add an
integration or golden test when the change crosses pipeline boundaries.

## Test data and privacy

Support bundles commonly contain credentials, internal hostnames, logs, and
customer data. Only commit synthetic fixtures. Never commit a real bundle,
credential, `.env` file, generated report containing sensitive data, or a
cassette captured from unsanitized prompts or responses.

## Pull requests

Keep changes focused and describe the user-visible outcome, test coverage, and
security or compatibility implications. Do not commit generated `dist/`
artifacts or local reports. Use a private security report rather than a pull
request for vulnerabilities that would put users at risk if disclosed first.
