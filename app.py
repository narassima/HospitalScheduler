"""
app.py
------
Flask web server for the Timetable Scheduler.

Run:
    python app.py
Then open http://localhost:5000
"""
import sys
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

import io
import uuid
import datetime
import traceback

from flask import Flask, render_template, request, jsonify, send_file

from web_adapter import WebInputAdapter
from solver import Scheduler
from output_writer import OutputWriter

app = Flask(__name__)
app.secret_key = 'timetable-scheduler-2026-secret'

# In-memory session store: session_id -> (reader, results)
_sessions: dict = {}
MAX_SESSIONS = 100


# ─────────────────────────────────────────────────────────────────────────────
# Result serialization
# ─────────────────────────────────────────────────────────────────────────────

def _serialize(reader, results):
    """Convert solver ScheduleResult objects to JSON-serializable dict."""

    meta = {
        'resources': [
            {'id': r.id, 'name': r.name,
             'min_hours': r.min_hours, 'max_hours': r.max_hours,
             'daily_hours': r.daily_hours,
             'min_consecutive': getattr(r, 'min_consecutive', 1)}
            for r in reader.resources
        ],
        'departments': [
            {'id': d.id, 'name': d.name,
             'min_hours': d.min_hours, 'max_hours': d.max_hours}
            for d in reader.departments
        ],
        'dates': [dt.isoformat() for dt in reader.dates],
        'date_labels': [
            {'iso': dt.isoformat(),
             'day': dt.day,
             'dow': dt.strftime('%a'),
             'month': dt.strftime('%b'),
             'is_weekend': dt.weekday() >= 5}
            for dt in reader.dates
        ],
    }

    serialized = []
    for result in results:
        label = 'Schedule' if result.alternate_index == 0 else f'Alt {result.alternate_index}'

        # assignment: res_name -> date_iso -> dept_name | '__absent__' | null
        assignment = {}
        for res in reader.resources:
            assignment[res.name] = {}
            for dt in reader.dates:
                diso = dt.isoformat()
                if reader.absence.get((res.name, dt), False):
                    assignment[res.name][diso] = '__absent__'
                else:
                    dept_name = None
                    for dept in reader.departments:
                        if result.assignment.get((res.name, dept.name, dt), 0) == 1:
                            dept_name = dept.name
                            break
                    assignment[res.name][diso] = dept_name

        # resource summary
        res_summary = []
        for res in reader.resources:
            total_days = sum(
                result.assignment.get((res.name, dept.name, dt), 0)
                for dept in reader.departments for dt in reader.dates)
            total_hours = total_days * res.daily_hours
            absent_days = sum(
                1 for dt in reader.dates
                if reader.absence.get((res.name, dt), False))
            dept_days = {
                dept.name: sum(
                    result.assignment.get((res.name, dept.name, dt), 0)
                    for dt in reader.dates)
                for dept in reader.departments}
            mn, mx = res.min_hours, res.max_hours
            res_summary.append({
                'name': res.name,
                'total_days': total_days,
                'total_hours': total_hours,
                'min_hours': mn,
                'max_hours': mx,
                'absent_days': absent_days,
                'dept_days': dept_days,
                'hours_ok': mn <= total_hours <= mx,
            })

        # dept summary
        dept_summary = []
        for dept in reader.departments:
            total_hours = sum(
                result.assignment.get((res.name, dept.name, dt), 0) * res.daily_hours
                for res in reader.resources for dt in reader.dates)
            dept_summary.append({
                'name': dept.name,
                'total_hours': total_hours,
                'min_hours': dept.min_hours,
                'max_hours': dept.max_hours,
                'ok': dept.min_hours <= total_hours <= dept.max_hours,
            })

        serialized.append({
            'index': result.alternate_index,
            'label': label,
            'is_feasible': result.is_feasible,
            'violations': [
                {'id': v.violation_id, 'type': v.vtype,
                 'resource': v.resource, 'department': v.department,
                 'date': v.date, 'details': v.details, 'severity': v.severity}
                for v in result.violations
            ],
            'assignment': assignment,
            'summary': {'resources': res_summary, 'departments': dept_summary},
        })

    return {'results': serialized, 'meta': meta}


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/generate', methods=['POST'])
def generate():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'success': False, 'error': 'No JSON payload received'}), 400

    try:
        reader = WebInputAdapter(data)
        reader.read()

        scheduler = Scheduler(reader)
        results   = scheduler.solve()

        payload = _serialize(reader, results)

        # Store for potential Excel download
        session_id = uuid.uuid4().hex[:16]
        _sessions[session_id] = (reader, results)
        # Evict oldest if over limit
        while len(_sessions) > MAX_SESSIONS:
            del _sessions[next(iter(_sessions))]

        return jsonify({'success': True, 'session_id': session_id, **payload})

    except Exception as exc:
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(exc)}), 500


@app.route('/api/download/<session_id>')
def download(session_id):
    if session_id not in _sessions:
        return jsonify({'error': 'Session not found or expired — please regenerate.'}), 404

    reader, results = _sessions[session_id]
    buf = io.BytesIO()
    OutputWriter(reader, results).write(buf)
    buf.seek(0)

    filename = f'schedule_{datetime.date.today().isoformat()}.xlsx'
    return send_file(
        buf,
        download_name=filename,
        as_attachment=True,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('=' * 55)
    print('  Timetable Scheduler  --  Web Application')
    print('  Open:  http://localhost:5000')
    print('=' * 55)
    app.run(debug=True, host='0.0.0.0', port=5000)
