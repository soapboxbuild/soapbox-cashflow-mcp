import { computePlanEconomics } from './economics.js'

// Westminster oracle — verified streams (report bade4342, independently bisection-checked).
const p1 = {
  exit_cap_rate: 0.0515, exit_year: 2034, flows: [
    { year: 2027, owner_utility_savings: 10363, ancillary_revenue: 0, incremental_capex: 65131, incentives: 47000 },
    { year: 2028, owner_utility_savings: 10674, ancillary_revenue: 0, incremental_capex: 51000 },
    { year: 2029, owner_utility_savings: 10994, ancillary_revenue: 97000, incremental_capex: 967500 },
    { year: 2030, owner_utility_savings: 11324, ancillary_revenue: 99910 },
    { year: 2031, owner_utility_savings: 11664, ancillary_revenue: 102907 },
    { year: 2032, owner_utility_savings: 12014, ancillary_revenue: 105995 },
    { year: 2033, owner_utility_savings: 12374, ancillary_revenue: 109174 },
    { year: 2034, owner_utility_savings: 12745, ancillary_revenue: 112450 },
  ],
}
const p2 = {
  exit_cap_rate: 0.0515, exit_year: 2034, flows: [
    { year: 2027, owner_utility_savings: 10363, ancillary_revenue: 0, incremental_capex: 65131, incentives: 47000 },
    { year: 2028, owner_utility_savings: 10674, ancillary_revenue: 0, incremental_capex: 51000 },
    { year: 2029, owner_utility_savings: 10994, ancillary_revenue: 97000, incremental_capex: 967500 },
    { year: 2030, owner_utility_savings: 11624, ancillary_revenue: 99910, incremental_capex: 320000 },
    { year: 2031, owner_utility_savings: 11973, ancillary_revenue: 102907, incremental_capex: 329000 },
    { year: 2032, owner_utility_savings: 12332, ancillary_revenue: 105995 },
    { year: 2033, owner_utility_savings: 12702, ancillary_revenue: 109174 },
    { year: 2034, owner_utility_savings: 13083, ancillary_revenue: 112450 },
  ],
}

let failures = 0
for (const [name, inp, expIrr, expTerm] of [['Plan 1', p1, 0.304, 2430966], ['Plan 2', p2, 0.181, 2437523]] as const) {
  const r = computePlanEconomics(inp)
  const exitRow = r.cashflow.find((c) => c.year === 2034)!
  console.log(`\n=== ${name} ===`)
  console.log(`  IRR:              ${r.irr_incremental}  (oracle ${expIrr})  ${r.irr_incremental === expIrr ? 'PASS' : 'CHECK'}`)
  console.log(`  terminal exit dV: ${exitRow.asset_value_impact}  (oracle ${expTerm})  ${Math.abs(exitRow.asset_value_impact - expTerm) <= 15 ? 'PASS' : 'CHECK'}`)
  console.log(`  net_value_creation: ${r.waterfall.net_value_creation}`)
  console.log(`  cap_util ${r.waterfall.capitalized_utility_savings} | cap_ancillary ${r.waterfall.capitalized_ancillary_revenue} | incr_capex ${r.waterfall.incremental_capex}`)
  console.log(`  unlevered stream: ${r.cashflow.map((c) => c.unlevered_incremental_cashflow).join(', ')}`)
  if (r.irr_incremental !== expIrr) failures++
}

// Regression: real decarb plans skip years with no measure entirely (e.g. 4th & Madison's
// flows jump 2029 -> 2031, nothing lands in 2030) — the cashflow array is SPARSE, indexed by
// real calendar year, not consecutive integer periods. irr() previously discounted by ARRAY
// POSITION (period 0,1,2...) instead of each row's actual elapsed year, silently compressing
// gapped years and inflating the reported rate. This case has an unambiguous, hand-computed
// answer: -1000 at 2027, +2000 at 2030 (a 3-year real gap, only 2 rows in the array).
// Correct (year-aware) IRR solves -1000 + 2000/(1+r)^3 = 0 -> r = 2^(1/3) - 1 ≈ 0.2599.
// The old array-index bug instead solved -1000 + 2000/(1+r)^1 = 0 -> r = 1.0 (100%, wrong).
{
  const gapPlan = {
    exit_cap_rate: 0.055, exit_year: 2030, flows: [
      { year: 2027, incremental_capex: 1000 },
      { year: 2030, owner_utility_savings: 2000 },
    ],
  }
  const r = computePlanEconomics(gapPlan)
  const expected = Math.pow(2, 1 / 3) - 1
  console.log(`\n=== Gap-year regression ===`)
  console.log(`  irr_excl_exit: ${r.irr_excl_exit}  (expected ~${expected.toFixed(4)}, year-aware; NOT 1.0, the array-index bug's answer)`)
  if (r.irr_excl_exit == null || Math.abs(r.irr_excl_exit - expected) > 0.001) failures++
}

if (failures > 0) { console.error(`\n${failures} oracle check(s) FAILED`); process.exit(1) }
console.log('\nAll oracle checks passed.')
