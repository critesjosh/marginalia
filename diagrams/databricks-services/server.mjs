import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const port = Number.parseInt(process.env.PORT ?? '4174', 10)
const host = process.env.HOST ?? '127.0.0.1'
const profile = process.env.DATABRICKS_PROFILE ?? 'me'
const dist = new URL('./dist/', import.meta.url).pathname

const catalog = 'marginalia_dev'
const schemas = {
  bronze: 'dev_critesjosh_marginalia_bronze',
  silver: 'dev_critesjosh_marginalia_silver',
  gold: 'dev_critesjosh_marginalia_gold',
  ops: 'dev_critesjosh_marginalia_ops',
  scoped: 'dev_critesjosh_marginalia_scoped',
}
const syncedTables = [
  'reader_interest_profile',
  'book_engagement',
  'recommendation_candidates',
  'intellectual_frontier',
]

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

let healthCache = null
let healthPromise = null

const runnableJobs = {
  intelligence: {
    label: 'Intelligence refresh',
    nameFragment: 'marginalia-events-ingestion-schedule',
    warning: 'Runs ingestion, Silver, model extraction, Gold, public enrichment, scoped views, and serving sync.',
  },
  librarian: {
    label: 'Librarian refresh',
    nameFragment: 'marginalia-librarian',
    warning: 'Rebuilds retrieval passages and may use serverless compute and Vector Search.',
  },
}

async function databricks(args, timeout = 30_000) {
  const { stdout } = await execFileAsync(
    'databricks',
    [...args, '--profile', profile, '--output', 'json'],
    { timeout, maxBuffer: 64 * 1024 * 1024 },
  )
  return JSON.parse(stdout)
}

async function attempt(label, operation) {
  try {
    return { label, value: await operation }
  } catch {
    return { label, value: null }
  }
}

function latestPipeline(pipelines, fragment) {
  const pipeline = pipelines.find((item) => item.name?.includes(fragment))
  const update = pipeline?.latest_updates?.[0]
  return {
    state: pipeline?.state ?? 'NOT FOUND',
    lastRun: update?.state ?? 'NO RUN',
    updatedAt: update?.creation_time ?? null,
    id: pipeline?.pipeline_id ?? null,
  }
}

function tableSummary(tables) {
  const safeTables = Array.isArray(tables) ? tables : []
  return {
    count: safeTables.length,
    names: safeTables.map((table) => table.name).sort(),
    types: safeTables.reduce((totals, table) => {
      const type = table.table_type ?? 'UNKNOWN'
      totals[type] = (totals[type] ?? 0) + 1
      return totals
    }, {}),
    updatedAt: safeTables.reduce((latest, table) => Math.max(latest, table.updated_at ?? 0), 0) || null,
  }
}

function appSummary(apps, name) {
  const app = apps.find((item) => item.name === name)
  return {
    state: app?.compute_status?.state ?? 'NOT FOUND',
    updatedAt: app?.update_time ?? null,
    url: app?.url ?? null,
  }
}

function matchesCronField(value, expression) {
  if (expression === '*' || expression === '?') return true
  if (expression.includes('/')) {
    const [startText, stepText] = expression.split('/')
    const start = startText === '*' ? 0 : Number(startText)
    const step = Number(stepText)
    return Number.isFinite(start) && Number.isFinite(step) && value >= start && (value - start) % step === 0
  }
  return Number(expression) === value
}

function nextScheduledRun(schedule) {
  if (!schedule || schedule.pause_status === 'PAUSED') return null
  const fields = schedule.quartz_cron_expression?.trim().split(/\s+/)
  if (!fields || fields.length < 6 || schedule.timezone_id !== 'UTC') return null
  const [, minute, hour, day, month, weekday] = fields
  const candidate = new Date()
  candidate.setUTCSeconds(0, 0)
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  for (let index = 0; index < 60 * 24 * 8; index += 1) {
    if (
      matchesCronField(candidate.getUTCMinutes(), minute)
      && matchesCronField(candidate.getUTCHours(), hour)
      && matchesCronField(candidate.getUTCDate(), day)
      && matchesCronField(candidate.getUTCMonth() + 1, month)
      && matchesCronField(candidate.getUTCDay() + 1, weekday)
    ) return candidate.toISOString()
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  }
  return null
}

