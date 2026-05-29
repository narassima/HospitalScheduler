"""
web_adapter.py
--------------
Converts JSON/dict input (from the web UI) into the same InputReader data
structures used by Scheduler, bypassing Excel file parsing entirely.
"""
import sys
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

import datetime
from solver import InputReader, Resource, Department


class WebInputAdapter(InputReader):
    """
    Subclass of InputReader whose read() method populates data from a Python
    dict (JSON posted from the web UI) instead of an Excel file.
    """

    def __init__(self, data: dict):
        self.path = None
        self._web_data = data
        # InputReader data structures
        self.resources = []
        self.departments = []
        self.dates = []
        self.absence = {}
        self.mapping = {}
        self.dept_minmax = {}
        self._errors = []
        self.max_alternates = 3

    def read(self):
        self._parse_config()
        self._parse_resources()
        self._parse_departments()
        self._parse_absence()
        self._parse_mapping()
        self._parse_dept_minmax()
        if self._errors:
            raise ValueError("Input errors:\n" + "\n".join(f"  - {e}" for e in self._errors))

    # ── Config ────────────────────────────────────────────────────────────────
    def _parse_config(self):
        cfg = self._web_data.get('config', {})
        try:
            start = datetime.date.fromisoformat(cfg['start_date'])
            end   = datetime.date.fromisoformat(cfg['end_date'])
        except (KeyError, ValueError) as exc:
            self._errors.append(f"Config: invalid dates — {exc}")
            return
        if end < start:
            self._errors.append("Config: end date is before start date")
            return
        d = start
        while d <= end:
            self.dates.append(d)
            d += datetime.timedelta(days=1)
        self.max_alternates = max(0, int(cfg.get('max_alternates', 3)))

    # ── Resources ─────────────────────────────────────────────────────────────
    def _parse_resources(self):
        for i, item in enumerate(self._web_data.get('resources', []), 1):
            name = str(item.get('name', '')).strip()
            if not name:
                self._errors.append(f"Resource {i}: name is required")
                continue
            try:
                self.resources.append(Resource(
                    id=i,
                    name=name,
                    min_hours=float(item.get('min_hours', 0)),
                    max_hours=float(item.get('max_hours', 9999)),
                    daily_hours=float(item.get('daily_hours', 8)),
                    min_consecutive=int(item.get('min_consecutive', 1)),
                ))
            except (ValueError, TypeError) as exc:
                self._errors.append(f"Resource '{name}': {exc}")

    # ── Departments ───────────────────────────────────────────────────────────
    def _parse_departments(self):
        for i, item in enumerate(self._web_data.get('departments', []), 1):
            name = str(item.get('name', '')).strip()
            if not name:
                self._errors.append(f"Department {i}: name is required")
                continue
            try:
                self.departments.append(Department(
                    id=i,
                    name=name,
                    min_hours=float(item.get('min_hours', 0)),
                    max_hours=float(item.get('max_hours', 9999)),
                ))
            except (ValueError, TypeError) as exc:
                self._errors.append(f"Department '{name}': {exc}")

    # ── Absence ───────────────────────────────────────────────────────────────
    def _parse_absence(self):
        # Format: {"Resource Name": {"YYYY-MM-DD": true|false, ...}, ...}
        for rname, dates in self._web_data.get('absence', {}).items():
            for date_str, is_absent in dates.items():
                try:
                    dt = datetime.date.fromisoformat(date_str)
                    self.absence[(rname.strip(), dt)] = bool(is_absent)
                except ValueError:
                    pass

    # ── Mapping ───────────────────────────────────────────────────────────────
    def _parse_mapping(self):
        # Format: {"Resource Name": {"Dept Name": 1|0, ...}, ...}
        for rname, depts in self._web_data.get('mapping', {}).items():
            for dname, val in depts.items():
                self.mapping[(rname.strip(), dname.strip())] = (int(val) == 1)

    # ── Dept MinMax ───────────────────────────────────────────────────────────
    def _parse_dept_minmax(self):
        # Format: {"Resource Name": {"Dept Name": {"min": 0, "max": 999}, ...}, ...}
        for rname, depts in self._web_data.get('dept_minmax', {}).items():
            for dname, mm in depts.items():
                try:
                    mn = int(mm.get('min', 0))
                    mx = int(mm.get('max', 9999))
                    self.dept_minmax[(rname.strip(), dname.strip())] = (mn, mx)
                except (TypeError, ValueError):
                    pass
