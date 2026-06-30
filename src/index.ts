import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { execFileSync } from 'child_process'

const SCRIPTS_DIR = process.env.SCRIPTS_DIR ?? '/home/claude/soapbox-agent/scripts'

function runScript(script: string, inputJson: unknown): unknown {
  // Use execFileSync with argument array — no shell interpolation, no injection risk
  const out = execFileSync(
    'python3',
    [`${SCRIPTS_DIR}/${script}`, '--inputs', JSON.stringify(inputJson)],
    { timeout: 30000, encoding: 'utf-8' }
  )
  return JSON.parse(out)
}

const server = new McpServer({ name: 'soapbox-cashflow', version: '1.0.0' })

server.tool(
  'run_dcf',
  'Run a real estate DCF (discounted cash flow) model for an asset. Returns year-by-year NOI, exit value, unlevered IRR, and equity multiple. Supports multifamily, office, industrial, retail, and hotel.',
  {
    asset_type: z.enum(['multifamily', 'office', 'industrial', 'retail', 'hotel']).describe('Property type'),
    hold_period_years: z.number().int().min(1).max(30).describe('Hold period in years'),
    exit_cap_rate: z.number().min(0.01).max(0.20).describe('Exit cap rate (e.g. 0.05 for 5%)'),
    going_in_noi: z.number().describe('Year-1 net operating income ($)'),
    noi_growth_rate: z.number().default(0.02).optional().describe('Annual NOI growth rate (default 2%)'),
    discount_rate: z.number().default(0.08).optional().describe('Discount rate for NPV (default 8%)'),
    sale_costs_pct: z.number().default(0.015).optional().describe('Sale transaction costs as % of exit value (default 1.5%)'),
  },
  async (inputs) => {
    try {
      const result = runScript('dcf_engine.py', inputs)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
    }
  }
)

server.tool(
  'run_intervention_irr',
  'Compute the IRR and value creation impact of a single decarbonization or capex measure layered onto a base DCF model. Use this after run_dcf to screen each measure. Returns IRR, payback, NOI delta, exit value delta, and yield on cost.',
  {
    base_model: z.object({
      going_in_noi: z.number(),
      exit_value: z.number(),
      hold_period_years: z.number(),
      exit_cap_rate: z.number(),
      unlevered_irr: z.number(),
      annual: z.array(z.record(z.unknown())),
    }).describe('Base DCF model from run_dcf'),
    intervention_type: z.enum(['solar', 'ev_charging', 'smart_hvac', 'ppa', 'utility_reduction', 'unit_renovation', 'amenity_upgrade', 'tech_package']).describe('Type of measure'),
    capex: z.number().optional().describe('Capital cost ($) — not needed for PPA'),
    annual_savings: z.number().optional().describe('Annual energy/utility savings ($ in year 1)'),
    annual_revenue: z.number().optional().describe('Annual revenue (for EV charging)'),
    utility_escalation: z.number().default(0.03).optional().describe('Annual utility cost escalation (default 3%)'),
    start_year: z.number().int().min(1).default(1).optional().describe('Year measure becomes operational (1 = immediately)'),
    ll_capture_pct: z.number().min(0).max(1).default(1.0).optional().describe('Fraction of savings captured by landlord (from ll_allocation tool). Default 1.0 = full capture.'),
    market_cap_rate: z.number().optional().describe('Market cap rate for yield-on-cost calc (defaults to exit_cap_rate)'),
  },
  async (inputs) => {
    try {
      // Apply LL capture to savings before passing to engine
      const adjustedInputs = {
        ...inputs,
        annual_savings: inputs.annual_savings ? inputs.annual_savings * (inputs.ll_capture_pct ?? 1.0) : undefined,
        annual_revenue: inputs.annual_revenue,
      }
      const result = runScript('intervention_engine.py', { base: inputs.base_model, intervention: adjustedInputs, market_cap_rate: inputs.market_cap_rate ?? inputs.base_model.exit_cap_rate })
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
    }
  }
)

