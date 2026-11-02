import { createRequire } from 'node:module'

// shortcut: core's ES module build imports named exports from lodash, which Node can't find in CommonJS, so the
// server loads core's CommonJS build until core imports lodash/<fn> instead (PLAN.md section 12, change 5)
const core: typeof import('iight') = createRequire(import.meta.url)('iight')

export const {
  baseInputSchemaFields,
  evaluateCondition,
  evaluateConditions,
  flattenValidationReport,
  inputs,
  isEmptyValue,
  normaliseConditions,
  pickValues,
  schemaToTypeScript,
  validateInputSchemaFields,
  validateServerValues,
  validationError,
} = core
