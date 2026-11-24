import { copyFile, mkdir } from 'node:fs/promises'
await mkdir('dist-server/server', { recursive: true })
await copyFile('server/schema.sql', 'dist-server/server/schema.sql')
for (const name of ['analytics-schema.sql', 'analytics-worker.mjs', 'analytics-projections.mjs', 'analytics-reports.mjs','analytics-operations-worker.mjs','analytics-clicks.mjs','analytics-timing.mjs','analytics-continuation.mjs']) await copyFile(`server/${name}`, `dist-server/server/${name}`)
