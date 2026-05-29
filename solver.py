"""
solver.py
---------
Reads a filled Timetable Scheduler input template and produces one or more
feasible schedules using Integer Linear Programming (PuLP).

If the problem is infeasible with all constraints hard, it relaxes soft
constraints using a penalty method and records each violation.
"""

import datetime
import itertools
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import pandas as pd
import pulp


# ─────────────────────────────────────────────────────────────────────────────
# Data containers
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Resource:
    id: int
    name: str
    min_hours: float
    max_hours: float
    daily_hours: float
    min_consecutive: int = 1


@dataclass
class Department:
    id: int
    name: str
    min_hours: float
    max_hours: float


@dataclass
class Violation:
    violation_id: str
    vtype: str          # e.g. "Resource Min Hours", "Dept Min Hours", etc.
    resource: str       # Resource name or "-"
    department: str     # Dept name or "-"
    date: str           # Date string or "-"
    details: str
    severity: str       # "High", "Medium", "Low"


@dataclass
class ScheduleResult:
    """Holds one complete schedule solution."""
    assignment: Dict[Tuple[str, str, datetime.date], int]
    # assignment[(resource_name, dept_name, date)] = 1 or 0
    violations: List[Violation] = field(default_factory=list)
    is_feasible: bool = True        # True = all hard constraints met
    alternate_index: int = 0        # 0 = primary, 1,2,... = alternates
    total_penalty: float = 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Input reader
# ─────────────────────────────────────────────────────────────────────────────

