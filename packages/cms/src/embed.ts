import { normaliseConditions } from './core'
import type { FieldSchema } from '@sorlo/forms'

// The honeypot: a field that people never see, so a submission that fills it in is kept as spam
export const honeypot = '_website'

export const escapeHtml = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

// Attributes from their values, leaving out those that are false or empty
const attributes = (pairs: Record<string, unknown>) =>
  Object.entries(pairs)
    .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== '')
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
    .join('')

// Core's inputs that are one <input>, by the type it takes
const inputTypes: Record<string, string> = {
  identifier: 'text',
  email: 'email',
  tel: 'tel',
  url: 'url',
  password: 'password',
  number: 'number',
  range: 'range',
  date: 'date',
  time: 'time',
  datetime: 'datetime-local',
  color: 'color',
}

// Inputs whose rows, blocks or rules are added with JavaScript, which a plain HTML form can't do
const needJavaScript = ['repeater', 'matrix', 'flexible', 'schemabuilder', 'conditions']

interface Choice {
  value: string
  label?: string
}

// One field as HTML, named as a plain form post sends its value: a group's fields go under the group's name, as in
// address.town, and each ticked choice sends the field's name again
function fieldHtml(field: FieldSchema, prefix: string, indent: string): string {
  const options = field.options ?? {}
  const name = `${prefix}${field.name}`
  const id = `sorlo-${field.id ?? name}`
  const label = escapeHtml(field.label ?? field.name)
  const inner = `${indent}  `
  const help = field.instructions
    ? `\n${inner}<small id="${escapeHtml(id)}-help">${escapeHtml(field.instructions)}</small>`
    : ''
  // Conditions need JavaScript to hide a field, so the browser never requires a field that has them
  const required = field.required === true && normaliseConditions(field).length === 0
  const shared = { name, required, 'aria-describedby': field.instructions && `${id}-help` }
  const value = field.defaultValue
  const choices: Array<Choice> = options.choices ?? []
  const chosen = (choice: Choice) => (Array.isArray(value) ? value.includes(choice.value) : value === choice.value)

  if (needJavaScript.includes(field.type)) return `${indent}<!-- ${label} is left out, as its items need JavaScript -->`
  if (field.type === 'hidden') return `${indent}<input${attributes({ type: 'hidden', name, value: options.value })}>`
  if (field.type === 'content') {
    return `${indent}<p>${field.label ? `<strong>${label}</strong><br>` : ''}${escapeHtml(options.content ?? '')}</p>`
  }

  // A group of fields or of choices. Browsers can make a radio button required, but not one of a list of boxes.
  if (field.type === 'group' || field.type === 'checkbox' || field.type === 'radio') {
    const items =
      field.type === 'group'
        ? (options.fields ?? []).map((child: FieldSchema) => fieldHtml(child, `${name}.`, inner))
        : choices.map((choice) => {
            const type = field.type === 'radio' ? 'radio' : 'checkbox'
            const box = attributes({ type, name, value: choice.value, checked: chosen(choice) })
            const must = attributes({ required: type === 'radio' && required })
            return `${inner}<label><input${box}${must}> ${escapeHtml(choice.label ?? choice.value)}</label>`
          })
    const describedBy = attributes({ 'aria-describedby': shared['aria-describedby'] })
    return [
      `${indent}<fieldset${describedBy}>`,
      `${inner}<legend>${label}</legend>${help}`,
      ...items,
      `${indent}</fieldset>`,
    ].join('\n')
  }

  // Ticked, it posts on, which core's boolean takes as true
  if (field.type === 'boolean') {
    const box = attributes({ type: 'checkbox', id, ...shared, checked: value === true })
    const message = escapeHtml(options.message ?? field.label ?? field.name)
    return [`${indent}<p>`, `${inner}<label><input${box}> ${message}</label>${help}`, `${indent}</p>`].join('\n')
  }

  const lengths = { minlength: options.minLength, maxlength: options.maxLength }
  let control: string
  if (field.type === 'textarea') {
    const settings = attributes({ id, ...shared, rows: options.rows, placeholder: options.placeholder, ...lengths })
    control = `<textarea${settings}>${escapeHtml(value ?? '')}</textarea>`
  } else if (field.type === 'select') {
    const multiple = options.multiple === true
    const list = choices.map(
      (choice) =>
        `${inner}  <option${attributes({ value: choice.value, selected: chosen(choice) })}>${escapeHtml(choice.label ?? choice.value)}</option>`,
    )
    if (!multiple) list.unshift(`${inner}  <option value="">${escapeHtml(options.placeholder ?? '')}</option>`)
    control = [`<select${attributes({ id, ...shared, multiple })}>`, ...list, `${inner}</select>`].join('\n')
  } else {
    control = `<input${attributes({
      type: inputTypes[field.type] ?? 'text',
      id,
      ...shared,
      value,
      placeholder: options.placeholder,
      multiple: field.type === 'email' && options.multiple === true,
      ...lengths,
      min: options.min,
      max: options.max,
      step: options.step,
    })}>`
  }

  return [
    `${indent}<p>`,
    `${inner}<label for="${escapeHtml(id)}">${label}</label>`,
    `${inner}${control}${help}`,
    `${indent}</p>`,
  ].join('\n')
}

// A form as plain HTML for pasting into any page, which posts to the CMS with JavaScript off and takes the page's own
// styles. The honeypot sits off screen, out of reach of screen readers and the keyboard.
export const embedHtml = (fields: Array<FieldSchema>, action: string) =>
  [
    `<form method="post" action="${escapeHtml(action)}">`,
    ...fields.map((field) => fieldHtml(field, '', '  ')),
    '  <div aria-hidden="true" style="position: absolute; left: -10000px">',
    `    <label>Leave this empty <input name="${honeypot}" tabindex="-1" autocomplete="off"></label>`,
    '  </div>',
    '  <button type="submit">Send</button>',
    '</form>',
    '',
  ].join('\n')

// A page for a browser that posted a form without JavaScript, around HTML that's already escaped
export const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { max-width: 32rem; margin: 15vh auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.5 }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>
`
