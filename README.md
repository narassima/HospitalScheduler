# Timetable Scheduler

A Python-based scheduling system that takes input from an Excel template and produces
an optimised, colour-coded schedule. Designed for scenarios like hospital appointment
scheduling — works for any resource × department × time-horizon combination.

---

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Generate the input template

```bash
python generate_template.py --output my_input.xlsx --resources 10 --depts 4 --start 2026-06-01 --end 2026-06-30
```

### 3. Fill in the template

Open `my_input.xlsx` and fill in each sheet (see **Input Sheets** below).

### 4. Run the scheduler

```bash
python scheduler.py --input my_input.xlsx --output my_schedule.xlsx
```

### 5. Open the output

Open `my_schedule.xlsx` — it contains colour-coded calendar views, summaries,
violations, and alternate schedules.

---

## Demo (sample scenario — 5 doctors / 3 departments / June 2026)

```bash
# Generate and run the sample in one go:
python create_sample_input.py
python scheduler.py --input sample_input.xlsx --output sample_output.xlsx
```

---

## Input Template Sheets

| Sheet | Purpose |
|---|---|
| **Config** | Global settings: number of resources, date range, max alternates |
| **Resources** | Resource names, min/max work hours for the plan period, daily hours |
| **Departments** | Department names, min/max total hours for the plan period |
| **Absence** | Calendar grid — mark days as `Absent` (Sat/Sun pre-filled) |
| **Dept_Mapping** | Feasibility matrix: `1` = can be assigned, `0` = cannot |
| **Dept_MinMax** | Per-resource per-department min/max number of days |
| **Working_Hours** | Reference sheet (daily hours set in Resources sheet) |

---

## Output Sheets

| Sheet | Content |
|---|---|
| **📋 Index** | Overview of all schedules + department colour legend |
| **⚠ Violations** | Constraint violations with type, resource, dept, severity |
| **📅 Schedule** | Colour-coded calendar grid (primary schedule) |
| **📊 Summary_Schedule** | Per-resource hours/days stats + per-dept totals |
| **📅 Alt_1**, **Alt_2** … | Additional feasible schedules (if any) |
| **📊 Summary_Alt_N** | Summary for each alternate |

---

## How Constraints Work

### Hard Constraints (always enforced)
- A resource is assigned to **at most one department per day**
- No assignment on **absent days**
- Assignment only to **feasible departments** (Dept_Mapping = 1)

### Soft Constraints (relaxed if infeasible, logged as violations)
- Resource total work hours within [min, max]
- Department total hours within [min, max]
- Per-resource per-department day counts within [min, max]

### Infeasibility Handling
If the problem cannot be solved with all soft constraints hard, the system:
1. Switches to a **penalty minimisation** approach
2. Finds the schedule that violates constraints by the *least* amount
3. Logs every violation in the **⚠ Violations** sheet with severity and details

### Alternate Schedules
After finding the primary schedule, the solver adds a **no-good cut** to exclude
that exact solution and re-solves to find distinct alternatives (up to the
`Max Alternate Schedules` value set in Config).

---

## Command-Line Reference

### generate_template.py
```
usage: generate_template.py [--output FILE] [--resources N] [--depts N]
                             [--start YYYY-MM-DD] [--end YYYY-MM-DD]

Options:
  --output      Output .xlsx path (default: input_template.xlsx)
  --resources   Number of people/resources (default: 10)
  --depts       Number of departments (default: 4)
  --start       Plan start date (default: first of current month)
  --end         Plan end date (default: last of current month)
```

### scheduler.py
```
usage: scheduler.py --input FILE [--output FILE]

Options:
  --input, -i   Path to filled input template (required)
  --output, -o  Path for output schedule (default: schedule_output.xlsx)
```

---

## Scaling Notes

| Scale | Expected solve time |
|---|---|
| ≤ 10 resources, ≤ 5 depts, ≤ 1 month | < 10 seconds |
| ≤ 20 resources, ≤ 10 depts, ≤ 3 months | 30–120 seconds |
| > 30 resources / > 6 months | May need time limit increase in `solver.py` |

For large problems, increase `timeLimit` in `solver.py → Scheduler._solve_model()`.

---

## Project Files

```
timetable_scheduler/
├── scheduler.py            Main entry point
├── generate_template.py    Creates the blank input template
├── create_sample_input.py  Creates a pre-filled demo file
├── solver.py               ILP constraint model (PuLP)
├── output_writer.py        Formats and writes the output Excel
├── requirements.txt        Python dependencies
└── README.md               This file
```
