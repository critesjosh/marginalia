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
  if (editor.getCurrentPageShapes().length > 0) return

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
  ]

  editor.createShapes(shapes)
  editor.zoomToBounds({ x: 0, y: 0, w: 4050, h: 2440 }, { targetZoom: 0.28 })
}

export default function App() {
  return (
    <main className="diagram-shell">
      <Tldraw persistenceKey="marginalia-databricks-services-v1" onMount={seedDiagram} />
    </main>
  )
}
