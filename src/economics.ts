// Deterministic decarbonization plan economics — the value bridge + incremental IRR
// that decarb reports present. Implemented natively (no python subprocess): the IRR is a
// Newton/bisection root-find and the rest is capitalization + discounting arithmetic.
//
// The LLM supplies only auditable per-year owner-share line items (which trace to Audette
// measures); this engine owns every derived money-math transform (noi/unlevered/cumulative,
// capitalization ÷ cap, PV of fine schedule, terminal exit-value delta, and IRR).
//
// Conventions (calibrated against the verified Westminster streams — see economics.test):
//   noi_impact[y]          = owner_utility_savings[y] + ancillary_revenue[y] + bps_fine_avoidance[y]
//   unlevered[y]           = noi_impact[y] - incremental_capex[y] + incentives[y]
//   cumulative[y]          = running sum of unlevered
//   asset_value_impact     = noi_impact[exit_year] / exit_cap_rate   (recurring owner NOI uplift capitalized at exit)
//   irr_incremental        = IRR of the unlevered stream with asset_value_impact folded into the exit year (period 0 = first year)
//   waterfall.capitalized_X = (going-in run-rate of stream X — its value in the first year it is nonzero) / exit_cap_rate
//   waterfall.pv_bps_fine_avoidance = Σ fine[y] discounted at discount_rate to the first year
//   net_value_creation     = -Σ incremental_capex + Σ incentives + capitalized_utility_savings
//                            + capitalized_ancillary_revenue + pv_bps_fine_avoidance

export interface PlanFlowYear {
  year: number
  incremental_capex?: number
  owner_utility_savings?: number
  ancillary_revenue?: number
  incentives?: number
  bps_fine_avoidance?: number
}

export interface PlanEconomicsInput {
  flows: PlanFlowYear[]
  exit_cap_rate: number
  exit_year: number
  discount_rate?: number // for PV of the fine schedule (default 0.08)
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** IRR via bisection over a wide bracket; robust for the sign-change streams decarb produces.
 *  Returns null if no sign change in [-0.95, 5.0] (e.g. all-positive or all-negative stream). */
export function irr(cashflows: number[], lo = -0.95, hi = 5.0, tol = 1e-10): number | null {
  const npv = (r: number) => cashflows.reduce((s, cf, t) => s + cf / (1 + r) ** t, 0)
  let flo = npv(lo)
  let fhi = npv(hi)
  if (flo === 0) return lo
  if (fhi === 0) return hi
  if (flo * fhi > 0) return null // no sign change in bracket
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2
    const fm = npv(mid)
    if (Math.abs(fm) < tol || (hi - lo) / 2 < 1e-12) return mid
    if (flo * fm < 0) { hi = mid; fhi = fm } else { lo = mid; flo = fm }
  }
  return (lo + hi) / 2
}

export function computePlanEconomics(input: PlanEconomicsInput) {
  const exitCap = num(input.exit_cap_rate)
  const discount = input.discount_rate != null ? num(input.discount_rate) : 0.08
  const exitYear = num(input.exit_year)
  if (!(exitCap > 0)) throw new Error('exit_cap_rate must be > 0')
  const flows = [...(input.flows ?? [])].sort((a, b) => num(a.year) - num(b.year))
  if (flows.length === 0) throw new Error('flows must be non-empty')

  // Per-year schedule
  const cashflow = flows.map((f) => {
    const util = num(f.owner_utility_savings)
    const anc = num(f.ancillary_revenue)
    const fine = num(f.bps_fine_avoidance)
    const capex = num(f.incremental_capex)
    const incent = num(f.incentives)
    const noi = util + anc + fine
    const unlev = noi - capex + incent
    return {
      year: num(f.year),
      revenue: anc,
      utility_savings: util,
      incentives: incent,
      incremental_capex: capex,
      bps_fine_avoidance: fine,
      noi_impact: Math.round(noi),
      asset_value_impact: 0,
      unlevered_incremental_cashflow: Math.round(unlev),
      cumulative: 0,
    }
  })

  // Terminal exit-value delta: recurring owner NOI uplift in the exit year, capitalized.
  const exitRow = cashflow.find((c) => c.year === exitYear) ?? cashflow[cashflow.length - 1]
  const terminal = Math.round(exitRow.noi_impact / exitCap)
  exitRow.asset_value_impact = terminal

  // Running cumulative
  let run = 0
  for (const c of cashflow) { run += c.unlevered_incremental_cashflow; c.cumulative = Math.round(run) }

  // IRR of the unlevered stream with the terminal folded into the exit year (period 0 = first flow year)
  const stream = cashflow.map((c) => c.unlevered_incremental_cashflow)
  const exitIdx = cashflow.findIndex((c) => c.year === exitRow.year)
  stream[exitIdx] += terminal
  const rate = irr(stream)
  const irr_incremental = rate == null ? null : Math.round(rate * 1000) / 1000

  // Going-in run-rate of a recurring stream = its value in the first year it is nonzero.
  const goingIn = (key: 'owner_utility_savings' | 'ancillary_revenue') => {
    for (const f of flows) { const v = num((f as any)[key]); if (v !== 0) return v }
    return 0
  }
  const capitalized_utility_savings = Math.round(goingIn('owner_utility_savings') / exitCap)
  const capitalized_ancillary_revenue = Math.round(goingIn('ancillary_revenue') / exitCap)

  // PV of the fine-avoidance schedule, discounted to the first flow year (period 0).
  let pv_bps_fine_avoidance = 0
  flows.forEach((f, t) => { pv_bps_fine_avoidance += num(f.bps_fine_avoidance) / (1 + discount) ** t })
  pv_bps_fine_avoidance = Math.round(pv_bps_fine_avoidance)

  const total_incremental_capex = flows.reduce((s, f) => s + num(f.incremental_capex), 0)
  const total_incentives = flows.reduce((s, f) => s + num(f.incentives), 0)
  const net_value_creation = Math.round(
    -total_incremental_capex + total_incentives + capitalized_utility_savings +
    capitalized_ancillary_revenue + pv_bps_fine_avoidance,
  )

  return {
    irr_incremental,
    cashflow,
    waterfall: {
      incentives: Math.round(total_incentives),
      baseline_capex: 0,
      incremental_capex: -Math.round(total_incremental_capex),
      capitalized_utility_savings,
      capitalized_ancillary_revenue,
      pv_bps_fine_avoidance,
      net_value_creation,
    },
  }
}
