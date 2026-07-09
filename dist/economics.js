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
//   irr_excl_exit          = IRR of the operating stream ONLY (no terminal exit-value residual) — the pays-for-itself screen
//   irr_incremental        = IRR of the unlevered stream with asset_value_impact folded into the exit year (period 0 = first year)
//   waterfall.capitalized_X = EXIT-YEAR (stabilized) run-rate of stream X / exit_cap_rate — capitalizes
//                            what a buyer pays for at sale; util + ancillary + fine sum to asset_value_impact.
//   waterfall.exit_value_uplift = asset_value_impact (the single headline value number)
//   waterfall.pv_bps_fine_avoidance = Σ fine[y] discounted at discount_rate to the first year — CONTEXT only
//                            (interim avoided-fine benefit), NOT a component of net_value_creation.
//   net_value_creation     = -Σ incremental_capex + Σ incentives + exit_value_uplift
//                            (= capitalized exit uplift net of the incremental capital spent to earn it;
//                             reconciles exactly to asset_value_impact − net capex)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** IRR via bisection over a wide bracket; robust for the sign-change streams decarb produces.
 *  Returns null if no sign change in [-0.95, 5.0] (e.g. all-positive or all-negative stream). */
export function irr(cashflows, lo = -0.95, hi = 5.0, tol = 1e-10) {
    const npv = (r) => cashflows.reduce((s, cf, t) => s + cf / (1 + r) ** t, 0);
    let flo = npv(lo);
    let fhi = npv(hi);
    if (flo === 0)
        return lo;
    if (fhi === 0)
        return hi;
    if (flo * fhi > 0)
        return null; // no sign change in bracket
    for (let i = 0; i < 300; i++) {
        const mid = (lo + hi) / 2;
        const fm = npv(mid);
        if (Math.abs(fm) < tol || (hi - lo) / 2 < 1e-12)
            return mid;
        if (flo * fm < 0) {
            hi = mid;
            fhi = fm;
        }
        else {
            lo = mid;
            flo = fm;
        }
    }
    return (lo + hi) / 2;
}
export function computePlanEconomics(input) {
    const exitCap = num(input.exit_cap_rate);
    const discount = input.discount_rate != null ? num(input.discount_rate) : 0.08;
    const exitYear = num(input.exit_year);
    if (!(exitCap > 0))
        throw new Error('exit_cap_rate must be > 0');
    const flows = [...(input.flows ?? [])].sort((a, b) => num(a.year) - num(b.year));
    if (flows.length === 0)
        throw new Error('flows must be non-empty');
    // Per-year schedule
    const cashflow = flows.map((f) => {
        // Owner utility savings: use the directly-supplied value if given, else apply capture to the
        // gross-by-source fields IN THE ENGINE (efficiency at per-fuel landlord share; solar at its
        // VNM/BTM capture, default 0.80 where VNM). This keeps landlord-share application inside the
        // economics layer — never trust an upstream (e.g. Audette) "landlord savings" field, which is
        // uncaptured (= gross).
        const util = f.owner_utility_savings != null
            ? num(f.owner_utility_savings)
            : num(f.elec_capture) * num(f.gross_elec_savings)
                + num(f.gas_capture) * num(f.gross_gas_savings)
                + (f.solar_capture != null ? num(f.solar_capture) : 0.80) * num(f.gross_solar_savings);
        const anc = num(f.ancillary_revenue);
        const fine = num(f.bps_fine_avoidance);
        const capex = num(f.incremental_capex);
        const incent = num(f.incentives);
        const noi = util + anc + fine;
        const unlev = noi - capex + incent;
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
        };
    });
    // Terminal exit-value delta: recurring owner NOI uplift in the exit year, capitalized.
    const exitRow = cashflow.find((c) => c.year === exitYear) ?? cashflow[cashflow.length - 1];
    const terminal = Math.round(exitRow.noi_impact / exitCap);
    exitRow.asset_value_impact = terminal;
    // Running cumulative
    let run = 0;
    for (const c of cashflow) {
        run += c.unlevered_incremental_cashflow;
        c.cumulative = Math.round(run);
    }
    // Two IRRs on the unlevered stream (period 0 = first flow year):
    //   irr_excl_exit   = operating cashflows ONLY (owner savings + ancillary + annual avoided fine
    //                     − capex + incentives), NO terminal exit-value residual. The "does it pay for
    //                     itself operationally" screen.
    //   irr_incremental = the same stream WITH the terminal asset_value_impact folded into the exit
    //                     year — the value-inclusive return (operating + exit residual).
    const operatingStream = cashflow.map((c) => c.unlevered_incremental_cashflow);
    const exitIdx = cashflow.findIndex((c) => c.year === exitRow.year);
    const rateExcl = irr(operatingStream);
    const irr_excl_exit = rateExcl == null ? null : Math.round(rateExcl * 1000) / 1000;
    const stream = [...operatingStream];
    stream[exitIdx] += terminal;
    const rate = irr(stream);
    const irr_incremental = rate == null ? null : Math.round(rate * 1000) / 1000;
    // Capitalize the EXIT-YEAR (stabilized) run-rate — the value a buyer capitalizes at sale.
    // Using going-in (year-1) run-rate under-counts an ESCALATING stream, and made the waterfall
    // disagree with asset_value_impact (which caps the exit-year NOI). Capitalize util, ancillary,
    // AND avoided fine at the exit-year run-rate so the three sum to asset_value_impact.
    const capitalized_utility_savings = Math.round(exitRow.utility_savings / exitCap);
    const capitalized_ancillary_revenue = Math.round(exitRow.revenue / exitCap);
    const capitalized_fine_avoidance = Math.round(exitRow.bps_fine_avoidance / exitCap);
    // PV of the fine-avoidance schedule, discounted to the first flow year — reported for CONTEXT
    // (the interim avoided-fine benefit over the hold), NOT a component of net_value_creation.
    let pv_bps_fine_avoidance = 0;
    flows.forEach((f, t) => { pv_bps_fine_avoidance += num(f.bps_fine_avoidance) / (1 + discount) ** t; });
    pv_bps_fine_avoidance = Math.round(pv_bps_fine_avoidance);
    const total_incremental_capex = flows.reduce((s, f) => s + num(f.incremental_capex), 0);
    const total_incentives = flows.reduce((s, f) => s + num(f.incentives), 0);
    // Net value creation = capitalized exit-value uplift (asset_value_impact) net of incremental
    // capex, plus incentives. Reconciles EXACTLY to the terminal asset_value_impact booked above:
    // capitalized_utility + capitalized_ancillary + capitalized_fine ≈ asset_value_impact.
    const net_value_creation = Math.round(-total_incremental_capex + total_incentives + terminal);
    return {
        irr_incremental,
        irr_excl_exit,
        cashflow,
        waterfall: {
            incentives: Math.round(total_incentives),
            baseline_capex: 0,
            incremental_capex: -Math.round(total_incremental_capex),
            capitalized_utility_savings,
            capitalized_ancillary_revenue,
            capitalized_fine_avoidance,
            exit_value_uplift: terminal,
            pv_bps_fine_avoidance,
            net_value_creation,
        },
    };
}
const r1 = (n) => Math.round(n * 10) / 10;
/** Linear-interpolate/hold a {year,value} series at an arbitrary year. */
function seriesAt(points, year) {
    if (!points.length)
        return null;
    const s = points.slice().sort((a, b) => a.year - b.year);
    if (year <= s[0].year)
        return s[0].value;
    if (year >= s[s.length - 1].year)
        return s[s.length - 1].value;
    const lo = s.filter((p) => p.year <= year).pop();
    const hi = s.filter((p) => p.year >= year).shift();
    if (hi.year === lo.year)
        return lo.value;
    const t = (year - lo.year) / (hi.year - lo.year);
    return lo.value + t * (hi.value - lo.value);
}
export function computePortfolioTrajectory(input) {
    const hurdle = num(input.irr_hurdle ?? 0.15);
    const dExit = input.d_exit_year ?? 2040;
    const y0 = input.year_start ?? 2025;
    const y1 = input.year_end ?? 2050;
    const years = [];
    for (let y = y0; y <= y1; y++)
        years.push(y);
    const totalGfa = input.assets.reduce((s, a) => s + num(a.gfa_m2), 0);
    // Which series can we build? (graceful degradation — the CRREM blend, the
    // main fabrication risk, computes even if scenario inputs are incomplete.)
    const crremReady = totalGfa > 0 && input.assets.every((a) => num(a.gfa_m2) > 0 && Array.isArray(a.crrem_annual) && a.crrem_annual.length > 0);
    const scenReady = totalGfa > 0 && input.assets.every((a) => num(a.gfa_m2) > 0 &&
        Number.isFinite(Number(a.baseline_intensity_2025)) &&
        Number.isFinite(Number(a.scope2_fraction)) &&
        Array.isArray(a.grid_ef_annual) && a.grid_ef_annual.length > 0 &&
        Array.isArray(a.measures));
    const missing = [];
    if (!crremReady)
        missing.push('crrem_target (needs every asset to have gfa_m2 + crrem_annual)');
    if (!scenReady)
        missing.push('scenario_a..d (needs every asset to have gfa_m2 + baseline_intensity_2025 + scope2_fraction + grid_ef_annual + measures)');
    // ── Per-asset scenario membership (only if scenReady) ──
    const membership = [];
    if (scenReady) {
        for (const a of input.assets) {
            const disc = a.discount_rate;
            for (const m of a.measures) {
                const e31 = computePlanEconomics({ flows: m.flows, exit_cap_rate: a.exit_cap_rate, exit_year: a.exit_year, discount_rate: disc });
                const e40 = computePlanEconomics({ flows: m.flows, exit_cap_rate: a.exit_cap_rate, exit_year: dExit, discount_rate: disc });
                const comp = m.compliance_required === true;
                const inA = comp || (e31.irr_excl_exit != null && e31.irr_excl_exit >= hurdle);
                const inB = inA || (e31.irr_incremental != null && e31.irr_incremental >= hurdle); // B ⊇ A
                const inC = inB || m.is_solar === true; // C ⊇ B (force all solar)
                const inD = inC || (e40.irr_incremental != null && e40.irr_incremental >= hurdle); // D ⊇ C
                membership.push({ asset: a.asset_name, gfa: num(a.gfa_m2), install_year: m.install_year, tco2e: num(m.annual_tco2e_reduction), inA, inB, inC, inD });
            }
        }
    }
    // ── Year-by-year GFA-weighted portfolio series ──
    const traj = years.map((Y) => {
        const row = { year: Y };
        // CRREM target — GFA-weighted blend of the per-asset tool-fetched pathways.
        if (crremReady) {
            let acc = 0;
            for (const a of input.assets) {
                const v = seriesAt((a.crrem_annual || []).map((p) => ({ year: p.year, value: num(p.target) })), Y);
                acc += (v ?? 0) * num(a.gfa_m2);
            }
            row.crrem_target = r1(acc / totalGfa);
        }
        // BAU + scenarios (portfolio GFA-weighted intensity).
        if (scenReady) {
            let bau = 0, sa = 0, sb = 0, sc = 0, sd = 0;
            for (const a of input.assets) {
                const gfa = num(a.gfa_m2);
                const base = num(a.baseline_intensity_2025);
                const s2 = Math.max(0, Math.min(1, num(a.scope2_fraction)));
                const ef = (a.grid_ef_annual || []).map((p) => ({ year: p.year, value: num(p.factor) }));
                const efBase = seriesAt(ef, y0) || 1;
                const gridIdx = (seriesAt(ef, Y) ?? efBase) / (efBase || 1);
                // Scope-1 flat, Scope-2 tracks the grid factor.
                const bauInt = base * ((1 - s2) + s2 * gridIdx);
                // Cumulative intensity reduction from measures installed by year Y, per scenario.
                const red = (pred) => (a.measures || [])
                    .filter((m) => m.install_year <= Y && pred(m))
                    .reduce((s, m) => s + (num(m.annual_tco2e_reduction) * 1000) / gfa, 0); // tCO2e → kgCO2e/m2
                const memOf = (m) => membership.find((x) => x.asset === a.asset_name && x.install_year === m.install_year && x.tco2e === num(m.annual_tco2e_reduction)) || {};
                const clampInt = (v) => Math.max(0, v);
                bau += bauInt * gfa;
                sa += clampInt(bauInt - red((m) => memOf(m).inA)) * gfa;
                sb += clampInt(bauInt - red((m) => memOf(m).inB)) * gfa;
                sc += clampInt(bauInt - red((m) => memOf(m).inC)) * gfa;
                sd += clampInt(bauInt - red((m) => memOf(m).inD)) * gfa;
            }
            row.bau = r1(bau / totalGfa);
            row.scenario_a = r1(sa / totalGfa);
            row.scenario_b = r1(sb / totalGfa);
            row.scenario_c = r1(sc / totalGfa);
            row.scenario_d = r1(sd / totalGfa);
        }
        return row;
    });
    // ── Assert nesting + monotonicity (skill sanity gate, SKILL.md:1235) ──
    if (scenReady) {
        for (const row of traj) {
            const seq = [row.bau, row.scenario_a, row.scenario_b, row.scenario_c, row.scenario_d];
            for (let i = 1; i < seq.length; i++) {
                if (seq[i] > seq[i - 1] + 1e-6)
                    throw new Error(`Trajectory nesting violated at ${row.year}: BAU>=A>=B>=C>=D expected, got ${seq.join(' ')}`);
            }
        }
        for (const key of ['bau', 'scenario_a', 'scenario_b', 'scenario_c', 'scenario_d']) {
            for (let i = 1; i < traj.length; i++) {
                if (traj[i][key] > traj[i - 1][key] + 1e-6)
                    throw new Error(`Trajectory ${key} not non-increasing at ${traj[i].year}`);
            }
        }
    }
    const at = (Y, key) => { const r = traj.find((t) => t.year === Y); return r ? r[key] : null; };
    const crrem_trajectory = crremReady ? {
        current_intensity: scenReady ? at(y0, 'bau') : null,
        with_measures_intensity: scenReady ? at(dExit, 'scenario_b') : null,
        crrem_2030: at(2030, 'crrem_target'),
        crrem_2035: at(2035, 'crrem_target'),
        crrem_2040: at(2040, 'crrem_target'),
    } : null;
    return {
        emissions_trajectory: traj,
        crrem_trajectory,
        scenario_membership: scenReady ? membership : null,
        incomplete: missing.length ? missing : null,
        methodology_note: 'Trajectory computed deterministically by compute_portfolio_economics: CRREM target = GFA-weighted blend of per-asset get_pathway curves; scenarios A⊆B⊆C⊆D screened from each measure’s own flows (A=irr_excl_exit≥hurdle, B=+irr_incremental≥hurdle, C=+all solar, D=+2040-horizon screen), BAU decays the Scope-2 share by the supplied grid emission-factor series. v1 treats each measure’s annual tCO2e as constant; because the grid decarbonises, late-year electric savings are marginally over-counted.',
    };
}
