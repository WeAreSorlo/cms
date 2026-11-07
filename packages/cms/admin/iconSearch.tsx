import { EmptyState, Pages } from './ui'
import Form, { FieldSchema } from '@sorlo/core'
import { Search } from 'lucide-react'
import { DynamicIcon, iconNames } from 'lucide-react/dynamic'
import { useState } from 'react'

const perPage = 48
const schema: Array<FieldSchema> = [{ name: 'search', label: 'Search', type: 'text', options: { placeholder: 'Name' } }]
// Alphabetical, since Lucide's own list puts pen after pen-tool
const names = [...iconNames].sort()

// Lucide's icons, searched by name, a page at a time since each one loads on its own
export default function IconSearch({ chosen, onPick }: { chosen?: string; onPick: (name: string) => void }) {
  const [{ search, page }, setQuery] = useState({ search: '', page: 1 })
  const words = search
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
  const found = names.filter((name) => words.every((word) => name.includes(word)))
  // Names that start with the search come first, so pen and pencil come before book-open
  const starts = (name: string) => (name.startsWith(words.join('-')) ? 0 : 1)
  found.sort((a, b) => starts(a) - starts(b))

  return (
    <>
      <Form
        schema={schema}
        onValuesChange={(values) => {
          const next = values.search ?? ''
          setQuery((query) => (query.search === next ? query : { search: next, page: 1 }))
        }}
      />
      {found.length === 0 && <EmptyState icon={<Search />}>Nothing matches.</EmptyState>}
      {found.length > 0 && (
        <>
          <ul className='cms-icon-grid'>
            {found.slice((page - 1) * perPage, page * perPage).map((name) => (
              <li key={name}>
                <button type='button' aria-current={name === chosen || undefined} onClick={() => onPick(name)}>
                  <DynamicIcon name={name} size={24} fallback={() => <span className='cms-icon' />} />
                  {name}
                </button>
              </li>
            ))}
          </ul>
          <Pages
            pagination={{ page, perPage, total: found.length, lastPage: Math.ceil(found.length / perPage) }}
            onPage={(next) => setQuery({ search, page: next })}
          />
        </>
      )}
    </>
  )
}
