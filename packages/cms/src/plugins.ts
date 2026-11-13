import type { Plugin } from '.'
import { cmsInputs } from './relations'

// Adds the plugins' field types to cmsInputs, which the server checks and types values with, giving them a component
// that renders nothing, as the server never renders. With any problem, such as a field type that a built-in field or
// another plugin has, it adds none and lists them all.
export function registerPlugins(plugins: Array<Plugin>) {
  const problems: Array<string> = []
  const owners = new Map<string, string>()
  plugins.forEach((plugin, index) => {
    if (typeof plugin?.name !== 'string' || typeof plugin.admin !== 'string' || typeof plugin.fields !== 'object') {
      problems.push(`Plugin ${index + 1} needs a name, its fields and admin, the module with their components.`)
      return
    }
    for (const type of Object.keys(plugin.fields ?? {})) {
      const owner = owners.get(type)
      if (Object.hasOwn(cmsInputs, type)) problems.push(`${type}, from ${plugin.name}, is a built-in field type.`)
      else if (owner) problems.push(`${type}, from ${plugin.name}, is from ${owner} too.`)
      else owners.set(type, plugin.name)
    }
  })
  if (problems.length) return problems
  for (const plugin of plugins) {
    for (const [type, field] of Object.entries(plugin.fields ?? {})) cmsInputs[type] = { ...field, default: () => null }
  }
  return problems
}
