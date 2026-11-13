// Trees as Lexical writes them, cut to what the tests need

export const text = (value: string, format = 0) => ({ type: 'text', text: value, format, version: 1 })

export const paragraph = (...children: Array<object>) => ({ type: 'paragraph', version: 1, children })

export const tree = (...children: Array<object>) => ({
  root: { type: 'root', version: 1, format: '', indent: 0, direction: 'ltr', children },
})

export const layouts = [
  {
    name: 'callout',
    label: 'Callout',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'tone', label: 'Tone', type: 'text', defaultValue: 'info' },
    ],
  },
]

export const block = (values: Record<string, unknown>) => ({ type: 'block', version: 1, block: values })
