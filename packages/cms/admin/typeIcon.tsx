import { FileText } from 'lucide-react'
import { DynamicIcon, IconName, iconNames } from 'lucide-react/dynamic'

// A content type's icon, named in its type file and loaded the first time it shows. Unknown names get a page.
export default function TypeIcon({ name }: { name?: string }) {
  if (!name || !iconNames.includes(name as IconName)) return <FileText />
  return <DynamicIcon name={name as IconName} fallback={() => <span className='cms-icon' />} />
}
