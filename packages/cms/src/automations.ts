import type { AutomationOptions, MailOptions, WebhookOptions } from '.'
import { ActionFailed, actions, webhookNetworks } from './actions'
import {
  baseInputSchemaFields,
  evaluateCondition,
  evaluateConditions,
  inputs,
  normaliseConditions,
  pickValues,
  validateServerValues,
} from './core'
import { Database, isUuid, uuidv7 } from './db'
import type { AdminEnv } from './entries'
import { RunRow, listRuns, parseRunQuery } from './query'
import { automationSchema } from './schemas'
import type { ContentType } from './types'
import { Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ConditionGroup } from 'iight'
import { Kysely, Selectable, sql } from 'kysely'

// Automations: a trigger, conditions on the event's data, and actions run in order (PLAN.md section 11)

type AutomationRow = Selectable<Database['automations']>

// Core checks conditions on a field, so an automation's are checked as a field's would be
const asField = (conditions: Array<ConditionGroup>) => ({ type: 'automation', name: 'automation', conditions })

const toAutomation = (row: AutomationRow) => ({
  id: row.id,
  name: row.name,
  triggers: row.triggers,
  conditions: row.conditions,
  actions: row.actions,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toRun = (row: RunRow, event?: { name: string; created_at: Date }) => ({
  id: row.id,
  event: { id: row.event_id, name: event?.name, createdAt: event?.created_at },
  action: row.action,
  attempt: row.attempt,
  status: row.status,
  runAt: row.run_at,
  finishedAt: row.finished_at,
  response: row.response,
  error: row.error,
})

// Whether a form's submissions can run an automation: it's triggered by them, and in one of its groups the rules on
// form.* match the form. Its other rules depend on each submission, so they count as matching.
const runsFor = (row: AutomationRow, form: { id: string; name: string; label: string }) => {
  const groups = normaliseConditions(asField(row.conditions))
  return (
    row.triggers.includes('submission.created') &&
    (!groups.length ||
      groups.some((rules) =>
        rules.every((rule) => !rule.field.startsWith('form.') || evaluateCondition(rule, [{ form }])),
      ))
  )
}

// The admin API for automations and their runs. Every route needs a session, which createApp checks.
export function automationRoutes(db: Kysely<Database>) {
  const app = new Hono<AdminEnv>()
  const schema = automationSchema(baseInputSchemaFields())

  const find = async (id: string) => {
    const row = isUuid(id)
      ? await db.selectFrom('automations').selectAll().where('id', '=', id).executeTakeFirst()
      : undefined
    if (!row) throw new HTTPException(404)
    return row
  }

  const save = async (c: Context<AdminEnv>, existing?: AutomationRow) => {
    const body = await c.req.json().catch(() => ({}))
    const picked = pickValues(schema, body ?? {}, inputs)
    const values: Record<string, any> = {
      ...picked,
      actions: (picked.actions ?? []).map((block: any) => actions[block._layout]?.prepare?.(block) ?? block),
    }
    const report = await validateServerValues(schema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    // Checks core has no inputs for, such as a webhook's header names, shown on the actions
    const problems = values.actions.flatMap((block: any, index: number) =>
      (actions[block._layout].check?.(block) ?? []).map((problem) => `Action ${index + 1}: ${problem}`),
    )
    if (problems.length) {
      return c.json(
        { isValid: false, fields: { ...report.fields, actions: { isValid: false, messages: problems } } },
        422,
      )
    }

    const user = c.var.user.id
    const saved = {
      name: values.name,
      triggers: JSON.stringify(values.triggers),
      conditions: JSON.stringify(values.conditions ?? []),
      actions: JSON.stringify(values.actions),
      updated_by: user,
    }
    const row = existing
      ? await db
          .updateTable('automations')
          .set({ ...saved, updated_at: sql`now()` })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await db
          .insertInto('automations')
          .values({ ...saved, id: uuidv7(), created_by: user })
          .returningAll()
          .executeTakeFirstOrThrow()
    return c.json({ data: toAutomation(row) }, existing ? 200 : 201)
  }

  // Every automation, or with form=<id>, those that form's submissions can run
  // shortcut: every automation, unpaged, page them when sites have hundreds
  app.get('/automations', async (c) => {
    const formId = c.req.query('form')
    const form =
      formId === undefined
        ? undefined
        : isUuid(formId)
          ? await db.selectFrom('forms').select(['id', 'name', 'label']).where('id', '=', formId).executeTakeFirst()
          : undefined
    if (formId !== undefined && !form) throw new HTTPException(404)

    const rows = await db.selectFrom('automations').selectAll().orderBy('name').execute()
    return c.json({ data: rows.filter((row) => !form || runsFor(row, form)).map(toAutomation) })
  })

  app.post('/automations', (c) => save(c))

  app.get('/automations/:id', async (c) => c.json({ data: toAutomation(await find(c.req.param('id'))) }))

  app.put('/automations/:id', async (c) => save(c, await find(c.req.param('id'))))

  // Deletes an automation with its runs, including those still to come
  app.delete('/automations/:id', async (c) => {
    const row = await find(c.req.param('id'))
    await db.deleteFrom('automations').where('id', '=', row.id).execute()
    return c.body(null, 204)
  })

  // A page of an automation's runs, each a try of one of its actions, with the event it was for
  app.get('/automations/:id/runs', async (c) => {
    const row = await find(c.req.param('id'))
    const { data, pagination } = await listRuns(db, row.id, parseRunQuery(c.req.query()))
    const ids = [...new Set(data.map((run) => run.event_id))]
    const found = ids.length
      ? await db.selectFrom('events').select(['id', 'name', 'created_at']).where('id', 'in', ids).execute()
      : []
    const events = new Map(found.map((event) => [event.id, event]))
    return c.json({ data: data.map((run) => toRun(run, events.get(run.event_id))), pagination })
  })

  return app
}

// Seconds before each retry, the last for every retry after them
const retryDelays = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 12 * 60 * 60]

export interface WorkerOptions {
  mail?: MailOptions
  automations?: AutomationOptions
  webhooks?: WebhookOptions
}

// Hands events on to the automations they trigger and runs their actions, in the server's own process. Locks with
// SKIP LOCKED keep two workers, such as two processes behind a load balancer, off the same event and the same run.
export function createWorker(
  db: Kysely<Database>,
  types: Map<string, ContentType>,
  { mail, automations: { attempts = 6 } = {}, webhooks: { allowNetworks } = {} }: WorkerOptions = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('automations.attempts in iight.config.ts needs a whole number from 1.')
  }
  const reaches = webhookNetworks(allowNetworks)

  // Queues a run of the first action of each automation that each new event triggers, then marks the events as
  // dispatched, all or nothing. Returns how many events it took.
  const dispatch = () =>
    db.transaction().execute(async (trx) => {
      const found = await trx
        .selectFrom('events')
        .selectAll()
        .where('dispatched_at', 'is', null)
        .orderBy('id')
        .limit(100)
        .forUpdate()
        .skipLocked()
        .execute()
      if (!found.length) return 0

      const automations = await trx.selectFrom('automations').select(['id', 'triggers', 'conditions']).execute()
      const runs = found.flatMap((event) =>
        automations
          .filter(
            (automation) =>
              automation.triggers.includes(event.name) &&
              evaluateConditions(asField(automation.conditions), [event.data]),
          )
          .map((automation) => ({
            id: uuidv7(),
            automation_id: automation.id,
            event_id: event.id,
            action: 0,
            attempt: 1,
            status: 'pending' as const,
          })),
      )
      if (runs.length) await trx.insertInto('automation_runs').values(runs).execute()
      await trx
        .updateTable('events')
        .set({ dispatched_at: sql`now()` })
        .where(
          'id',
          'in',
          found.map((event) => event.id),
        )
        .execute()
      return found.length
    })

  // Tries one run that's due, if there is one, and logs it. Then it queues the automation's next action when it
  // succeeds, or another try later when it fails, until the tries run out. A crash before it commits leaves the run
  // pending, to be tried again, so each action runs at least once. Returns whether it found a run.
  // shortcut: one run at a time, so a slow webhook holds up the others; run several at once when sites need it
  const deliver = () =>
    db.transaction().execute(async (trx) => {
      const run = await trx
        .selectFrom('automation_runs')
        .selectAll()
        .where('status', '=', 'pending')
        .where('run_at', '<=', sql<Date>`now()`)
        .orderBy('run_at')
        .orderBy('id')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (!run) return false

      const automation = await trx
        .selectFrom('automations')
        .selectAll()
        .where('id', '=', run.automation_id)
        .executeTakeFirstOrThrow()
      const event = await trx.selectFrom('events').selectAll().where('id', '=', run.event_id).executeTakeFirstOrThrow()

      // shortcut: a try runs the action at its place as it is now, so a fixed URL counts from the next try, but an
      // action added or moved in between takes another's place; keep each action's settings with its runs if that bites
      const settings = automation.actions[run.action]
      const action = actions[settings?._layout]
      let result: Pick<RunRow, 'status' | 'response' | 'error'>
      try {
        if (!action) throw new ActionFailed('The automation no longer has this action.')
        const response = await action.run(settings, event, { db: trx, types, automation, mail, reaches })
        result = { status: 'succeeded', response, error: null }
      } catch (error) {
        const response = error instanceof ActionFailed ? error.response : null
        result = { status: 'failed', response, error: error instanceof Error ? error.message : String(error) }
      }
      await trx
        .updateTable('automation_runs')
        .set({ ...result, finished_at: sql`clock_timestamp()` })
        .where('id', '=', run.id)
        .execute()

      const next =
        result.status === 'succeeded'
          ? run.action + 1 < automation.actions.length && { action: run.action + 1, attempt: 1, delay: 0 }
          : run.attempt < attempts && {
              action: run.action,
              attempt: run.attempt + 1,
              delay: retryDelays[Math.min(run.attempt, retryDelays.length) - 1],
            }
      if (next) {
        await trx
          .insertInto('automation_runs')
          .values({
            id: uuidv7(),
            automation_id: run.automation_id,
            event_id: run.event_id,
            action: next.action,
            attempt: next.attempt,
            status: 'pending',
            run_at: sql`clock_timestamp() + make_interval(secs => ${next.delay})`,
          })
          .execute()
      }
      return true
    })

  // Dispatches and delivers for as long as the process runs, resting for a second when there's nothing to do, and for
  // ten after an error, such as the database being down or not migrated yet
  const start = async () => {
    for (;;) {
      const rest = await dispatch()
        .then(async (events) => ((await deliver()) || events > 0 ? 0 : 1000))
        .catch((error) => {
          console.error(error)
          return 10_000
        })
      if (rest) await new Promise((resolve) => setTimeout(resolve, rest))
    }
  }

  return { dispatch, deliver, start }
}