class InputReader:
    """Reads and validates the Excel input template."""

    def __init__(self, xlsx_path: str):
        self.path = xlsx_path
        self.resources: List[Resource]     = []
        self.departments: List[Department] = []
        self.dates: List[datetime.date]    = []
        self.absence: Dict[Tuple[str, datetime.date], bool] = {}
        # True = absent
        self.mapping: Dict[Tuple[str, str], bool] = {}
        # True = can assign
        self.dept_minmax: Dict[Tuple[str, str], Tuple[int, int]] = {}
        # (min_days, max_days)
        self._errors: List[str] = []

    def read(self):
        xl = pd.ExcelFile(self.path)
        self._read_config(xl)
        self._read_resources(xl)
        self._read_departments(xl)
        self._read_absence(xl)
        self._read_mapping(xl)
        self._read_dept_minmax(xl)
        if self._errors:
            raise ValueError(
                "Input template has errors:\n" +
                "\n".join(f"  • {e}" for e in self._errors))

    # ── Config ───────────────────────────────────────────────────────────────
    def _read_config(self, xl):
        df = xl.parse("Config", header=1, index_col=0, usecols="A:B")
        df.index = df.index.astype(str).str.strip()

        def _get(key, typ, default=None):
            try:
                raw = df.loc[key, df.columns[0]]
                if pd.isna(raw):
                    return default
                return typ(raw)
            except (KeyError, ValueError, TypeError):
                return default

        start_raw = _get("Plan Start Date", str)
        end_raw   = _get("Plan End Date",   str)

        try:
            start = pd.to_datetime(start_raw).date()
        except Exception:
            start = datetime.date.today().replace(day=1)
            self._errors.append("Config: invalid Plan Start Date — using today's month start")

        try:
            end = pd.to_datetime(end_raw).date()
        except Exception:
            end = (start.replace(day=1) + datetime.timedelta(days=31)
                   ).replace(day=1) - datetime.timedelta(days=1)
            self._errors.append("Config: invalid Plan End Date — using month end")

        if end < start:
            self._errors.append("Config: Plan End Date is before Plan Start Date")

        d = start
        while d <= end:
            self.dates.append(d)
            d += datetime.timedelta(days=1)

        self.max_alternates = _get("Max Alternate Schedules to Generate", int, 3)

    # ── Resources ────────────────────────────────────────────────────────────
    def _read_resources(self, xl):
        df = xl.parse("Resources", header=1)
        df.columns = [str(c).strip() for c in df.columns]
        # Drop rows where Name is NaN
        df = df.dropna(subset=[df.columns[1]])

        for _, row in df.iterrows():
            try:
                rid   = int(row.iloc[0])
                name  = str(row.iloc[1]).strip()
                minh  = float(row.iloc[2]) if not pd.isna(row.iloc[2]) else 0
                maxh  = float(row.iloc[3]) if not pd.isna(row.iloc[3]) else 9999
                dailyh = float(row.iloc[4]) if not pd.isna(row.iloc[4]) else 8
                self.resources.append(Resource(rid, name, minh, maxh, dailyh))
            except Exception as e:
                self._errors.append(f"Resources row {rid}: {e}")

    # ── Departments ──────────────────────────────────────────────────────────
    def _read_departments(self, xl):
        df = xl.parse("Departments", header=1)
        df = df.dropna(subset=[df.columns[1]])

        for _, row in df.iterrows():
            try:
                did   = int(row.iloc[0])
                name  = str(row.iloc[1]).strip()
                minh  = float(row.iloc[2]) if not pd.isna(row.iloc[2]) else 0
                maxh  = float(row.iloc[3]) if not pd.isna(row.iloc[3]) else 9999
                self.departments.append(Department(did, name, minh, maxh))
            except Exception as e:
                self._errors.append(f"Departments row {did}: {e}")

    # ── Absence ──────────────────────────────────────────────────────────────
    def _read_absence(self, xl):
        df = xl.parse("Absence", header=1)
        df = df.dropna(how="all")

        # Column 0 = ID, column 1 = Name, rest = dates
        date_cols = df.columns[2:]
        for _, row in df.iterrows():
            rname = str(row.iloc[1]).strip()
            for col in date_cols:
                try:
                    dt = pd.to_datetime(col).date()
                except Exception:
                    continue
                val = str(row[col]).strip().lower() if not pd.isna(row[col]) else ""
                self.absence[(rname, dt)] = val == "absent"

    # ── Mapping ──────────────────────────────────────────────────────────────
    def _read_mapping(self, xl):
        df = xl.parse("Dept_Mapping", header=1)
        df = df.dropna(how="all")

        dept_cols = df.columns[2:]
        for _, row in df.iterrows():
            rname = str(row.iloc[1]).strip()
            for col in dept_cols:
                dname = str(col).strip()
                try:
                    val = int(float(row[col])) if not pd.isna(row[col]) else 1
                except Exception:
                    val = 1
                self.mapping[(rname, dname)] = (val == 1)

    # ── Dept MinMax ──────────────────────────────────────────────────────────
    def _read_dept_minmax(self, xl):
        df = xl.parse("Dept_MinMax", header=1)
        df = df.dropna(how="all")

        for _, row in df.iterrows():
            rname = str(row.iloc[1]).strip()
            dname = str(row.iloc[2]).strip()
            try:
                mn = int(float(row.iloc[3])) if not pd.isna(row.iloc[3]) else 0
                mx = int(float(row.iloc[4])) if not pd.isna(row.iloc[4]) else 9999
            except Exception:
                mn, mx = 0, 9999
            self.dept_minmax[(rname, dname)] = (mn, mx)


# ─────────────────────────────────────────────────────────────────────────────
# Solver
# ─────────────────────────────────────────────────────────────────────────────

