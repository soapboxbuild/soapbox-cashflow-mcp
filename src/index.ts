import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { execFileSync } from 'child_process'
import { computePlanEconomics, computePortfolioTrajectory } from './economics.js'

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

// A StreamableHTTP server in stateless mode (sessionIdGenerator: undefined) can only connect a
// given server instance to ONE transport. Reusing a single shared server across requests threw
// "Already connected to a transport" on the 2nd request (→ 502). Build a fresh server + transport
// per request instead (the SDK's stateless pattern).
function createServer() {
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

  // ── Deterministic decarb plan value-bridge + incremental IRR (native TS, no python) ──
  // The report engine for decarbonization plans. Supply per-year OWNER-SHARE line items
  // (which trace to Audette measures); this returns the full derived money-math so the
  // LLM never hand-computes IRR, capitalization, PV, or the cashflow schedule. Calibrated
  // against verified reports (see economics.test.ts).
  server.tool(
    'compute_plan_economics',
    'Compute a decarbonization plan\'s value bridge and incremental IRR deterministically from per-year owner-share cash flows. Use this for EVERY decarb plan instead of hand-computing IRR / capitalization / PV. Returns the full cashflow schedule (noi_impact, unlevered, cumulative, terminal exit-value delta), the value-creation waterfall (capitalized owner savings/ancillary/fine-avoidance ÷ exit cap = exit_value_uplift, and net_value_creation = exit_value_uplift − capex + incentives), plus TWO IRRs: irr_excl_exit (operating cashflows only, NO exit residual — the pays-for-itself screen) and irr_incremental (value-inclusive, with the exit residual folded in). Supply only auditable inputs; do not pre-compute any derived field.',
    {
      flows: z.array(z.object({
        year: z.number().int(),
        incremental_capex: z.number().default(0).optional().describe('Incremental capex over like-for-like ($), this year'),
        owner_utility_savings: z.number().default(0).optional().describe('Owner-share utility $ savings this year (already capture-applied). Prefer the gross_*+*_capture fields below so the engine applies the landlord share itself.'),
        gross_elec_savings: z.number().optional().describe('GROSS (pre-capture) electricity $ savings this year, efficiency measures. Use Audette utility_cost_savings, NOT landlord_utility_cost_savings (which is uncaptured = gross).'),
        gross_gas_savings: z.number().optional().describe('GROSS (pre-capture) gas $ savings this year, efficiency measures.'),
        gross_solar_savings: z.number().optional().describe('GROSS (pre-capture) solar/PV $ savings this year (BTM/VNM).'),
        elec_capture: z.number().min(0).max(1).optional().describe('Owner landlord share for electricity efficiency savings (0-1), e.g. 0.10.'),
        gas_capture: z.number().min(0).max(1).optional().describe('Owner landlord share for gas efficiency savings (0-1).'),
        solar_capture: z.number().min(0).max(1).optional().describe('Owner share of solar savings; 0.80 where BTM/VNM export is permitted (LL owns array + allocates credit), else the displaced-load share. Defaults to 0.80 if solar savings given without a capture.'),
        ancillary_revenue: z.number().default(0).optional().describe('Ancillary owner revenue this year (sub-metering/billing, EV, DR) — LL keeps 100% regardless of utility split.'),
        incentives: z.number().default(0).optional().describe('Incentives received this year ($)'),
        bps_fine_avoidance: z.number().default(0).optional().describe('BPS fine avoided this year ($) — only if the plan is non-compliant on the governing pathway'),
      })).min(1).describe('Per-year owner-share cash flows for the plan (already reflecting the owner/tenant split and any escalation)'),
      exit_cap_rate: z.number().min(0.01).max(0.20).describe('Exit cap rate (e.g. 0.0515)'),
      exit_year: z.number().int().describe('Hold exit year (terminal exit-value delta is booked here)'),
      discount_rate: z.number().min(0).max(0.5).default(0.08).optional().describe('Discount rate for PV of the fine schedule (default 0.08)'),
    },
    async (inputs) => {
      try {
        const result = computePlanEconomics(inputs as any)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  // ── Portfolio-scale economics: run compute_plan_economics for EVERY asset in ONE call ──
  // Purpose-built for portfolio-analysis: the agent supplies only per-asset INPUTS (the same
  // auditable per-year flows compute_plan_economics takes); this tool runs the deterministic engine
  // for each asset server-side, aggregates the portfolio rollups, and stamps engine provenance.
  // The agent never computes IRR/value itself — so hand-rolled/"Python replica" economics are
  // impossible — and one MCP call replaces ~39 per-asset round-trips (no requires_action churn).
  // Factory (NOT a shared const): each call returns a fresh, fully independent zod
  // object tree. Reusing a single shared schema object in more than one place makes
  // the JSON-Schema serializer emit a `$ref`, which Anthropic's custom-tool
  // input_schema REJECTS ("input_schema contains $ref, which is not supported") —
  // that 500s every run loading this MCP. `flows` and `measures[].flows` therefore
  // each get their own inlined copy via a separate makeFlowYear() call.
  const makeFlowYear = () => z.object({
    year: z.number().int(),
    incremental_capex: z.number().optional(),
    owner_utility_savings: z.number().optional(),
    gross_elec_savings: z.number().optional(),
    gross_gas_savings: z.number().optional(),
    gross_solar_savings: z.number().optional(),
    elec_capture: z.number().min(0).max(1).optional(),
    gas_capture: z.number().min(0).max(1).optional(),
    solar_capture: z.number().min(0).max(1).optional(),
    ancillary_revenue: z.number().optional(),
    incentives: z.number().optional(),
    bps_fine_avoidance: z.number().optional(),
  })
  server.tool(
    'compute_portfolio_economics',
    'Run compute_plan_economics for EVERY asset in a portfolio in ONE call and return per-asset economics + portfolio aggregates + an engine provenance stamp. Use this for the portfolio-analysis economics instead of calling compute_plan_economics per asset or hand-computing/aggregating IRR & value in code — you supply only auditable per-year owner-share flows per asset; the deterministic engine does all the money-math. Returns { provenance, portfolio:{assets_above_hurdle,total_value_creation,total_incremental_capex,...}, assets:[{asset_name,fund,irr_excl_exit,irr_incremental,net_value_creation,exit_value_uplift,above_hurdle,waterfall}] }. Report these values verbatim; never recompute them.',
    {
      irr_hurdle: z.number().min(0).max(1).default(0.15).describe('IRR hurdle for the above_hurdle flag (default 0.15). Uses irr_incremental.'),
      d_exit_year: z.number().int().default(2040).optional().describe('Hold horizon for the Scenario D (next-owner) screen (default 2040).'),
      assets: z.array(z.object({
        asset_id: z.string().optional().describe('Soapbox asset UUID (echoed back for joining).'),
        asset_name: z.string().describe('Asset name for the rollup rows.'),
        fund: z.string().optional().describe('Fund name for fund-level aggregation.'),
        flows: z.array(makeFlowYear()).min(1).optional().describe('LEGACY / economics-only: per-year owner-share flows for this asset. Prefer `measures` (below) — when `measures` is present it is the SOLE source and `flows` is ignored, so trajectory and headline economics cannot diverge.'),
        measures: z.array(z.object({
          install_year: z.number().int(),
          annual_tco2e_reduction: z.number().default(0),
          is_solar: z.boolean().optional().describe('Force-included in Scenario C (max solar).'),
          compliance_required: z.boolean().optional().describe('Force-included in ALL scenarios (regulatory).'),
          flows: z.array(makeFlowYear()).min(1).describe('This measure’s own per-year owner-share flows (same shape as compute_plan_economics).'),
        })).optional().describe('Per-MEASURE flows. Enables the deterministic A/B/C/D emissions scenarios AND is summed to the asset-level economics (single source of truth). Screened per measure: A=irr_excl_exit≥hurdle, B=+irr_incremental≥hurdle, C=+all solar, D=+screen re-run at d_exit_year.'),
        exit_cap_rate: z.number().min(0.01).max(0.20),
        exit_year: z.number().int(),
        discount_rate: z.number().min(0).max(0.5).default(0.08).optional(),
        // ── Optional carbon inputs for the emissions trajectory + CRREM overlay ──
        gfa_m2: z.number().positive().optional().describe('Gross floor area (m²) — GFA-weighting for portfolio curves.'),
        baseline_intensity_2025: z.number().optional().describe('Baseline carbon intensity kgCO₂e/m² at year_start.'),
        scope2_fraction: z.number().min(0).max(1).optional().describe('Electricity (Scope-2) share of baseline emissions; only this share decays with the grid under BAU.'),
        grid_ef_annual: z.array(z.object({ year: z.number().int(), factor: z.number() })).optional().describe('Electricity emission factor by year (from crrem get_emission_factors). Normalised to year_start internally — supply the real series, do not pre-normalise.'),
        crrem_annual: z.array(z.object({ year: z.number().int(), target: z.number() })).optional().describe('This asset’s CRREM 1.5°C pathway kgCO₂e/m² by year, VERBATIM from crrem get_pathway allYears. GFA-weighted into the portfolio crrem_target — never hand-blend.'),
      })).min(1).max(500).describe('Every analysis-ready asset with its assembled flows (or per-measure flows + carbon inputs for the trajectory).'),
    },
    async ({ irr_hurdle, d_exit_year, assets }) => {
      try {
        const hurdle = irr_hurdle ?? 0.15
        // Single source of truth: when per-measure flows exist, the asset-level economics
        // are computed from the SUM of the same measure flows (owner-share resolved per
        // measure, then summed), so the headline value can't drift from the trajectory.
        const ownerFlowsFromMeasures = (measures: any[]): any[] => {
          const byYear = new Map<number, any>()
          for (const m of measures) for (const f of (m.flows ?? [])) {
            const owner = f.owner_utility_savings != null ? Number(f.owner_utility_savings)
              : (Number(f.gross_elec_savings ?? 0) * Number(f.elec_capture ?? 0)
                + Number(f.gross_gas_savings ?? 0) * Number(f.gas_capture ?? 0)
                + Number(f.gross_solar_savings ?? 0) * Number(f.solar_capture ?? 0))
            const cur = byYear.get(f.year) ?? { year: f.year, incremental_capex: 0, owner_utility_savings: 0, ancillary_revenue: 0, incentives: 0, bps_fine_avoidance: 0 }
            cur.incremental_capex += Number(f.incremental_capex ?? 0)
            cur.owner_utility_savings += owner
            cur.ancillary_revenue += Number(f.ancillary_revenue ?? 0)
            cur.incentives += Number(f.incentives ?? 0)
            cur.bps_fine_avoidance += Number(f.bps_fine_avoidance ?? 0)
            byYear.set(f.year, cur)
          }
          return Array.from(byYear.values()).sort((x, y) => x.year - y.year)
        }
        const per = assets.map((a) => {
          try {
            const flows = (a.measures && a.measures.length) ? ownerFlowsFromMeasures(a.measures) : (a.flows as any)
            if (!flows || !flows.length) throw new Error('asset has neither measures nor flows')
            const r = computePlanEconomics({ flows: flows as any, exit_cap_rate: a.exit_cap_rate, exit_year: a.exit_year, discount_rate: a.discount_rate })
            return {
              asset_name: a.asset_name,
              asset_id: a.asset_id ?? null,
              fund: a.fund ?? null,
              irr_excl_exit: r.irr_excl_exit,
              irr_incremental: r.irr_incremental,
              net_value_creation: r.waterfall.net_value_creation,
              exit_value_uplift: r.waterfall.exit_value_uplift,
              incremental_capex: -r.waterfall.incremental_capex,
              above_hurdle: r.irr_incremental != null && r.irr_incremental >= hurdle,
              waterfall: r.waterfall,
            }
          } catch (e: any) {
            return { asset_name: a.asset_name, asset_id: a.asset_id ?? null, fund: a.fund ?? null, error: e.message }
          }
        })
        const ok = per.filter((p: any) => !p.error)
        const round = (n: number) => Math.round(n)
        const total_value_creation = round(ok.reduce((s, p: any) => s + (p.net_value_creation ?? 0), 0))
        const total_incremental_capex = round(ok.reduce((s, p: any) => s + (p.incremental_capex ?? 0), 0))
        const assets_above_hurdle = ok.filter((p: any) => p.above_hurdle).length
        // Fund-level rollup
        const funds: Record<string, { value_creation: number; incremental_capex: number; assets: number; above_hurdle: number }> = {}
        for (const p of ok as any[]) {
          const k = p.fund ?? 'Unassigned'
          funds[k] ??= { value_creation: 0, incremental_capex: 0, assets: 0, above_hurdle: 0 }
          funds[k].value_creation += p.net_value_creation ?? 0
          funds[k].incremental_capex += p.incremental_capex ?? 0
          funds[k].assets += 1
          funds[k].above_hurdle += p.above_hurdle ? 1 : 0
        }
        Object.values(funds).forEach((f) => { f.value_creation = round(f.value_creation); f.incremental_capex = round(f.incremental_capex) })
        // Deterministic emissions trajectory + GFA-weighted CRREM overlay — computed only when
        // the carbon inputs are supplied; the agent copies these arrays verbatim (no hand-blending).
        let trajectory: any = null
        const anyCarbon = assets.some((a) => a.crrem_annual || a.measures || a.baseline_intensity_2025 != null)
        if (anyCarbon) {
          try {
            trajectory = computePortfolioTrajectory({
              irr_hurdle: hurdle,
              d_exit_year,
              assets: assets.map((a) => ({
                asset_name: a.asset_name,
                gfa_m2: a.gfa_m2,
                baseline_intensity_2025: a.baseline_intensity_2025,
                scope2_fraction: a.scope2_fraction,
                grid_ef_annual: a.grid_ef_annual as any,
                crrem_annual: a.crrem_annual as any,
                exit_cap_rate: a.exit_cap_rate,
                exit_year: a.exit_year,
                discount_rate: a.discount_rate,
                measures: a.measures as any,
              })),
            })
          } catch (e: any) {
            trajectory = { error: e.message }
          }
        }
        const result = {
          provenance: { engine: 'compute_plan_economics', tool: 'compute_portfolio_economics', version: trajectory ? '1.1' : '1.0', computed: ok.length, errored: per.length - ok.length },
          portfolio: { irr_hurdle: hurdle, assets_evaluated: per.length, assets_above_hurdle, total_value_creation, total_incremental_capex },
          funds,
          assets: per,
          ...(trajectory ? { trajectory } : {}),
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  return server
}

const app = express()
app.use(express.json())
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'soapbox-cashflow-mcp' }))

app.all('/mcp', async (req, res) => {
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { try { transport.close() } catch {} ; try { server.close() } catch {} })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

const port = process.env.PORT ?? 3000
app.listen(port, () => console.log(`soapbox-cashflow-mcp listening on :${port}`))