function scheduleSummary(schedule) {
  if (!schedule) return { state: 'MANUAL', label: 'Manual only', nextRun: null }
  const cron = schedule.quartz_cron_expression
  let label = `${cron} ${schedule.timezone_id ?? ''}`.trim()
  if (cron === '0 0/15 * * * ?') label = 'Every 15 minutes (UTC)'
  if (cron === '0 20 * * * ?') label = 'Hourly at :20 (UTC)'
  if (cron === '0 30 3 * * ?') label = 'Daily at 03:30 (UTC)'
  return {
    state: schedule.pause_status ?? 'UNKNOWN',
    label,
    nextRun: nextScheduledRun(schedule),
  }
}

function runSummary(runs) {
  const latest = Array.isArray(runs) ? runs[0] : null
  if (!latest) return { status: 'NO RUN', active: false, startedAt: null, endedAt: null, durationMs: null, url: null }
  const lifeCycle = latest.state?.life_cycle_state ?? 'UNKNOWN'
  const active = !['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR'].includes(lifeCycle)
  return {
    status: active ? lifeCycle : (latest.state?.result_state ?? lifeCycle),
    active,
    startedAt: latest.start_time ? new Date(latest.start_time).toISOString() : null,
    endedAt: latest.end_time ? new Date(latest.end_time).toISOString() : null,
    durationMs: latest.start_time && latest.end_time ? latest.end_time - latest.start_time : null,
    url: latest.run_page_url ?? null,
  }
}

function workspaceLinks(runUrl, resources) {
  if (!runUrl) return {}
  const parsed = new URL(runUrl)
  const org = parsed.searchParams.get('o')
  const withOrg = (path) => `${parsed.origin}${path}${path.includes('?') ? '&' : '?'}o=${org}`
  const pipeline = (id) => id ? `${parsed.origin}/?o=${org}#joblist/pipelines/${id}` : null
  return {
    catalog: withOrg('/explore/data/marginalia_dev'),
    servingCatalog: withOrg('/explore/data/marginalia_serving_dev/marginalia_gold'),
    warehouse: resources.warehouse?.id ? withOrg(`/sql/warehouses/${resources.warehouse.id}`) : null,
    conceptModel: withOrg('/ml/endpoints/databricks-gpt-oss-120b'),
    librarianModel: withOrg('/ml/endpoints/marginalia-librarian-dev'),
    vectorSearch: withOrg('/compute/vector-search'),
    dashboard: resources.dashboard?.dashboard_id ? withOrg(`/dashboardsv3/${resources.dashboard.dashboard_id}/published`) : null,
    genie: resources.genie?.space_id ? withOrg(`/genie/rooms/${resources.genie.space_id}`) : null,
    bronzePipeline: pipeline(resources.bronzePipeline?.pipeline_id),
    silverPipeline: pipeline(resources.silverPipeline?.pipeline_id),
    goldPipeline: pipeline(resources.goldPipeline?.pipeline_id),
    frontierPipeline: pipeline(resources.frontierPipeline?.pipeline_id),
  }
}

