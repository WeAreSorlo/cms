import { Database, uuidv7 } from './db'
import type { EventName } from './schemas'
import { Kysely } from 'kysely'

// Writes an event for each record, such as { entry }, in the transaction of the change, so an event is kept only when
// its change is
export async function addEvents(trx: Kysely<Database>, name: EventName, records: Array<Record<string, any>>) {
  if (!records.length) return
  await trx
    .insertInto('events')
    .values(records.map((data) => ({ id: uuidv7(), name, data })))
    .execute()
}
