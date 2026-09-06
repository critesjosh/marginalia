import { useCallback, useEffect, useRef, useState } from 'react'
import { Tldraw, createShapeId, toRichText } from 'tldraw'
import 'tldraw/tldraw.css'

const shapeIds = {
  browser: createShapeId('browser'),
  worker: createShapeId('cloudflare-worker'),
  kafka: createShapeId('confluent-kafka'),
  bronze: createShapeId('bronze'),
  silver: createShapeId('silver'),
  extraction: createShapeId('concept-extraction'),
  gold: createShapeId('gold'),
  publicSources: createShapeId('public-sources'),
  synced: createShapeId('synced-tables'),
  lakebase: createShapeId('lakebase'),
  servingApp: createShapeId('serving-app'),
  warehouse: createShapeId('sql-warehouse'),
  observatory: createShapeId('observatory'),
  dashboard: createShapeId('dashboard'),
  genie: createShapeId('genie'),
  librarian: createShapeId('librarian'),
  bundles: createShapeId('bundles'),
  unity: createShapeId('unity-catalog'),
}

const nodes = [
  {
    id: shapeIds.browser,
    x: 80,
    y: 380,
    w: 270,
    h: 150,
    color: 'violet',
    text: 'Marginalia browser\n\nCaptures opt-in reading events; renders returned insights',
  },
  {
    id: shapeIds.worker,
    x: 450,
    y: 380,
    w: 270,
    h: 150,
    color: 'blue',
    text: 'Cloudflare Worker\n\nAuthenticates, validates, stamps user identity, hides Databricks',
  },
  {
    id: shapeIds.kafka,
    x: 820,
    y: 380,
    w: 250,
    h: 150,
    color: 'orange',
    text: 'Confluent Kafka\n\nDurable event buffer with seven-day retention',
  },
  {
    id: shapeIds.bronze,
    x: 1190,
    y: 380,
    w: 260,
    h: 150,
    color: 'orange',
    text: 'Bronze\nLakeflow pipeline\n\nRaw Kafka records and public-provider responses',
  },
  {
    id: shapeIds.silver,
    x: 1570,
    y: 380,
    w: 270,
    h: 150,
    color: 'light-blue',
    text: 'Silver\nLakeflow pipeline\n\nValidate, quarantine, deduplicate, reconstruct state and sessions',
  },
  {
    id: shapeIds.extraction,
    x: 1960,
    y: 380,
    w: 300,
    h: 150,
    color: 'violet',
    text: 'Concept extraction\nLakeflow Job + Model Serving\n\nCalls databricks-gpt-oss-120b once per content hash',
  },
  {
    id: shapeIds.gold,
    x: 2380,
    y: 380,
    w: 280,
    h: 150,
    color: 'yellow',
    text: 'Gold\nLakeflow pipelines\n\nInterest profile, engagement, frontier and recommendations',
  },
  {
    id: shapeIds.publicSources,
    x: 1960,
    y: 680,
    w: 300,
    h: 150,
    color: 'light-green',
    text: 'Public-source job\n\nOpen Library for books; OpenAlex for adjacent research topics',
  },
  {
    id: shapeIds.synced,
    x: 2380,
    y: 870,
    w: 280,
    h: 150,
    color: 'light-green',
    text: 'Synced tables\n\nSnapshot reverse ETL from selected Gold materialized views',
  },
  {
    id: shapeIds.lakebase,
    x: 1960,
    y: 870,
    w: 300,
    h: 150,
    color: 'green',
    text: 'Lakebase Postgres\n\nIndexed, low-latency serving copy; analytics remain source of truth',
  },
  {
    id: shapeIds.servingApp,
    x: 1570,
    y: 870,
    w: 270,
    h: 150,
    color: 'blue',
    text: 'Databricks App API\n\nPrivate service identity; reads Lakebase and starts deletion jobs',
  },
  {
    id: shapeIds.warehouse,
    x: 2380,
    y: 1290,
    w: 280,
    h: 140,
    color: 'light-blue',
    text: 'SQL Warehouse\n\nInteractive SQL compute over governed Gold projections',
  },
  {
    id: shapeIds.observatory,
    x: 1880,
    y: 1540,
    w: 260,
    h: 140,
    color: 'blue',
    text: 'Observatory App\n\nReader-facing inspection UI; scoped to one trusted user',
  },
  {
    id: shapeIds.dashboard,
    x: 2260,
    y: 1540,
    w: 260,
    h: 140,
    color: 'yellow',
    text: 'AI/BI Dashboard\n\nFixed visual analysis over Gold',
  },
  {
    id: shapeIds.genie,
    x: 2640,
    y: 1540,
    w: 260,
    h: 140,
    color: 'violet',
    text: 'Genie\n\nNatural-language questions translated into governed SQL',
  },
]

