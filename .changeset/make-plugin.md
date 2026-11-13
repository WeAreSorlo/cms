---
'@sorlo/cms': minor
---

`sorlo make:plugin <name>` makes a field package in the site's `plugins` folder, `sorlo-field-<name>`, with its three entries built by tsup and a field that starts as Sorlo Forms' text field. It adds the package to `package.json` as a `file:` dependency and to `sorlo.config.ts`'s `plugins`, then installs and builds it and installs the site, or with `--no-install` prints those steps.
