import type { Plugin } from '.'
import { builtInPlugins, cmsInputs, serverFields } from './relations'

// Whether a plugin is one the CMS includes, such as lexical(), which a site lists only for its settings. The admin has
// its components already, so sorlo build leaves it out.
export const isBuiltIn = (plugin: Plugin) => builtInPlugins.some((each) => each.name === plugin?.name)

// Adds the plugins' field types to cmsInputs, which the server checks and types values with, giving them a component
// that renders nothing, as the server never renders. A plugin the CMS includes replaces its fields with its own, such as
// for their settings. With any problem, such as a field type that a built-in field or another plugin has, it adds none
// and lists them all.
export function registerPlugins(plugins: Array<Plugin>) {
  const problems: Array<string> = []
  const owners = new Map<string, string>()
  plugins.forEach((plugin, index) => {
    if (typeof plugin?.name !== 'string' || typeof plugin.admin !== 'string' || typeof plugin.fields !== 'object') {
      problems.push(`Plugin ${index + 1} needs a name, its fields and admin, the module with their components.`)
      return
    }
    const builtIn = builtInPlugins.find((each) => each.name === plugin.name)
    for (const type of Object.keys(plugin.fields ?? {})) {
      const owner = owners.get(type)
      if (builtIn && !Object.hasOwn(builtIn.fields, type)) {
        problems.push(`${type}, from ${plugin.name}, isn't one of the fields the CMS includes from it.`)
      } else if (!builtIn && Object.hasOwn(cmsInputs, type)) {
        problems.push(`${type}, from ${plugin.name}, is a built-in field type.`)
      } else if (owner) problems.push(`${type}, from ${plugin.name}, is from ${owner} too.`)
      else owners.set(type, plugin.name)
    }
  })
  if (problems.length) return problems
  for (const plugin of plugins) Object.assign(cmsInputs, serverFields(plugin))
  return problems
}