const alternatives = [
  ['Ingest + transform', 'Spark Structured Streaming, Flink, dbt'],
  ['Orchestration', 'Airflow, Dagster, Prefect'],
  ['Governance', 'Glue + Lake Formation, Polaris'],
  ['Model inference', 'External LLM API, MLflow endpoint, vLLM'],
  ['Operational serving', 'RDS, Neon, Supabase, direct warehouse SQL'],
  ['Reverse ETL', 'Census, Hightouch, custom incremental job'],
  ['Apps', 'Cloud Run, Lambda, Kubernetes, Streamlit hosting'],
  ['BI + text-to-SQL', 'Tableau, Power BI, Looker, custom agent'],
]

const findings = [
  'REMOTE PR IS NOT READY TO MERGE',
  'Remote head 4baf593 is six commits behind local HEAD.',
  'OpenAlex is used as a book recommender, producing research instead of books.',
  'Provider retries are cross-contaminated; malformed JSON receives a success TTL.',
  'A Spark closure can fail only on workers with ModuleNotFoundError.',
  'PR text says Phase 7 is unbuilt, but Phase 7 is already in the remote commits.',
  'Dashboard and Genie still need real per-reader isolation before multi-user use.',
]

const baseCopy = Object.fromEntries(nodes.map((node) => [node.id, node.text]))

const layoutVersionKey = 'marginalia-databricks-services-layout'
const layoutVersion = '2'
const layoutV2 = {
  [shapeIds.bundles]: { x: 80, y: 200, w: 1500, h: 110 },
  [shapeIds.unity]: { x: 1680, y: 200, w: 1420, h: 110 },
  [createShapeId('ingestion-label')]: { x: 80, y: 350, w: 900 },
  [shapeIds.browser]: { x: 80, y: 430, w: 320, h: 260 },
  [shapeIds.worker]: { x: 500, y: 430, w: 320, h: 260 },
  [shapeIds.kafka]: { x: 920, y: 430, w: 320, h: 260 },
  [shapeIds.bronze]: { x: 1340, y: 430, w: 320, h: 340 },
  [shapeIds.silver]: { x: 1760, y: 430, w: 320, h: 340 },
  [shapeIds.extraction]: { x: 2180, y: 430, w: 320, h: 320 },
  [shapeIds.gold]: { x: 2600, y: 430, w: 360, h: 400 },
  [shapeIds.publicSources]: { x: 2180, y: 880, w: 360, h: 300 },
  [createShapeId('serving-label')]: { x: 1460, y: 1210, w: 900 },
  [shapeIds.servingApp]: { x: 1460, y: 1290, w: 360, h: 290 },
  [shapeIds.lakebase]: { x: 2020, y: 1290, w: 360, h: 260 },
  [shapeIds.synced]: { x: 2580, y: 1290, w: 400, h: 340 },
  [createShapeId('analysis-label')]: { x: 1460, y: 1690, w: 900 },
  [shapeIds.warehouse]: { x: 2580, y: 1770, w: 400, h: 250 },
  [shapeIds.observatory]: { x: 1460, y: 2110, w: 360, h: 250 },
  [shapeIds.dashboard]: { x: 2020, y: 2110, w: 360, h: 230 },
  [shapeIds.genie]: { x: 2580, y: 2110, w: 400, h: 230 },
  [createShapeId('alternatives-title')]: { x: 3350, y: 200, w: 900 },
  ...Object.fromEntries(
    alternatives.map((_, index) => [
      createShapeId(`alternative-${index}`),
      { x: 3350, y: 300 + index * 160, w: 900, h: 120 },
    ]),
  ),
  [createShapeId('interview-takeaway')]: { x: 3350, y: 1640, w: 900 },
  [createShapeId('takeaway')]: { x: 3350, y: 1720, w: 900, h: 420 },
  [createShapeId('open-risk')]: { x: 3350, y: 2220, w: 900, h: 310 },
  [createShapeId('review-title')]: { x: 80, y: 2470, w: 1000 },
  [createShapeId('review-findings')]: { x: 80, y: 2550, w: 2980, h: 540 },
  [shapeIds.librarian]: { x: 3350, y: 2630, w: 900, h: 390 },
}

const arrowLayoutV2 = {
  [createShapeId('browser-worker')]: [400, 560, 500, 560],
  [createShapeId('worker-kafka')]: [820, 560, 920, 560],
  [createShapeId('kafka-bronze')]: [1240, 560, 1340, 560],
  [createShapeId('bronze-silver')]: [1660, 560, 1760, 560],
  [createShapeId('silver-extraction')]: [2080, 560, 2180, 560],
  [createShapeId('extraction-gold')]: [2500, 560, 2600, 560],
  [createShapeId('gold-public')]: [2600, 700, 2540, 940],
  [createShapeId('public-gold')]: [2540, 1100, 2780, 830],
  [createShapeId('gold-synced')]: [2780, 830, 2780, 1290],
  [createShapeId('synced-lakebase')]: [2580, 1440, 2380, 1440],
  [createShapeId('lakebase-serving')]: [2020, 1440, 1820, 1440],
  [createShapeId('serving-worker')]: [1460, 1500, 660, 690],
  [createShapeId('gold-warehouse')]: [2900, 820, 2980, 1770],
  [createShapeId('warehouse-observatory')]: [2630, 2020, 1640, 2110],
  [createShapeId('warehouse-dashboard')]: [2750, 2020, 2200, 2110],
  [createShapeId('warehouse-genie')]: [2870, 2020, 2780, 2110],
}

