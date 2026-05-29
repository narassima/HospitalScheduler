"""
scheduler.py
------------
Main entry point for the Timetable Scheduler.

Workflow:
  1. Read the filled input template (Excel)
  2. Solve the scheduling problem
  3. Write the output schedule (Excel)

Usage:
    python scheduler.py --input input_template.xlsx --output schedule_output.xlsx
"""
import sys
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

import argparse
import time

from solver import InputReader, Scheduler
from output_writer import OutputWriter


def main():
    parser = argparse.ArgumentParser(
        description="Timetable Scheduler — generates optimised schedules from an Excel template.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate a blank input template first:
  python generate_template.py --output my_input.xlsx --resources 5 --depts 3

  # Run the scheduler on a filled template:
  python scheduler.py --input my_input.xlsx --output my_schedule.xlsx
""")
    parser.add_argument(
        "--input",  "-i",
        required=True,
        help="Path to the filled input template Excel file")
    parser.add_argument(
        "--output", "-o",
        default="schedule_output.xlsx",
        help="Path for the output schedule Excel file (default: schedule_output.xlsx)")
    args = parser.parse_args()

    print("=" * 60)
    print("  TIMETABLE SCHEDULER")
    print("=" * 60)

    # ── Step 1: Read inputs ──────────────────────────────────────────────────
    print(f"\n📂  Reading input template: {args.input}")
    reader = InputReader(args.input)
    try:
        reader.read()
    except ValueError as e:
        print(f"\n❌  Input errors found:\n{e}")
        sys.exit(1)

    print(f"    Resources   : {len(reader.resources)}")
    print(f"    Departments : {len(reader.departments)}")
    print(f"    Plan period : {reader.dates[0]}  →  {reader.dates[-1]}"
          f"  ({len(reader.dates)} days)")

    # ── Step 2: Solve ────────────────────────────────────────────────────────
    print(f"\n🔧  Running scheduler (this may take a moment) …")
    t0 = time.time()
    scheduler = Scheduler(reader)
    results   = scheduler.solve()
    elapsed   = time.time() - t0

    print(f"    Solver time : {elapsed:.1f}s")
    print(f"    Solutions   : {len(results)}")

    for res in results:
        label = ("Primary" if res.alternate_index == 0
                 else f"Alternate #{res.alternate_index}")
        status = "✅ Fully feasible" if res.is_feasible else "⚠  Violations present"
        print(f"    {label:15s}: {status}  ({len(res.violations)} violation(s))")

    # ── Step 3: Write output ─────────────────────────────────────────────────
    print(f"\n📝  Writing output → {args.output}")
    writer = OutputWriter(reader, results)
    writer.write(args.output)

    # ── Step 4: Summary ──────────────────────────────────────────────────────
    all_violations = [v for r in results for v in r.violations]
    if all_violations:
        print(f"\n⚠   {len(all_violations)} violation(s) recorded — "
              f"see the '⚠ Violations' sheet in {args.output}")
        high = [v for v in all_violations if v.severity == "High"]
        if high:
            print(f"    High-severity violations:")
            for v in high:
                print(f"      [{v.violation_id}] {v.details}")
    else:
        print("\n✅  All constraints satisfied — schedule is fully feasible!")

    print("\n" + "=" * 60)
    print(f"  Done!  Open:  {args.output}")
    print("=" * 60)


if __name__ == "__main__":
    main()
