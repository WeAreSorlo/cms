import { defineConfig } from '@sorlo/cms'
import { FSDriver } from 'flydrive/drivers/fs'

export default defineConfig({
  database: {
    // Matches compose.yaml in the workspace root, which creates this database with the volume
    url: process.env.DATABASE_URL ?? 'postgres://sorlo:sorlo@localhost:5432/sorlo_starter',
  },
  // The admin's public address, which emailed links and file URLs start from. Without it, they come from each request
  url: process.env.APP_URL,
  storage: {
    default: 'local',
    services: {
      local: () => new FSDriver({ location: new URL('./storage/', import.meta.url), visibility: 'public' }),
    },
  },
  mail: {
    from: 'Sorlo <cms@example.com>',
    // Prints each email instead of sending it. A site sends them with its own library, such as nodemailer's
    // transporter.sendMail(message)
    send: async (message) => console.log(`Email to ${message.to.join(', ')}: ${message.subject}\n\n${message.text}\n`),
  },
  // Lets webhooks reach test servers on this machine
  webhooks: { allowNetworks: ['127.0.0.0/8', '::1'] },
  // The editor's Preview button, opening a post's saved draft on the site, here a frontend on port 3000. A site's
  // preview route checks a secret the address carries, such as from process.env, then turns on its draft mode.
  previews: {
    posts: ({ entry }) => (entry.slug ? `http://localhost:3000/api/preview?path=/blog/${entry.slug}` : undefined),
  },
})