function applyLayoutV2(editor) {
  try {
    if (window.localStorage.getItem(layoutVersionKey) === layoutVersion) return
  } catch {
    // A blocked localStorage should not prevent the diagram from being laid out.
  }

  editor.run(
    () => {
      const shapeUpdates = Object.entries(layoutV2).flatMap(([id, layout]) => {
        const shape = editor.getShape(id)
        if (!shape) return []
        const props = shape.type === 'geo'
          ? { w: layout.w, h: layout.h, growY: 0, size: 's' }
          : { w: layout.w }
        return [{ id: shape.id, type: shape.type, x: layout.x, y: layout.y, props }]
      })
      const arrowUpdates = Object.entries(arrowLayoutV2).flatMap(([id, points]) => {
        const shape = editor.getShape(id)
        if (!shape) return []
        const [x1, y1, x2, y2] = points
        return [{
          id: shape.id,
          type: 'arrow',
          x: x1,
          y: y1,
          props: { start: { x: 0, y: 0 }, end: { x: x2 - x1, y: y2 - y1 } },
        }]
      })
      editor.updateShapes([...shapeUpdates, ...arrowUpdates])
    },
    { history: 'ignore' },
  )
  editor.zoomToBounds({ x: 0, y: 0, w: 4380, h: 3180 }, { targetZoom: 0.22 })
  try {
    window.localStorage.setItem(layoutVersionKey, layoutVersion)
  } catch {
    // Layout still succeeds when persistence is unavailable.
  }
}

function compactState(value) {
  return String(value ?? 'UNKNOWN')
    .replace('SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE', 'ONLINE')
    .replaceAll('_', ' ')
}

function time(value) {
  if (!value) return 'unknown time'
  return new Date(value).toLocaleString()
}

function countsFor(counts, layer, names) {
  if (!counts?.rows) return []
  return counts.rows
    .filter((row) => row.layer === layer && names.includes(row.object))
    .map((row) => `${row.object}: ${row.rows.toLocaleString()} rows`)
}

function statusKind(status) {
  const value = compactState(status).toUpperCase()
  if (/(FAILED|ERROR|OFFLINE|UNAVAILABLE|NOT FOUND)/.test(value)) return 'bad'
  if (/(STALE|PAUSED|STOPPED|DEGRADED|NO RUN|UNKNOWN|EMPTY)/.test(value)) return 'stale'
  if (/(RUNNING|PENDING|QUEUED|STARTING|UPDATING)/.test(value)) return 'active'
  if (/(SUCCESS|COMPLETED|READY|AVAILABLE|ACTIVE|ONLINE|IDLE)/.test(value)) return 'good'
  return 'stale'
}

function statusTone(status) {
  return `status-${statusKind(status)}`
}

function statusEmoji(status) {
  return { good: '🟢', bad: '🔴', stale: '🟡', active: '🔵' }[statusKind(status)]
}

function isStale(value, staleAfterMinutes) {
  if (!value || !staleAfterMinutes) return false
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) && Date.now() - timestamp > staleAfterMinutes * 60_000
}

function displayedStatus(status, updatedAt, staleAfterMinutes) {
  if (['bad', 'active'].includes(statusKind(status))) return status
  return isStale(updatedAt, staleAfterMinutes) ? 'STALE' : status
}

function jobDisplayedStatus(job) {
  if (!job) return 'UNKNOWN'
  if (['bad', 'active'].includes(statusKind(job.latest.status))) return job.latest.status
  return job.schedule.state === 'PAUSED' ? 'PAUSED' : job.latest.status
}