async function collectHealth() {
  const requests = [
    attempt('warehouses', databricks(['warehouses', 'list'])),
    attempt('apps', databricks(['apps', 'list'])),
    attempt('pipelines', databricks(['pipelines', 'list-pipelines'])),
    attempt('jobs', databricks(['jobs', 'list', '--expand-tasks'])),
    attempt('models', databricks(['serving-endpoints', 'list'])),
    attempt('lakebase', databricks(['database', 'list-database-instances'])),
    attempt('dashboards', databricks(['lakeview', 'list'])),
    attempt('genie', databricks(['genie', 'list-spaces'])),
    attempt('vectorSearch', databricks(['vector-search-endpoints', 'list-endpoints'])),
    ...Object.entries(schemas).map(([layer, schema]) =>
      attempt(`tables:${layer}`, databricks(['tables', 'list', catalog, schema])),
    ),
    ...syncedTables.map((table) =>
      attempt(
        `sync:${table}`,
        databricks([
          'database',
          'get-synced-database-table',
          `marginalia_serving_dev.marginalia_gold.${table}`,
        ]),
      ),
    ),
  ]
  const results = await Promise.all(requests)
  const values = Object.fromEntries(results.map(({ label, value }) => [label, value]))
  const errors = results.filter(({ value }) => value === null).map(({ label }) => label)

  const warehouses = values.warehouses ?? []
  const apps = values.apps ?? []
  const pipelines = values.pipelines ?? []
  const jobs = values.jobs ?? []
  const models = values.models ?? []
  const instances = Array.isArray(values.lakebase)
    ? values.lakebase
    : values.lakebase?.database_instances ?? []
  const warehouse = warehouses.find((item) => item.name === 'Serverless Starter Warehouse')
  const mainJob = jobs.find((item) => item.settings?.name?.includes('marginalia-events-ingestion-schedule'))
  const librarianJob = jobs.find((item) => item.settings?.name?.includes('marginalia-librarian'))
  const conceptModel = models.find((item) => item.name === 'databricks-gpt-oss-120b')
  const librarianModel = models.find((item) => item.name === 'marginalia-librarian-dev')
  const lakebase = instances.find((item) => item.name === 'marginalia-lakebase-dev')
  const syncs = syncedTables.map((table) => {
    const item = values[`sync:${table}`]
    return {
      name: table,
      state: item?.data_synchronization_status?.detailed_state ?? 'UNKNOWN',
      updatedAt: item?.data_synchronization_status?.last_sync?.sync_end_timestamp ?? null,
    }
  })

  const dashboardList = values.dashboards?.dashboards ?? values.dashboards ?? []
  const genieList = values.genie?.spaces ?? values.genie ?? []
  const vectorList = values.vectorSearch?.endpoints ?? values.vectorSearch ?? []
  const dashboard = dashboardList.find((item) => item.display_name?.includes('Marginalia'))
  const genie = genieList.find((item) => (item.title ?? item.display_name)?.includes('Marginalia'))
  const projectJobs = Object.fromEntries(
    Object.entries(runnableJobs).map(([key, definition]) => [
      key,
      jobs.find((item) => item.settings?.name?.includes(definition.nameFragment)) ?? null,
    ]),
  )
  const runResults = await Promise.all(
    Object.entries(projectJobs).map(([key, job]) =>
      attempt(`runs:${key}`, job ? databricks(['jobs', 'list-runs', '--job-id', String(job.job_id), '--limit', '3']) : Promise.resolve([])),
    ),
  )
  for (const result of runResults) {
    values[result.label] = result.value
    if (result.value === null) errors.push(result.label)
  }
  const jobSummaries = Object.fromEntries(
    Object.entries(projectJobs).map(([key, job]) => {
      const definition = runnableJobs[key]
      const latest = runSummary(values[`runs:${key}`])
      return [key, {
        key,
        label: definition.label,
        warning: definition.warning,
        configured: Boolean(job),
        taskCount: job?.settings?.tasks?.length ?? 0,
        schedule: scheduleSummary(job?.settings?.schedule),
        latest,
      }]
    }),
  )
  const baseRunUrl = Object.values(jobSummaries).find((job) => job.latest.url)?.latest.url ?? null
  const projectPipelines = {
    bronzePipeline: pipelines.find((item) => item.name?.includes('marginalia-events-ingestion')),
    silverPipeline: pipelines.find((item) => item.name?.includes('marginalia-events-silver')),
    goldPipeline: pipelines.find((item) => item.name?.includes('marginalia-gold-profiles')),
    frontierPipeline: pipelines.find((item) => item.name?.includes('marginalia-frontier-gold')),
  }
  const links = workspaceLinks(baseRunUrl, {
    warehouse,
    dashboard,
    genie,
    ...projectPipelines,
  })
  const dashboardChecks = await Promise.all([
    attempt(
      'dashboardDraft',
      dashboard ? databricks(['lakeview', 'get', dashboard.dashboard_id]) : Promise.resolve(null),
    ),
    attempt(
      'dashboardPublished',
      dashboard ? databricks(['lakeview', 'get-published', dashboard.dashboard_id]) : Promise.resolve(null),
    ),
  ])
  for (const result of dashboardChecks) {
    values[result.label] = result.value
    if (result.value === null) errors.push(result.label)
  }
  let dashboardDatasets = []
  try {
    dashboardDatasets = JSON.parse(values.dashboardDraft?.serialized_dashboard ?? '{}').datasets ?? []
  } catch {
    errors.push('dashboardDefinition')
  }
  const dashboardScoped = dashboardDatasets.length > 0 && dashboardDatasets.every(
    (dataset) => dataset.catalog === catalog && dataset.schema === schemas.scoped,
  )
  const dashboardQualified = dashboardDatasets.length > 0 && dashboardDatasets.every((dataset) => {
    const sql = (dataset.queryLines ?? []).join('')
    return sql.includes(`\`${catalog}\`.\`${schemas.scoped}\`.\``)
  })
  const dashboardPublished = Boolean(values.dashboardPublished?.revision_create_time)

  return {
    observedAt: new Date().toISOString(),
    errors,
    jobs: jobSummaries,
    links,
    layers: {
      bronze: {
        ...latestPipeline(pipelines, 'marginalia-events-ingestion'),
        inventory: tableSummary(values['tables:bronze']),
      },
      silver: {
        ...latestPipeline(pipelines, 'marginalia-events-silver'),
        inventory: tableSummary(values['tables:silver']),
      },
      extraction: {
        state: conceptModel?.state?.ready ?? 'NOT FOUND',
        model: conceptModel?.name ?? 'databricks-gpt-oss-120b',
        jobState: mainJob?.settings?.schedule?.pause_status ?? 'UNKNOWN',
      },
      gold: {
        profilePipeline: latestPipeline(pipelines, 'marginalia-gold-profiles'),
        frontierPipeline: latestPipeline(pipelines, 'marginalia-frontier-gold'),
        inventory: tableSummary(values['tables:gold']),
      },
      publicSources: {
        state: mainJob ? 'CONFIGURED' : 'NOT FOUND',
        schedule: mainJob?.settings?.schedule?.pause_status ?? 'UNKNOWN',
        taskCount: mainJob?.settings?.tasks?.length ?? 0,
      },
      synced: {
        online: syncs.filter((item) => item.state === 'SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE').length,
        total: syncs.length,
        tables: syncs,
      },
      lakebase: {
        state: lakebase?.state ?? 'NOT FOUND',
        capacity: lakebase?.capacity ?? null,
      },
      servingApp: appSummary(apps, 'marginalia-intelligence-dev'),
      warehouse: {
        state: warehouse?.state ?? 'NOT FOUND',
        size: warehouse?.cluster_size ?? null,
        serverless: warehouse?.enable_serverless_compute === true,
      },
      observatory: appSummary(apps, 'marginalia-observatory-dev'),
      dashboard: {
        count: dashboardList.filter((item) => item.display_name?.includes('Marginalia')).length,
        state: dashboard?.lifecycle_state !== 'ACTIVE'
          ? (dashboard?.lifecycle_state ?? 'UNKNOWN')
          : (dashboardScoped && dashboardQualified && dashboardPublished ? 'ACTIVE' : 'STALE'),
        scoped: dashboardScoped,
        fullyQualified: dashboardQualified,
        published: dashboardPublished,
        publishedAt: values.dashboardPublished?.revision_create_time ?? null,
        url: links.dashboard ?? null,
      },
      genie: {
        count: genieList.filter((item) => (item.title ?? item.display_name)?.includes('Marginalia')).length,
        url: links.genie ?? null,
      },
      unity: {
        schemaCount: Object.keys(schemas).length,
        tableCount: Object.keys(schemas).reduce(
          (total, layer) => total + tableSummary(values[`tables:${layer}`]).count,
          0,
        ),
        inventories: Object.fromEntries(
          Object.keys(schemas).map((layer) => [layer, tableSummary(values[`tables:${layer}`])]),
        ),
      },
      librarian: {
        modelState: librarianModel?.state?.ready ?? 'NOT FOUND',
        jobSchedule: librarianJob?.settings?.schedule?.pause_status ?? 'UNKNOWN',
        vectorEndpointCount: vectorList.filter((item) => item.name?.includes('marginalia')).length,
      },
    },
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function runJob(key) {
  const definition = runnableJobs[key]
  if (!definition) throw new Error('That job is not available from this control center.')
  const jobs = await databricks(['jobs', 'list'])
  const job = jobs.find((item) => item.settings?.name?.includes(definition.nameFragment))
  if (!job) throw new Error(`${definition.label} was not found.`)
  const activeRuns = await databricks([
    'jobs',
    'list-runs',
    '--job-id',
    String(job.job_id),
    '--active-only',
    '--limit',
    '1',
  ])
  if (activeRuns.length > 0) {
    return {
      accepted: false,
      alreadyRunning: true,
      message: `${definition.label} already has an active run.`,
      run: runSummary(activeRuns),
    }
  }
  const result = await databricks([
    'jobs',
    'run-now',
    String(job.job_id),
    '--no-wait',
    '--idempotency-token',
    randomUUID(),
  ])
  healthCache = null
  return {
    accepted: true,
    alreadyRunning: false,
    message: `${definition.label} was queued.`,
    runId: result.run_id ?? null,
  }
}

async function health() {
  if (healthCache && Date.now() - healthCache.createdAt < 25_000) return healthCache.value
  if (!healthPromise) {
    healthPromise = collectHealth()
      .then((value) => {
        healthCache = { createdAt: Date.now(), value }
        return value
      })
      .finally(() => {
        healthPromise = null
      })
  }
  return healthPromise
}

const countTargets = [
  ['bronze', 'events_raw'],
  ['bronze', 'ingestion_quarantine'],
  ['bronze', 'public_sources_raw'],
  ['silver', 'events'],
  ['silver', 'reading_sessions'],
  ['silver', 'highlights_current'],
  ['silver', 'concept_extractions'],
  ['silver', 'public_book_candidates'],
  ['silver', 'research_works'],
  ['silver', 'librarian_passages'],
  ['gold', 'reader_interest_profile'],
  ['gold', 'book_engagement'],
  ['gold', 'intellectual_frontier'],
  ['gold', 'recommendation_candidates'],
  ['ops', 'deletion_requests'],
  ['ops', 'recommender_readiness'],
  ['ops', 'librarian_evaluations'],
]

function countStatement() {
  return countTargets
    .map(
      ([layer, table]) =>
        `SELECT '${layer}' AS layer, '${table}' AS object_name, COUNT(*) AS row_count FROM \`${catalog}\`.\`${schemas[layer]}\`.\`${table}\``,
    )
    .join('\nUNION ALL\n')
}

async function loadCounts() {
  const warehouses = await databricks(['warehouses', 'list'])
  const warehouse = warehouses.find((item) => item.name === 'Serverless Starter Warehouse')
  if (!warehouse?.id) throw new Error('The configured SQL Warehouse was not found.')

  const payload = JSON.stringify({
    warehouse_id: warehouse.id,
    statement: countStatement(),
    wait_timeout: '50s',
    disposition: 'INLINE',
    format: 'JSON_ARRAY',
  })
  let response = await databricks(
    ['api', 'post', '/api/2.0/sql/statements', '--json', payload],
    65_000,
  )
  const statementId = response.statement_id
  for (
    let attemptNumber = 0;
    ['PENDING', 'RUNNING'].includes(response.status?.state) && attemptNumber < 12;
    attemptNumber += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    response = await databricks(['api', 'get', `/api/2.0/sql/statements/${statementId}`])
  }
  if (response.status?.state !== 'SUCCEEDED') {
    throw new Error(`Count query ended in ${response.status?.state ?? 'UNKNOWN'}.`)
  }
  return {
    observedAt: new Date().toISOString(),
    warehouseStateBeforeQuery: warehouse.state,
    rows: (response.result?.data_array ?? []).map(([layer, objectName, rowCount]) => ({
      layer,
      object: objectName,
      rows: Number(rowCount),
    })),
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

async function serveStatic(request, response) {
  const requested = request.url === '/' ? 'index.html' : request.url.slice(1).split('?')[0]
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = join(dist, safePath)
  try {
    const fileStat = await stat(filePath)
    if (fileStat.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = join(dist, 'index.html')
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(response)
}

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/api/health') {
      sendJson(response, 200, await health())
      return
    }
    if (request.method === 'POST' && request.url === '/api/counts') {
      sendJson(response, 200, await loadCounts())
      return
    }
    if (request.method === 'POST' && request.url === '/api/actions/run-job') {
      if (!request.headers['content-type']?.startsWith('application/json')) {
        sendJson(response, 415, { error: 'JSON is required.' })
        return
      }
      const body = await readJson(request)
      if (body.confirmed !== true) {
        sendJson(response, 400, { error: 'Explicit confirmation is required.' })
        return
      }
      sendJson(response, 202, await runJob(body.job))
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response)
      return
    }
    sendJson(response, 405, { error: 'Method not allowed' })
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? error.message : 'Databricks request failed' })
  }
}).listen(port, host, () => {
  console.log(`Marginalia Databricks dashboard: http://${host}:${port}`)
  console.log(`Databricks profile: ${profile}; only aggregate metadata leaves the server.`)
})
