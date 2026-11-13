import { createContext } from 'react'

// How the editor chooses files and entries, which its host gives it, as the Sorlo CMS gives its media library and entry
// search. Without them, the editor has no Insert a file and Link to an entry buttons, and shows linked files by ID.

export interface PickedFile {
  id: string
  name: string
  mime: string
  url: string
  alt?: string | null
}

export interface PickedEntry {
  id: string
  title: string
}

export interface Pickers {
  // Opens a way to choose a file, giving the one chosen, or nothing when none was
  media?: () => Promise<PickedFile | null | undefined>
  // Opens a way to choose an entry to link to
  entry?: () => Promise<PickedEntry | null | undefined>
  // The files a value shows, by ID, with null for one that's gone
  files?: (ids: Array<string>) => Promise<Record<string, PickedFile | null>>
}

export const PickersContext = createContext<Pickers>({})