function duration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function ServiceRow({ name, status, detail, href, action, actionDisabled }) {
  return (
    <div className="service-row">
      <div className="service-copy">
        <div className="service-heading">
          <span className={`status-pill ${statusTone(status)}`}>
            <span aria-hidden="true">{statusEmoji(status)}</span> {compactState(status)}
          </span>
          <span>{name}</span>
        </div>
        {detail ? <div className="service-detail">{detail}</div> : null}
      </div>
      <div className="service-actions">
        {action ? (
          <button type="button" disabled={actionDisabled} onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
        {href ? <a href={href} target="_blank" rel="noreferrer">Open ↗</a> : null}
      </div>
    </div>
  )
}

function updateLiveShapes(editor, health, counts) {
  if (!editor || !health?.layers) return
  const live = health.layers
  const bronzeStatus = displayedStatus(live.bronze.lastRun, live.bronze.updatedAt, 45)
  const silverStatus = displayedStatus(live.silver.lastRun, live.silver.updatedAt, 45)
  const profileStatus = displayedStatus(
    live.gold.profilePipeline.lastRun,
    live.gold.profilePipeline.updatedAt,
    45,
  )
  const syncOldest = live.synced.tables.reduce((oldest, item) => {
    const timestamp = new Date(item.updatedAt).getTime()
    return Number.isFinite(timestamp) ? Math.min(oldest, timestamp) : oldest
  }, Number.POSITIVE_INFINITY)
  const syncStatus = displayedStatus(
    live.synced.online === live.synced.total ? 'ONLINE' : 'DEGRADED',
    Number.isFinite(syncOldest) ? syncOldest : null,
    45,
  )
  const updates = [
    [
      shapeIds.bronze,
      `${baseCopy[shapeIds.bronze]}\n\n${statusEmoji(bronzeStatus)} LIVE · ${compactState(bronzeStatus)}\n${live.bronze.inventory.count} governed objects · updated ${time(live.bronze.inventory.updatedAt)}\n${countsFor(counts, 'bronze', ['events_raw', 'ingestion_quarantine', 'public_sources_raw']).join('\n')}`,
    ],
    [
      shapeIds.silver,
      `${baseCopy[shapeIds.silver]}\n\n${statusEmoji(silverStatus)} LIVE · ${compactState(silverStatus)}\n${live.silver.inventory.count} governed objects · updated ${time(live.silver.inventory.updatedAt)}\n${countsFor(counts, 'silver', ['events', 'reading_sessions', 'highlights_current']).join('\n')}`,
    ],
    [
      shapeIds.extraction,
      `${baseCopy[shapeIds.extraction]}\n\n${statusEmoji(live.extraction.state)} LIVE · endpoint ${compactState(live.extraction.state)}\n${statusEmoji(live.extraction.jobState)} Job schedule ${compactState(live.extraction.jobState)}\n${countsFor(counts, 'silver', ['concept_extractions']).join('\n')}`,
    ],
    [
      shapeIds.gold,
      `${baseCopy[shapeIds.gold]}\n\n${statusEmoji(profileStatus)} LIVE · ${compactState(profileStatus)}\nProfiles ${compactState(live.gold.profilePipeline.state)} · frontier ${compactState(live.gold.frontierPipeline.state)}\n${live.gold.inventory.count} governed objects · updated ${time(live.gold.inventory.updatedAt)}\n${countsFor(counts, 'gold', ['reader_interest_profile', 'book_engagement', 'intellectual_frontier', 'recommendation_candidates']).join('\n')}`,
    ],
    [
      shapeIds.publicSources,
      `${baseCopy[shapeIds.publicSources]}\n\n${statusEmoji(live.publicSources.schedule)} LIVE · ${compactState(live.publicSources.schedule)}\n${countsFor(counts, 'silver', ['public_book_candidates', 'research_works']).join('\n')}`,
    ],
    [
      shapeIds.synced,
      `${baseCopy[shapeIds.synced]}\n\n${statusEmoji(syncStatus)} LIVE · ${compactState(syncStatus)} · ${live.synced.online}/${live.synced.total} online\n${live.synced.tables.map((item) => `${item.name}: ${compactState(item.state)}`).join('\n')}`,
    ],
    [
      shapeIds.lakebase,
      `${baseCopy[shapeIds.lakebase]}\n\n${statusEmoji(live.lakebase.state)} LIVE · ${compactState(live.lakebase.state)} · ${live.lakebase.capacity ?? 'capacity unknown'}`,
    ],
    [
      shapeIds.servingApp,
      `${baseCopy[shapeIds.servingApp]}\n\n${statusEmoji(live.servingApp.state)} LIVE · compute ${compactState(live.servingApp.state)}\nUpdated ${time(live.servingApp.updatedAt)}`,
    ],
    [
      shapeIds.warehouse,
      `${baseCopy[shapeIds.warehouse]}\n\n${statusEmoji(live.warehouse.state)} LIVE · ${compactState(live.warehouse.state)} · ${live.warehouse.size ?? 'size unknown'}\n${live.warehouse.serverless ? 'serverless compute' : 'classic compute'}`,
    ],
    [
      shapeIds.observatory,
      `${baseCopy[shapeIds.observatory]}\n\n${statusEmoji(live.observatory.state)} LIVE · compute ${compactState(live.observatory.state)}\nUpdated ${time(live.observatory.updatedAt)}`,
    ],
    [
      shapeIds.dashboard,
      `${baseCopy[shapeIds.dashboard]}\n\n${statusEmoji(live.dashboard.state)} LIVE · ${compactState(live.dashboard.state)}\n${live.dashboard.count} Marginalia dashboard resource${live.dashboard.count === 1 ? '' : 's'}`,
    ],
    [
      shapeIds.genie,
      `${baseCopy[shapeIds.genie]}\n\n${statusEmoji(live.genie.count > 0 ? 'AVAILABLE' : 'NOT FOUND')} LIVE · ${live.genie.count} Marginalia Genie space${live.genie.count === 1 ? '' : 's'}`,
    ],
    [
      shapeIds.unity,
      `Unity Catalog — access control, namespaces, lineage and governance across Bronze / Silver / Gold\n\n${statusEmoji(live.unity.tableCount > 0 ? 'AVAILABLE' : 'EMPTY')} LIVE · ${live.unity.schemaCount} project schemas · ${live.unity.tableCount} governed objects`,
    ],
    [
      shapeIds.librarian,
      `Librarian agent (Phase 8 workspace)\n\nRetrieval passages + Vector Search + MLflow Model Serving\n\n${statusEmoji(live.librarian.modelState)} LIVE · endpoint ${compactState(live.librarian.modelState)}\n${statusEmoji(live.librarian.jobSchedule)} Job schedule ${compactState(live.librarian.jobSchedule)} · ${live.librarian.vectorEndpointCount} vector endpoint${live.librarian.vectorEndpointCount === 1 ? '' : 's'}\n${countsFor(counts, 'silver', ['librarian_passages']).join('\n')}\n${countsFor(counts, 'ops', ['librarian_evaluations']).join('\n')}`,
    ],
  ]
  editor.run(
    () => {
      editor.updateShapes(
        updates
          .filter(([id]) => editor.getShape(id))
          .map(([id, copy]) => ({
            id,
            type: 'geo',
            props: {
              richText: toRichText(copy),
              size: 's',
              growY: 0,
              h: layoutV2[id]?.h,
              w: layoutV2[id]?.w,
            },
          })),
      )
    },
    { history: 'ignore' },
  )
}

function geo(id, x, y, w, h, text, color = 'grey', fill = 'semi', dash = 'solid') {
  return {
    id,
    type: 'geo',
    x,
    y,
    props: {
      w,
      h,
      geo: 'rectangle',
      color,
      fill,
      dash,
      size: 'm',
      font: 'sans',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(text),
    },
  }
}

function textShape(id, x, y, text, size = 'l', color = 'black', w = 900) {
  return {
    id,
    type: 'text',
    x,
    y,
    props: {
      richText: toRichText(text),
      color,
      size,
      font: 'sans',
      textAlign: 'start',
      autoSize: false,
      w,
    },
  }
}

function arrow(id, x1, y1, x2, y2, label = '', color = 'grey', dash = 'solid') {
  return {
    id: createShapeId(id),
    type: 'arrow',
    x: x1,
    y: y1,
    props: {
      start: { x: 0, y: 0 },
      end: { x: x2 - x1, y: y2 - y1 },
      bend: 0,
      color,
      dash,
      size: 'm',
      fill: 'none',
      arrowheadStart: 'none',
      arrowheadEnd: 'arrow',
      richText: toRichText(label),
    },
  }
}

function seedDiagram(editor) {
  const existing = editor.getCurrentPageShapes()
  if (existing.length > 0) {
    if (!editor.getShape(shapeIds.librarian)) {
      editor.createShape(
        geo(
          shapeIds.librarian,
          3090,
          2440,
          850,
          300,
          'Librarian agent (Phase 8 workspace)\n\nRetrieval passages + Vector Search + MLflow Model Serving',
          'violet',
          'semi',
        ),
      )
    }
    return
  }

  const shapes = [
    textShape(
      createShapeId('title'),
      80,
      30,
      'Marginalia on Databricks — PR #39 architecture and review',
      'xl',
      'black',
      1700,
    ),
    textShape(
      createShapeId('subtitle'),
      80,
      105,
      'The lakehouse computes governed intelligence; Lakebase and Apps serve only selected projections.',
      'm',
      'grey',
      1700,
    ),
    geo(shapeIds.bundles, 80, 205, 1250, 80, 'Declarative Automation Bundles — source-controlled deployment of jobs, pipelines, apps and BI resources', 'grey', 'none', 'dashed'),
    geo(shapeIds.unity, 1410, 205, 1250, 80, 'Unity Catalog — access control, namespaces, lineage and governance across Bronze / Silver / Gold', 'grey', 'none', 'dashed'),
    textShape(createShapeId('ingestion-label'), 80, 315, 'INGESTION AND INTELLIGENCE', 'm', 'grey', 700),
    ...nodes.map((node) => geo(node.id, node.x, node.y, node.w, node.h, node.text, node.color)),
    textShape(createShapeId('serving-label'), 1570, 795, 'LOW-LATENCY SERVING LOOP', 'm', 'grey', 700),
    textShape(createShapeId('analysis-label'), 1880, 1215, 'READER ANALYSIS SURFACES', 'm', 'grey', 700),

    arrow('browser-worker', 350, 455, 450, 455, 'consented batch'),
    arrow('worker-kafka', 720, 455, 820, 455, 'produce'),
    arrow('kafka-bronze', 1070, 455, 1190, 455, '15-min trigger'),
    arrow('bronze-silver', 1450, 455, 1570, 455),
    arrow('silver-extraction', 1840, 455, 1960, 455),
    arrow('extraction-gold', 2260, 455, 2380, 455),
    arrow('gold-public', 2380, 530, 2260, 700, 'interests decide queries'),
    arrow('public-gold', 2260, 790, 2460, 530, 'frontier + candidates'),
    arrow('gold-synced', 2520, 530, 2520, 870, 'snapshot sync', 'green'),
    arrow('synced-lakebase', 2380, 945, 2260, 945),
    arrow('lakebase-serving', 1960, 945, 1840, 945),
    arrow('serving-worker', 1570, 945, 590, 530, 'same-origin API response', 'blue'),
    arrow('gold-warehouse', 2520, 530, 2520, 1290, 'analytical query path', 'light-blue', 'dashed'),
    arrow('warehouse-observatory', 2450, 1430, 2070, 1540),
    arrow('warehouse-dashboard', 2520, 1430, 2390, 1540),
    arrow('warehouse-genie', 2590, 1430, 2770, 1540),

    textShape(createShapeId('alternatives-title'), 3090, 205, 'ALTERNATIVES BY LAYER', 'l', 'black', 850),
    ...alternatives.map(([service, options], index) =>
      geo(
        createShapeId(`alternative-${index}`),
        3090,
        290 + index * 145,
        850,
        110,
        `${service}\n${options}`,
        'grey',
        'none',
        'dashed',
      ),
    ),

    textShape(createShapeId('review-title'), 80, 1830, 'LATEST OPEN PR REVIEW', 'l', 'red', 900),
    geo(
      createShapeId('review-findings'),
      80,
      1910,
      2820,
      430,
      findings.map((item, index) => `${index === 0 ? '' : '• '}${item}`).join('\n\n'),
      'red',
      'semi',
      'solid',
    ),
    textShape(
      createShapeId('interview-takeaway'),
      3090,
      1530,
      'INTERVIEW TAKEAWAY',
      'l',
      'black',
      850,
    ),
    geo(
      createShapeId('takeaway'),
      3090,
      1610,
      850,
      380,
      'Explain why analytical storage and operational serving are different workloads.\n\nThen explain how Unity Catalog grants and separate App service principals turn privacy promises into enforced boundaries.\n\nFinally, name the trade-off: snapshot sync is simpler and valid for materialized views, but it adds staleness and recopies data.',
      'blue',
      'semi',
    ),
    geo(
      createShapeId('open-risk'),
      3090,
      2070,
      850,
      270,
      'OPEN DESIGN RISKS\n\nPublic-source writes are not atomic. Provider pagination is absent. Genie and Dashboard isolation is deployment-specific, not yet per reader.',
      'orange',
      'semi',
    ),
    geo(
      shapeIds.librarian,
      3090,
      2440,
      850,
      300,
      'Librarian agent (Phase 8 workspace)\n\nRetrieval passages + Vector Search + MLflow Model Serving',
      'violet',
      'semi',
    ),
  ]

  editor.createShapes(shapes)
  editor.zoomToBounds({ x: 0, y: 0, w: 4050, h: 2820 }, { targetZoom: 0.26 })
}

export default function App() {
  const editorRef = useRef(null)
  const [health, setHealth] = useState(null)
  const [counts, setCounts] = useState(null)
  const [message, setMessage] = useState('Connecting to the Databricks workspace…')
  const [loadingCounts, setLoadingCounts] = useState(false)
  const [runningAction, setRunningAction] = useState(null)
  const [controlCenterOpen, setControlCenterOpen] = useState(true)

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' })
      if (!response.ok) throw new Error(`Health refresh failed (${response.status})`)
      const next = await response.json()
      setHealth(next)
      setMessage(
        next.errors.length
          ? `Updated with ${next.errors.length} unavailable source${next.errors.length === 1 ? '' : 's'}`
          : `Live metadata updated ${time(next.observedAt)}`,
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Health refresh failed')
    }
  }, [])

  const loadCounts = useCallback(async () => {
    setLoadingCounts(true)
    setMessage('Starting or using the SQL Warehouse to count selected tables…')
    try {
      const response = await fetch('/api/counts', { method: 'POST' })
      const next = await response.json()
      if (!response.ok) throw new Error(next.error ?? `Count query failed (${response.status})`)
      setCounts(next)
      setMessage(`Row counts updated ${time(next.observedAt)}`)
      await refreshHealth()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Count query failed')
    } finally {
      setLoadingCounts(false)
    }
  }, [refreshHealth])

  const triggerJob = useCallback(async (key) => {
    const job = health?.jobs?.[key]
    if (!job) return
    const confirmed = window.confirm(
      `${job.label}\n\n${job.warning}\n\nThis can start billable Databricks compute. Start it now?`,
    )
    if (!confirmed) return

    setRunningAction(key)
    setMessage(`Requesting ${job.label.toLowerCase()}…`)
    try {
      const response = await fetch('/api/actions/run-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job: key, confirmed: true }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? `Job request failed (${response.status})`)
      setMessage(result.message)
      await refreshHealth()
      window.setTimeout(() => void refreshHealth(), 2500)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Job request failed')
    } finally {
      setRunningAction(null)
    }
  }, [health, refreshHealth])

  useEffect(() => {
    void refreshHealth()
    const timer = window.setInterval(() => void refreshHealth(), 30_000)
    return () => window.clearInterval(timer)
  }, [refreshHealth])

  useEffect(() => {
    updateLiveShapes(editorRef.current, health, counts)
  }, [health, counts])

  const handleMount = useCallback((editor) => {
    editorRef.current = editor
    seedDiagram(editor)
    applyLayoutV2(editor)
    updateLiveShapes(editor, health, counts)
  }, [health, counts])

  const links = health?.links ?? {}
  const jobs = health?.jobs ?? {}
  const layers = health?.layers
  const jobRows = Object.values(jobs)
  const syncedOldest = layers?.synced.tables.reduce((oldest, item) => {
    const timestamp = new Date(item.updatedAt).getTime()
    return Number.isFinite(timestamp) ? Math.min(oldest, timestamp) : oldest
  }, Number.POSITIVE_INFINITY)
  const serviceRows = layers ? [
    {
      name: 'Observatory App',
      status: layers.observatory.state,
      detail: `Reader-facing intelligence · updated ${time(layers.observatory.updatedAt)}`,
      href: layers.observatory.url,
    },
    {
      name: 'AI/BI Dashboard',
      status: layers.dashboard.state,
      detail: `${layers.dashboard.count} Marginalia dashboard · ${layers.dashboard.scoped ? 'scoped data' : 'wrong dataset scope'} · ${layers.dashboard.fullyQualified ? 'qualified SQL' : 'unqualified SQL'} · ${layers.dashboard.published ? `published ${time(layers.dashboard.publishedAt)}` : 'not published'}`,
      href: layers.dashboard.url,
    },
    {
      name: 'Genie',
      status: layers.genie.count > 0 ? 'AVAILABLE' : 'NOT FOUND',
      detail: `${layers.genie.count} Marginalia space`,
      href: layers.genie.url,
    },
    {
      name: 'Serving App',
      status: layers.servingApp.state,
      detail: `Product API · updated ${time(layers.servingApp.updatedAt)}`,
      href: layers.servingApp.url,
    },
    {
      name: 'Unity Catalog',
      status: layers.unity.tableCount > 0 ? 'AVAILABLE' : 'EMPTY',
      detail: `${layers.unity.schemaCount} schemas · ${layers.unity.tableCount} governed objects`,
      href: links.catalog,
    },
    {
      name: 'SQL Warehouse',
      status: layers.warehouse.state,
      detail: `${layers.warehouse.size ?? 'Unknown size'} · ${layers.warehouse.serverless ? 'serverless' : 'classic'}`,
      href: links.warehouse,
    },
    {
      name: 'Synced tables',
      status: displayedStatus(
        layers.synced.online === layers.synced.total ? 'ONLINE' : 'DEGRADED',
        Number.isFinite(syncedOldest) ? syncedOldest : null,
        45,
      ),
      detail: `${layers.synced.online}/${layers.synced.total} online · oldest sync ${time(Number.isFinite(syncedOldest) ? syncedOldest : null)}`,
      href: links.servingCatalog,
    },
    {
      name: 'Lakebase',
      status: layers.lakebase.state,
      detail: layers.lakebase.capacity ?? 'Capacity unknown',
      href: links.servingCatalog,
    },
    {
      name: 'Librarian model endpoint',
      status: layers.librarian.modelState,
      detail: `${layers.librarian.vectorEndpointCount} Vector Search endpoint${layers.librarian.vectorEndpointCount === 1 ? '' : 's'}`,
      href: links.librarianModel,
    },
    {
      name: 'Concept model endpoint',
      status: layers.extraction.state,
      detail: layers.extraction.model,
      href: links.conceptModel,
    },
    {
      name: 'Bronze ingestion pipeline',
      status: displayedStatus(layers.bronze.lastRun, layers.bronze.updatedAt, 45),
      detail: `Last run ${compactState(layers.bronze.lastRun)} · updated ${time(layers.bronze.updatedAt)}`,
      href: links.bronzePipeline,
    },
    {
      name: 'Silver pipeline',
      status: displayedStatus(layers.silver.lastRun, layers.silver.updatedAt, 45),
      detail: `Last run ${compactState(layers.silver.lastRun)} · updated ${time(layers.silver.updatedAt)}`,
      href: links.silverPipeline,
    },
    {
      name: 'Gold profiles pipeline',
      status: displayedStatus(
        layers.gold.profilePipeline.lastRun,
        layers.gold.profilePipeline.updatedAt,
        45,
      ),
      detail: `Last run ${compactState(layers.gold.profilePipeline.lastRun)} · updated ${time(layers.gold.profilePipeline.updatedAt)}`,
      href: links.goldPipeline,
    },
    {
      name: 'Frontier pipeline',
      status: displayedStatus(
        layers.gold.frontierPipeline.lastRun,
        layers.gold.frontierPipeline.updatedAt,
        45,
      ),
      detail: `Last run ${compactState(layers.gold.frontierPipeline.lastRun)} · updated ${time(layers.gold.frontierPipeline.updatedAt)}`,
      href: links.frontierPipeline,
    },
  ] : []
  const quickLinks = layers ? [
    { label: 'Observatory', href: layers.observatory.url, status: layers.observatory.state },
    { label: 'Dashboard', href: layers.dashboard.url, status: layers.dashboard.state },
    { label: 'Genie', href: layers.genie.url, status: layers.genie.count > 0 ? 'AVAILABLE' : 'NOT FOUND' },
    { label: 'Intelligence job', href: jobs.intelligence?.latest.url, status: jobDisplayedStatus(jobs.intelligence) },
    { label: 'Librarian job', href: jobs.librarian?.latest.url, status: jobDisplayedStatus(jobs.librarian) },
    { label: 'Unity Catalog', href: links.catalog, status: layers.unity.tableCount > 0 ? 'AVAILABLE' : 'EMPTY' },
  ].filter((item) => item.href) : []

  return (
    <main className="diagram-shell">
      <Tldraw persistenceKey="marginalia-databricks-services-v1" onMount={handleMount} />
      <aside className={`live-controls ${controlCenterOpen ? '' : 'is-collapsed'}`}>
        <div className="live-title">
          <div className="live-title-copy">
            <span className="live-dot" aria-hidden="true" />
            Databricks control center
          </div>
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={controlCenterOpen}
            onClick={() => setControlCenterOpen((current) => !current)}
          >
            {controlCenterOpen ? 'Collapse' : 'Open'}
          </button>
        </div>
        {controlCenterOpen ? (
          <div className="control-body">
            <div className="live-message" aria-live="polite">{message}</div>
            <div className="status-legend" aria-label="Status legend">
              <span>🟢 Healthy</span>
              <span>🔵 Running</span>
              <span>🟡 Stale or paused</span>
              <span>🔴 Failed or offline</span>
            </div>
            <nav className="quick-links" aria-label="Frequently used Databricks destinations">
              {quickLinks.map((item) => (
                <a key={item.label} href={item.href} target="_blank" rel="noreferrer">
                  <span aria-hidden="true">{statusEmoji(item.status)}</span> {item.label} ↗
                </a>
              ))}
            </nav>
            <div className="live-actions">
              <button type="button" onClick={() => void refreshHealth()}>Refresh status</button>
              <button type="button" disabled={loadingCounts} onClick={() => void loadCounts()}>
                {loadingCounts ? 'Loading counts…' : 'Load row counts'}
              </button>
            </div>

            <section className="control-section" aria-labelledby="jobs-heading">
              <h2 id="jobs-heading">Runnable jobs</h2>
              {jobRows.map((job) => {
                const schedule = job.schedule.state === 'PAUSED'
                  ? `Schedule paused · ${job.schedule.label}`
                  : `${job.schedule.label} · next ${time(job.schedule.nextRun)}`
                const runDetail = job.latest.startedAt
                  ? `Last started ${time(job.latest.startedAt)}${duration(job.latest.durationMs) ? ` · ${duration(job.latest.durationMs)}` : ''}`
                  : 'No runs found'
                return (
                  <ServiceRow
                    key={job.key}
                    name={job.label}
                    status={jobDisplayedStatus(job)}
                    detail={`${schedule}. Last run ${compactState(job.latest.status)}. ${runDetail}.`}
                    href={job.latest.url}
                    action={{ label: job.latest.active ? 'Running' : 'Run now', onClick: () => void triggerJob(job.key) }}
                    actionDisabled={job.latest.active || runningAction !== null}
                  />
                )
              })}
            </section>

            <section className="control-section" aria-labelledby="services-heading">
              <h2 id="services-heading">Services</h2>
              {serviceRows.map((service) => <ServiceRow key={service.name} {...service} />)}
            </section>

            <div className="live-warning">
              Status refresh is metadata-only. Running jobs and loading row counts can start billable compute.
              Destructive deletion jobs and stop controls are intentionally unavailable here.
            </div>
          </div>
        ) : null}
      </aside>
    </main>
  )
}
