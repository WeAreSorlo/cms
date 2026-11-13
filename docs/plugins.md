# Plugins

A plugin adds field types to a site, for its content types and shared groups. A site lists its plugins in `sorlo.config.ts`, and builds its admin with them, with `sorlo build`, which `sorlo start` serves. A plugin can come from a package or from the site's own folder. Plugins only add fields for now.

```ts
import { defineConfig } from '@sorlo/cms'
import { rating } from 'sorlo-field-rating/plugin'

export default defineConfig({
  // ...
  plugins: [rating()],
})
```

- **Build the admin** with `npx sorlo build` before `sorlo start`, and again after changing the plugins or upgrading the CMS. `sorlo start` refuses a build for other plugins or another version of Sorlo, as [The admin's build](cli.md#the-admins-build) describes. `sorlo dev` needs no build.
- **Install plugin packages as dependencies,** not dev dependencies, since [Deploying](deploying.md)'s image installs without dev dependencies and then builds the admin with them.
- **A field type is taken once.** A plugin's field type that's built in, such as `text` or `markdown`, or that another plugin has, stops every command with a list of each, since `migrate`, `make:migration` and imports check type files too.
- **Forms** offer Sorlo Forms' own inputs, so a plugin's fields are for content types and shared groups.
- **Plugins are trusted code,** as [below](#plugins-are-trusted-code) explains.

## A plugin's shape

A plugin is `{ name, fields, admin }`, and `@sorlo/cms` exports its type, `Plugin`:

| Key      | What it holds                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | What messages call it                                                                                                                                                                                                |
| `fields` | Field types by name, each a [Sorlo Forms input](https://github.com/WeAreSorlo/forms#readme) without its `default` component: its name, description, category, options, checks and `typeValue`                        |
| `admin`  | The module the admin's build imports each field's full input from, as an export named after its field type: a package, such as `sorlo-field-rating`, or a path from `sorlo.config.ts`, such as `./fields/rating.tsx` |

The server checks and types values with `fields`, as it does Sorlo Forms' own inputs, so saves, type files, `sorlo types pull` and the [assistant](assistant.md)'s field types all take them. It never imports `admin`, so an editor and its browser-only code stay out of the server. The admin's build imports each field by its name, so a module without one fails the build, naming it.

## A site's own field

A field only one site needs can live in the site, with no package. Its checks go in a `.ts` file, which `sorlo.config.ts` imports, and its component in the `admin` module. They're two files because Node runs `sorlo.config.ts` by stripping its types, and can't run JSX, while the admin's build compiles TypeScript and JSX itself.

```ts
// fields/rating.ts
import { type InputValidateValue, validationError, validationSuccess } from '@sorlo/forms'

const validateValue: InputValidateValue = (value) =>
  value == null || [1, 2, 3, 4, 5].includes(value)
    ? validationSuccess(value ?? null)
    : validationError(value, 'Choose from one to five stars.')

export const rating = {
  name: () => 'Rating',
  description: () => 'From one to five stars.',
  category: () => 'Standard',
  validateValue,
  formatValue: (value: unknown) => (typeof value === 'number' ? '★'.repeat(value) : null),
  typeValue: () => 'number',
}
```

```tsx
// fields/rating.tsx
import { rating as checks } from './rating.ts'
import { useFieldContext } from '@sorlo/forms'

function Stars() {
  const { id, value, schema, handleValidation } = useFieldContext()
  return (
    <div id={id} role='radiogroup' aria-label={schema.label}>
      {[1, 2, 3, 4, 5].map((stars) => (
        <button
          key={stars}
          type='button'
          role='radio'
          aria-checked={value === stars}
          onClick={() => handleValidation(checks.validateValue(stars, schema))}
        >
          {stars <= (value ?? 0) ? '★' : '☆'}
        </button>
      ))}
    </div>
  )
}

export const rating = { ...checks, default: Stars }
```

```ts
// sorlo.config.ts
import { rating } from './fields/rating.ts'

export default defineConfig({
  // ...
  plugins: [{ name: 'rating', fields: { rating }, admin: './fields/rating.tsx' }],
})
```

The type editor then offers Rating beside the built-in fields, and a type file can use it as `{ "type": "rating", ... }`. In `sorlo dev`, the admin reloads as `rating.tsx` changes. A change to `sorlo.config.ts` or to `rating.ts`, which the server loads, needs `sorlo dev` started again.

## Writing a field package

A field package is a Sorlo Forms input first, so it works in a site's own forms with no CMS, and it needs no dependency on `@sorlo/cms`, only the plugin's shape. It has three entries, as [`@sorlo/field-markdown`](https://github.com/WeAreSorlo/cms/tree/main/packages/field-markdown) has the first two:

| Entry         | What it is                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `.`           | The full input, with its component, which Sorlo Forms users pass to a form and the admin's build imports |
| `/validation` | The input without its component, so a server checks values without loading the editor                    |
| `/plugin`     | A function making the plugin from `/validation`, with `admin` naming the package itself                  |

```ts
// src/plugin.ts
import { rating as field } from './validation'
import type { Plugin } from '@sorlo/cms'

export const rating = (): Plugin => ({
  name: 'sorlo-field-rating',
  fields: { rating: field },
  admin: 'sorlo-field-rating',
})
```

`import type` leaves nothing behind, so `@sorlo/cms` can be a dev dependency, for the type alone.

- **Share React and Sorlo Forms.** Make `react` and `@sorlo/forms` peer dependencies. The admin's build gives every plugin the CMS's own copies of React, React DOM and Sorlo Forms, so a component reads its field through Sorlo Forms' `useFieldContext`, as the CMS's own fields do.
- **Check on the server.** `validateValue` runs in the editor and again on the server, and only the server's check decides what's saved, since a browser can send anything. `validateServerValue` is for checks only a server can make.
- **Name it** `sorlo-field-<name>`, or `sorlo-plugin-<name>` for a plugin that adds other things once plugins can, as Strapi's community names theirs. `@sorlo/field-<name>` is for Sorlo's own.

## Plugins are trusted code

A plugin runs with every right the CMS has, as any dependency does, and the CMS doesn't sandbox it:

- **On the server,** `sorlo.config.ts` imports it, so its code runs in the CMS's process, with the database, the site's environment and its secrets.
- **In editors' browsers,** its components run in the admin, signed in as whoever is using it, so they can do anything that person can, through the [admin API](admin-api.md).

So install plugins as you would any package the server runs: from people you trust, at versions your lockfile pins, reviewed before an upgrade.