server.tool(
  'get_ll_capture',
  'Determine what fraction of energy savings flows to the landlord (LL) vs tenant (TT) for a given measure, based on lease structure, metering configuration, and BPS jurisdiction. Essential input for IRR calculation — use before run_intervention_irr.',
  {
    lease_structure: z.enum(['gross', 'nnn', 'modified_gross', 'rubs', 'green_lease']).describe('Lease type'),
    metering_config: z.enum(['master', 'individual', 'submeter_passthrough']).describe('How utilities are metered'),
    jurisdiction: z.string().describe('City/jurisdiction (NYC, Boston, DC, Vancouver, Denver, Seattle, Chicago, or other)'),
    measure_type: z.string().describe('Category of measure (e.g. in_unit_hvac, common_area_lighting, solar, envelope, ev_charging)'),
    bps_liable: z.boolean().default(false).optional().describe('Is this property subject to a Building Performance Standard fine?'),
  },
  async (inputs) => {
    try {
      const result = runScript('ll_allocation.py', inputs)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
    }
  }
)

server.tool(
  'screen_measure_portfolio',
  'Screen a single decarbonization measure across multiple assets at once. For each asset, runs LL allocation + IRR calculation and returns pass/fail against the hurdle rate. Use to batch-screen one measure type (e.g. LED) across the full portfolio.',
  {
    measure_type: z.string().describe('Measure category (e.g. common_area_lighting, in_unit_hvac, solar)'),
    intervention_type: z.enum(['solar', 'ev_charging', 'smart_hvac', 'ppa', 'utility_reduction', 'unit_renovation', 'amenity_upgrade', 'tech_package']),
    irr_hurdle: z.number().default(0.15).describe('IRR hurdle rate (e.g. 0.15 for 15%)'),
    utility_escalation: z.number().default(0.03),
    assets: z.array(z.object({
      asset_id: z.string(),
      asset_name: z.string(),
      going_in_noi: z.number(),
      exit_year: z.number().int(),
      exit_cap_rate: z.number(),
      lease_structure: z.enum(['gross', 'nnn', 'modified_gross', 'rubs', 'green_lease']),
      metering_config: z.enum(['master', 'individual', 'submeter_passthrough']),
      jurisdiction: z.string(),
      bps_liable: z.boolean().default(false),
      capex: z.number(),
      annual_savings: z.number(),
      start_year: z.number().int().default(1),
    })).describe('Array of assets to screen'),
  },
  async ({ measure_type, intervention_type, irr_hurdle, utility_escalation, assets }) => {
    const currentYear = new Date().getFullYear()
    const results = []
    for (const a of assets) {
      try {
        const holdYears = Math.max(1, a.exit_year - currentYear)
        const base = runScript('dcf_engine.py', {
          asset_type: 'multifamily',
          hold_period_years: holdYears,
          exit_cap_rate: a.exit_cap_rate,
          going_in_noi: a.going_in_noi,
        }) as any

        const ll = runScript('ll_allocation.py', {
          lease_structure: a.lease_structure,
          metering_config: a.metering_config,
          jurisdiction: a.jurisdiction,
          measure_type,
          bps_liable: a.bps_liable,
        }) as any

        const llPct = ll.ll_capture_pct ?? 1.0
        const intervention = runScript('intervention_engine.py', {
          base, intervention: {
            intervention_type,
            capex: a.capex,
            annual_savings: a.annual_savings * llPct,
            utility_escalation,
            start_year: a.start_year,
          }, market_cap_rate: a.exit_cap_rate,
        }) as any

        const irr = intervention.irr_delta_vs_base ?? intervention.irr ?? 0
        results.push({
          asset_id: a.asset_id,
          asset_name: a.asset_name,
          hold_years: holdYears,
          ll_capture_pct: llPct,
          capex: a.capex,
          annual_savings_ll: a.annual_savings * llPct,
          irr: irr,
          passes_hurdle: irr >= irr_hurdle,
          payback_years: intervention.payback_years,
          exit_value_delta: intervention.exit_value_delta,
          ll_warnings: ll.warnings ?? [],
        })
      } catch (e: any) {
        results.push({ asset_id: a.asset_id, asset_name: a.asset_name, error: e.message })
      }
    }
    const passed = results.filter(r => r.passes_hurdle).length
    return { content: [{ type: 'text' as const, text: JSON.stringify({ summary: { total: assets.length, passed, failed: assets.length - passed }, results }, null, 2) }] }
  }
)

const app = express()
app.use(express.json())
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'soapbox-cashflow-mcp' }))

app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

const port = process.env.PORT ?? 3000
app.listen(port, () => console.log(`soapbox-cashflow-mcp listening on :${port}`))
