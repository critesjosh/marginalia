import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const profile = process.env.DATABRICKS_PROFILE ?? 'me'
const sourcePath = fileURLToPath(
  new URL('../../../databricks/dashboards/marginalia.lvdash.json', import.meta.url),
)
const catalog = 'marginalia_dev'
const schema = 'dev_critesjosh_marginalia_scoped'

async function databricks(args) {
  const { stdout } = await execFileAsync(
    'databricks',
    [...args, '--profile', profile, '--output', 'json'],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  )
  return JSON.parse(stdout)
}

const dashboards = await databricks(['lakeview', 'list'])
const dashboard = dashboards.find((item) => item.display_name?.includes('Marginalia (dev)'))
if (!dashboard?.dashboard_id) throw new Error('The Marginalia development dashboard was not found.')

const warehouses = await databricks(['warehouses', 'list'])
const warehouse = warehouses.find((item) => item.name === 'Serverless Starter Warehouse')
if (!warehouse?.id) throw new Error('The dashboard SQL Warehouse was not found.')

const dashboardDefinition = JSON.parse(await readFile(sourcePath, 'utf8'))
const sourceTables = {
  interests: 'reader_interest_profile',
  engagement: 'book_engagement',
  frontier: 'intellectual_frontier',
}
for (const dataset of dashboardDefinition.datasets ?? []) {
  const table = sourceTables[dataset.name]
  if (!table) throw new Error(`No scoped source table is declared for dataset ${dataset.name}.`)
  dataset.queryLines = dataset.queryLines.map((line) =>
    line.trim() === `FROM ${table}`
      ? `FROM \`${catalog}\`.\`${schema}\`.\`${table}\`\n`
      : line,
  )
}
const serializedDashboard = JSON.stringify(dashboardDefinition, null, 2)
await databricks([
  'lakeview',
  'update',
  dashboard.dashboard_id,
  '--display-name',
  dashboard.display_name,
  '--serialized-dashboard',
  serializedDashboard,
  '--dataset-catalog',
  catalog,
  '--dataset-schema',
  schema,
  '--warehouse-id',
  warehouse.id,
])

await databricks([
  'lakeview',
  'publish',
  dashboard.dashboard_id,
  '--json',
  JSON.stringify({
    embed_credentials: false,
    warehouse_id: warehouse.id,
  }),
])

const draft = await databricks(['lakeview', 'get', dashboard.dashboard_id])
const published = await databricks(['lakeview', 'get-published', dashboard.dashboard_id])
const definition = JSON.parse(draft.serialized_dashboard)
const datasets = definition.datasets ?? []
if (
  datasets.length === 0
  || datasets.some((dataset) => dataset.catalog !== catalog || dataset.schema !== schema)
) {
  throw new Error('The live dashboard did not retain the scoped dataset namespace.')
}
for (const dataset of datasets) {
  const table = sourceTables[dataset.name]
  const sql = dataset.queryLines.join('')
  const expected = `\`${catalog}\`.\`${schema}\`.\`${table}\``
  if (!sql.includes(expected)) {
    throw new Error(`Dataset ${dataset.name} is not fully qualified.`)
  }
}
if (published.embed_credentials !== false) {
  throw new Error('The published dashboard embedded publisher credentials.')
}

console.log(JSON.stringify({
  dashboardId: dashboard.dashboard_id,
  datasets: datasets.map((dataset) => dataset.name),
  catalog,
  schema,
  fullyQualified: true,
  publishedAt: published.revision_create_time,
  embedCredentials: published.embed_credentials,
}))