class Scheduler:
    """
    Builds and solves an ILP model for the timetable problem.

    Phase 1: Try with all hard constraints.
    Phase 2: If infeasible, use penalty/soft-constraint formulation.
    Phase 3: Generate up to max_alternates additional solutions using
             no-good cuts.
    """

    PENALTY_RESOURCE_MIN_HOURS = 1000
    PENALTY_RESOURCE_MAX_HOURS = 1000
    PENALTY_DEPT_MIN_HOURS     = 500
    PENALTY_DEPT_MAX_HOURS     = 500
    PENALTY_DEPT_MIN_DAYS      = 200
    PENALTY_DEPT_MAX_DAYS      = 200

    def __init__(self, reader: InputReader):
        self.r  = reader
        self.results: List[ScheduleResult] = []

    # ── Public entry point ───────────────────────────────────────────────────
    def solve(self) -> List[ScheduleResult]:
        # Phase 1 — hard constraints
        result = self._solve_model(soft=False)
        if result is not None:
            result.is_feasible = True
            self.results.append(result)
            # Phase 3 — alternates
            self._generate_alternates(hard_solutions=[result])
        else:
            # Phase 2 — soft constraints
            result = self._solve_model(soft=True)
            if result is not None:
                result.is_feasible = False
                self.results.append(result)
            else:
                # Absolute fallback — empty schedule
                self.results.append(ScheduleResult(
                    assignment={},
                    violations=[Violation(
                        "V000", "No Solution", "-", "-", "-",
                        "Could not build any schedule even with relaxed constraints. "
                        "Check that at least some resources are available and mapped.",
                        "High")],
                    is_feasible=False))

        return self.results

    # ── Model builder ────────────────────────────────────────────────────────
    def _build_variables(self, prob: pulp.LpProblem):
        """Create binary decision variables x[r, d, t]."""
        resources = self.r.resources
        depts     = self.r.departments
        dates     = self.r.dates

        x = {}
        for res in resources:
            for dept in depts:
                for dt in dates:
                    key = (res.name, dept.name, dt)
                    x[key] = pulp.LpVariable(
                        f"x_{res.id}_{dept.id}_{dt.strftime('%Y%m%d')}",
                        cat="Binary")
        return x

    def _add_hard_constraints(self, prob, x):
        resources = self.r.resources
        depts     = self.r.departments
        dates     = self.r.dates

        # C1: At most one dept per resource per day
        for res in resources:
            for dt in dates:
                prob += (
                    pulp.lpSum(x[(res.name, dept.name, dt)]
                               for dept in depts) <= 1,
                    f"c1_one_dept_{res.id}_{dt}")

        # C2: No assignment on absent days
        for res in resources:
            for dept in depts:
                for dt in dates:
                    if self.r.absence.get((res.name, dt), False):
                        prob += (x[(res.name, dept.name, dt)] == 0,
                                 f"c2_absent_{res.id}_{dept.id}_{dt}")

        # C3: Feasibility mapping
        for res in resources:
            for dept in depts:
                if not self.r.mapping.get((res.name, dept.name), True):
                    for dt in dates:
                        prob += (x[(res.name, dept.name, dt)] == 0,
                                 f"c3_map_{res.id}_{dept.id}_{dt}")

        # C4/C5: Per-resource per-dept min/max days
        for res in resources:
            for dept in depts:
                mn, mx = self.r.dept_minmax.get((res.name, dept.name), (0, 9999))
                total_var = pulp.lpSum(x[(res.name, dept.name, dt)]
                                       for dt in dates)
                if mn > 0:
                    prob += (total_var >= mn,
                             f"c4_mindays_{res.id}_{dept.id}")
                if mx < 9999:
                    prob += (total_var <= mx,
                             f"c5_maxdays_{res.id}_{dept.id}")

        # C6/C7: Resource total hours
        for res in resources:
            total_hours = pulp.lpSum(
                x[(res.name, dept.name, dt)] * res.daily_hours
                for dept in depts for dt in dates)
            if res.min_hours > 0:
                prob += (total_hours >= res.min_hours,
                         f"c6_minhr_{res.id}")
            if res.max_hours < 9999:
                prob += (total_hours <= res.max_hours,
                         f"c7_maxhr_{res.id}")

        # C8/C9: Dept total hours
        for dept in depts:
            total_hours = pulp.lpSum(
                x[(res.name, dept.name, dt)] * res.daily_hours
                for res in resources for dt in dates)
            if dept.min_hours > 0:
                prob += (total_hours >= dept.min_hours,
                         f"c8_dminhr_{dept.id}")
            if dept.max_hours < 9999:
                prob += (total_hours <= dept.max_hours,
                         f"c9_dmaxhr_{dept.id}")

    def _solve_model(self, soft: bool,
                     excluded_assignments: List[Dict] = None
                     ) -> Optional[ScheduleResult]:
        """Build and solve the model.
        soft=False → hard constraints only.
        soft=True  → penalty/soft constraints."""

        resources = self.r.resources
        depts     = self.r.departments
        dates     = self.r.dates

        prob = pulp.LpProblem("TimetableScheduler", pulp.LpMinimize)
        x = self._build_variables(prob)

        # ── Hard structural constraints (always applied) ──────────────────
        # C1: one dept per day
        for res in resources:
            for dt in dates:
                prob += (pulp.lpSum(x[(res.name, dept.name, dt)]
                                    for dept in depts) <= 1,
                         f"c1_{res.id}_{dt}")

        # C2: absent days
        for res in resources:
            for dept in depts:
                for dt in dates:
                    if self.r.absence.get((res.name, dt), False):
                        prob += (x[(res.name, dept.name, dt)] == 0,
                                 f"c2_{res.id}_{dept.id}_{dt}")

        # C3: mapping
        for res in resources:
            for dept in depts:
                if not self.r.mapping.get((res.name, dept.name), True):
                    for dt in dates:
                        prob += (x[(res.name, dept.name, dt)] == 0,
                                 f"c3_{res.id}_{dept.id}_{dt}")

        # C10: Consecutive days block constraint
        for res in resources:
            n = getattr(res, 'min_consecutive', 1)
            if n > 1:
                for dept in depts:
                    for idx, dt in enumerate(dates):
                        if idx == 0:
                            for k in range(min(n, len(dates))):
                                prob += (x[(res.name, dept.name, dt)] <= x[(res.name, dept.name, dates[k])],
                                         f"c10_start0_{res.id}_{dept.id}_{k}")
                        else:
                            prev_dt = dates[idx - 1]
                            for k in range(n):
                                if idx + k < len(dates):
                                    future_dt = dates[idx + k]
                                    prob += (x[(res.name, dept.name, dt)] - x[(res.name, dept.name, prev_dt)] <= x[(res.name, dept.name, future_dt)],
                                             f"c10_block_{res.id}_{dept.id}_t{idx}_k{k}")

        # ── No-good cuts for alternates ───────────────────────────────────
        if excluded_assignments:
            for idx, excl in enumerate(excluded_assignments):
                active_vars = [
                    x[key] for key, val in excl.items() if val == 1
                ]
                if active_vars:
                    prob += (
                        pulp.lpSum(active_vars) <= len(active_vars) - 1,
                        f"nogood_{idx}")

        # ── Objective & soft / hard resource/dept constraints ─────────────
        objective_terms = []
        violation_vars  = {}   # name → (penalty_var, description, severity)

        if not soft:
            # Hard versions
            self._add_hard_constraints(prob, x)
            prob += 0   # minimise 0 (feasibility only)
        else:
            # Soft versions with penalty variables
            # Per-resource min/max hours
            for res in resources:
                total_hours = pulp.lpSum(
                    x[(res.name, dept.name, dt)] * res.daily_hours
                    for dept in depts for dt in dates)

                if res.min_hours > 0:
                    slack_lo = pulp.LpVariable(
                        f"sl_res_min_{res.id}", lowBound=0)
                    prob += (total_hours + slack_lo >= res.min_hours,
                             f"sc_resminh_{res.id}")
                    objective_terms.append(
                        self.PENALTY_RESOURCE_MIN_HOURS * slack_lo)
                    violation_vars[f"sl_res_min_{res.id}"] = (
                        slack_lo, res,
                        f"Resource '{res.name}' below min hours ({res.min_hours}h)",
                        "High")

                if res.max_hours < 9999:
                    slack_hi = pulp.LpVariable(
                        f"sl_res_max_{res.id}", lowBound=0)
                    prob += (total_hours - slack_hi <= res.max_hours,
                             f"sc_resmaxh_{res.id}")
                    objective_terms.append(
                        self.PENALTY_RESOURCE_MAX_HOURS * slack_hi)
                    violation_vars[f"sl_res_max_{res.id}"] = (
                        slack_hi, res,
                        f"Resource '{res.name}' exceeds max hours ({res.max_hours}h)",
                        "Medium")

            # Per-dept min/max hours
            for dept in depts:
                total_hours = pulp.lpSum(
                    x[(res.name, dept.name, dt)] * res.daily_hours
                    for res in resources for dt in dates)

                if dept.min_hours > 0:
                    slack_lo = pulp.LpVariable(
                        f"sl_dept_min_{dept.id}", lowBound=0)
                    prob += (total_hours + slack_lo >= dept.min_hours,
                             f"sc_deptminh_{dept.id}")
                    objective_terms.append(
                        self.PENALTY_DEPT_MIN_HOURS * slack_lo)
                    violation_vars[f"sl_dept_min_{dept.id}"] = (
                        slack_lo, dept,
                        f"Department '{dept.name}' below min hours ({dept.min_hours}h)",
                        "High")

                if dept.max_hours < 9999:
                    slack_hi = pulp.LpVariable(
                        f"sl_dept_max_{dept.id}", lowBound=0)
                    prob += (total_hours - slack_hi <= dept.max_hours,
                             f"sc_deptmaxh_{dept.id}")
                    objective_terms.append(
                        self.PENALTY_DEPT_MAX_HOURS * slack_hi)
                    violation_vars[f"sl_dept_max_{dept.id}"] = (
                        slack_hi, dept,
                        f"Department '{dept.name}' exceeds max hours ({dept.max_hours}h)",
                        "Medium")

            # Per-resource per-dept min/max days (soft)
            for res in resources:
                for dept in depts:
                    mn, mx = self.r.dept_minmax.get(
                        (res.name, dept.name), (0, 9999))
                    total_days = pulp.lpSum(
                        x[(res.name, dept.name, dt)] for dt in dates)

                    if mn > 0:
                        sl = pulp.LpVariable(
                            f"sl_dmn_{res.id}_{dept.id}", lowBound=0)
                        prob += (total_days + sl >= mn,
                                 f"sc_dmndays_{res.id}_{dept.id}")
                        objective_terms.append(
                            self.PENALTY_DEPT_MIN_DAYS * sl)
                        violation_vars[f"sl_dmn_{res.id}_{dept.id}"] = (
                            sl, (res, dept),
                            f"'{res.name}'→'{dept.name}' below min days ({mn})",
                            "Medium")

                    if mx < 9999:
                        sl = pulp.LpVariable(
                            f"sl_dmx_{res.id}_{dept.id}", lowBound=0)
                        prob += (total_days - sl <= mx,
                                 f"sc_dmxdays_{res.id}_{dept.id}")
                        objective_terms.append(
                            self.PENALTY_DEPT_MAX_DAYS * sl)
                        violation_vars[f"sl_dmx_{res.id}_{dept.id}"] = (
                            sl, (res, dept),
                            f"'{res.name}'→'{dept.name}' exceeds max days ({mx})",
                            "Low")

            prob += pulp.lpSum(objective_terms), "TotalPenalty"

        # ── Solve ─────────────────────────────────────────────────────────
        solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=120)
        status = prob.solve(solver)

        if pulp.LpStatus[prob.status] not in ("Optimal", "Feasible"):
            return None

        # ── Extract solution ───────────────────────────────────────────────
        assignment = {}
        for res in resources:
            for dept in depts:
                for dt in dates:
                    val = pulp.value(x[(res.name, dept.name, dt)])
                    assignment[(res.name, dept.name, dt)] = (
                        1 if val is not None and val > 0.5 else 0)

        # ── Collect violations ─────────────────────────────────────────────
        violations = []
        if soft:
            v_id = 1
            for vkey, (vvar, entity, desc, severity) in violation_vars.items():
                val = pulp.value(vvar)
                if val is not None and val > 0.001:
                    if isinstance(entity, Resource):
                        rname = entity.name
                        dname = "-"
                    elif isinstance(entity, Department):
                        rname = "-"
                        dname = entity.name
                    else:
                        rname = entity[0].name
                        dname = entity[1].name
                    violations.append(Violation(
                        f"V{v_id:03d}", vkey.split("_")[1].upper(),
                        rname, dname, "-",
                        f"{desc}  (shortfall/excess = {val:.1f})",
                        severity))
                    v_id += 1

        total_pen = pulp.value(prob.objective) if soft else 0.0
        return ScheduleResult(
            assignment=assignment,
            violations=violations,
            total_penalty=total_pen or 0.0)

    # ── Alternate generation ─────────────────────────────────────────────────
    def _generate_alternates(self, hard_solutions: List[ScheduleResult]):
        """Generate additional distinct optimal schedules."""
        excluded = [s.assignment for s in hard_solutions]
        max_alt  = self.r.max_alternates

        for i in range(1, max_alt + 1):
            alt = self._solve_model(soft=False, excluded_assignments=excluded)
            if alt is None:
                # No more distinct feasible solutions
                break
            alt.is_feasible = True
            alt.alternate_index = i
            self.results.append(alt)
            excluded.append(alt.assignment)
