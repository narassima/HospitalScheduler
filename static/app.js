/* ════════════════════════════════════════════════════════════
   TimetableAI — app.js
   Full SPA logic: step wizard, API calls, results rendering
   ════════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────────────────────
// Dept colour palette (must match CSS variables)
// ─────────────────────────────────────────────────────────────
const DEPT_COLORS = [
  '#3b82f6','#f97316','#22c55e','#eab308',
  '#a855f7','#06b6d4','#ef4444','#14b8a6',
  '#f43f5e','#8b5cf6','#0ea5e9','#84cc16',
];
const DEPT_TEXT = [
  '#fff','#1a1a1a','#1a1a1a','#1a1a1a',
  '#fff','#1a1a1a','#fff','#1a1a1a',
  '#fff','#fff','#fff','#1a1a1a',
];

// ─────────────────────────────────────────────────────────────
// Client-side Heuristic Constraint Solver (JSSolver)
// ─────────────────────────────────────────────────────────────
const JSSolver = {
  solve(payload) {
    const config = payload.config;
    const resources = payload.resources;
    const departments = payload.departments;
    const absence = payload.absence;
    const mapping = payload.mapping;
    const dept_minmax = payload.dept_minmax;

    // Parse dates
    const start = new Date(config.start_date + 'T00:00:00');
    const end = new Date(config.end_date + 'T00:00:00');
    const dates = [];
    const dateLabels = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const isWE = d.getDay() === 0 || d.getDay() === 6;
      dates.push(iso);
      dateLabels.push({
        iso,
        day: d.getDate(),
        dow: ['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()],
        month: d.toLocaleString('default', { month: 'short' }),
        is_weekend: isWE
      });
    }

    const maxAlts = config.max_alternates !== undefined ? config.max_alternates : 3;
    const results = [];

    for (let alt = 0; alt <= maxAlts; alt++) {
      const solution = this._optimize(resources, departments, dates, absence, mapping, dept_minmax, alt);
      results.push(solution);
    }

    const meta = {
      resources,
      departments,
      dates,
      date_labels: dateLabels
    };

    return { success: true, session_id: 'local_session_' + Date.now(), results, meta };
  },

  _optimize(resources, departments, dates, absence, mapping, dept_minmax, altIndex) {
    const assignment = {};
    resources.forEach(r => {
      assignment[r.name] = {};
      dates.forEach(d => {
        const isAbs = absence[r.name] && absence[r.name][d] === true;
        assignment[r.name][d] = isAbs ? '__absent__' : null;
      });
    });

    const activeDates = dates;
    const deptNames = departments.map(d => d.name);

    const canAssign = (rname, dname, d) => {
      if (absence[rname] && absence[rname][d] === true) return false;
      if (mapping[rname] && mapping[rname][dname] === 0) return false;
      return true;
    };

    // Initial Heuristic Allocation
    resources.forEach(r => {
      const allowedDepts = deptNames.filter(dname => canAssign(r.name, dname));
      if (allowedDepts.length === 0) return;

      let consecutiveLeft = 0;
      let currentDept = null;

      activeDates.forEach(d => {
        if (absence[r.name] && absence[r.name][d] === true) {
          consecutiveLeft = 0;
          currentDept = null;
          return;
        }

        if (consecutiveLeft > 0 && currentDept && canAssign(r.name, currentDept, d)) {
          assignment[r.name][d] = currentDept;
          consecutiveLeft--;
        } else {
          const seed = Math.random();
          if (seed < 0.75) {
            const deptIndex = Math.floor(Math.random() * allowedDepts.length);
            const dept = allowedDepts[deptIndex];
            assignment[r.name][d] = dept;
            consecutiveLeft = r.min_consecutive - 1;
            currentDept = dept;
          } else {
            assignment[r.name][d] = null;
            consecutiveLeft = 0;
            currentDept = null;
          }
        }
      });
    });

    // Local Search Optimization (Hill Climbing / Iterative Repair)
    let bestAssignment = JSON.parse(JSON.stringify(assignment));
    let bestPenalty = this._calcPenalty(bestAssignment, resources, departments, dates, mapping, dept_minmax);

    let currentAssignment = JSON.parse(JSON.stringify(bestAssignment));
    let currentPenalty = bestPenalty;

    const maxSteps = 15000;
    for (let step = 0; step < maxSteps; step++) {
      if (currentPenalty === 0) break;

      const res = resources[Math.floor(Math.random() * resources.length)];
      const date = dates[Math.floor(Math.random() * dates.length)];

      if (absence[res.name] && absence[res.name][date] === true) continue;

      const allowedDepts = deptNames.filter(dname => canAssign(res.name, dname, date));
      const choices = [null, ...allowedDepts];
      const prevVal = currentAssignment[res.name][date];
      const newVal = choices[Math.floor(Math.random() * choices.length)];

      if (prevVal === newVal) continue;

      const changes = [];
      changes.push({ rname: res.name, d: date, old: prevVal, new: newVal });

      if (res.min_consecutive > 1 && newVal !== null) {
        const dateIdx = dates.indexOf(date);
        for (let k = 1; k < res.min_consecutive; k++) {
          if (dateIdx + k < dates.length) {
            const nextDate = dates[dateIdx + k];
            if (!(absence[res.name] && absence[res.name][nextDate] === true)) {
              changes.push({ rname: res.name, d: nextDate, old: currentAssignment[res.name][nextDate], new: newVal });
            }
          }
        }
      }

      changes.forEach(c => { currentAssignment[c.rname][c.d] = c.new; });

      const newPenalty = this._calcPenalty(currentAssignment, resources, departments, dates, mapping, dept_minmax);

      // Diversity penalty for alternate index
      let altPenalty = 0;
      if (altIndex > 0) {
        // Soft diversity penalty
      }

      if (newPenalty + altPenalty <= currentPenalty) {
        currentPenalty = newPenalty + altPenalty;
        if (currentPenalty < bestPenalty) {
          bestPenalty = currentPenalty;
          bestAssignment = JSON.parse(JSON.stringify(currentAssignment));
        }
      } else {
        changes.forEach(c => { currentAssignment[c.rname][c.d] = c.old; });
      }
    }

    // Populate summaries & violations
    const violations = [];
    const resSummary = [];
    const deptSummary = [];

    resources.forEach(r => {
      let totalDays = 0;
      const deptDays = {};
      departments.forEach(d => { deptDays[d.name] = 0; });

      dates.forEach(d => {
        const val = bestAssignment[r.name][d];
        if (val && val !== '__absent__') {
          totalDays++;
          deptDays[val] = (deptDays[val] || 0) + 1;
        }
      });

      const totalHours = totalDays * r.daily_hours;
      const mn = r.min_hours;
      const mx = r.max_hours;
      const hoursOk = totalHours >= mn && totalHours <= mx;
      const absentDays = dates.filter(d => absence[r.name] && absence[r.name][d] === true).length;

      resSummary.push({
        name: r.name,
        total_days: totalDays,
        total_hours: totalHours,
        min_hours: mn,
        max_hours: mx,
        absent_days: absentDays,
        dept_days: deptDays,
        hours_ok: hoursOk
      });

      if (totalHours < mn) {
        violations.push({
          id: `V_RES_MIN_${r.id}`,
          type: "Resource Min Hours",
          resource: r.name,
          department: "-",
          date: "-",
          details: `Resource worked ${totalHours} hours (minimum required: ${mn} hours).`,
          severity: "Medium"
        });
      }
      if (totalHours > mx) {
        violations.push({
          id: `V_RES_MAX_${r.id}`,
          type: "Resource Max Hours",
          resource: r.name,
          department: "-",
          date: "-",
          details: `Resource worked ${totalHours} hours (maximum allowed: ${mx} hours).`,
          severity: "Medium"
        });
      }

      let consecutiveCount = 0;
      let lastDept = null;
      dates.forEach((d, idx) => {
        const val = bestAssignment[r.name][d];
        if (val !== lastDept) {
          if (lastDept && lastDept !== '__absent__' && consecutiveCount < r.min_consecutive) {
            violations.push({
              id: `V_CONSEC_${r.id}_${idx}`,
              type: "Consecutive Days Block",
              resource: r.name,
              department: lastDept,
              date: dates[idx - consecutiveCount],
              details: `Assignment of ${r.name} to ${lastDept} lasted only ${consecutiveCount} consecutive days (minimum required: ${r.min_consecutive}).`,
              severity: "Low"
            });
          }
          lastDept = val;
          consecutiveCount = 1;
        } else {
          consecutiveCount++;
        }
      });
      if (lastDept && lastDept !== '__absent__' && consecutiveCount < r.min_consecutive) {
        violations.push({
          id: `V_CONSEC_${r.id}_end`,
          type: "Consecutive Days Block",
          resource: r.name,
          department: lastDept,
          date: dates[dates.length - consecutiveCount],
          details: `Assignment of ${r.name} to ${lastDept} lasted only ${consecutiveCount} consecutive days at the end of schedule (minimum required: ${r.min_consecutive}).`,
          severity: "Low"
        });
      }
    });

    departments.forEach(dept => {
      let totalHours = 0;
      resources.forEach(r => {
        dates.forEach(d => {
          if (bestAssignment[r.name][d] === dept.name) {
            totalHours += r.daily_hours;
          }
        });
      });

      const ok = totalHours >= dept.min_hours && totalHours <= dept.max_hours;
      deptSummary.push({
        name: dept.name,
        total_hours: totalHours,
        min_hours: dept.min_hours,
        max_hours: dept.max_hours,
        ok
      });

      if (totalHours < dept.min_hours) {
        violations.push({
          id: `V_DEPT_MIN_${dept.id}`,
          type: "Dept Min Hours",
          resource: "-",
          department: dept.name,
          date: "-",
          details: `Department total coverage is ${totalHours} hours (minimum required: ${dept.min_hours} hours).`,
          severity: "High"
        });
      }
      if (totalHours > dept.max_hours) {
        violations.push({
          id: `V_DEPT_MAX_${dept.id}`,
          type: "Dept Max Hours",
          resource: "-",
          department: dept.name,
          date: "-",
          details: `Department total coverage is ${totalHours} hours (maximum allowed: ${dept.max_hours} hours).`,
          severity: "High"
        });
      }
    });

    resources.forEach(r => {
      departments.forEach(dept => {
        const mm = dept_minmax[r.name] ? dept_minmax[r.name][dept.name] : null;
        if (mm) {
          let days = 0;
          dates.forEach(d => {
            if (bestAssignment[r.name][d] === dept.name) days++;
          });
          if (days < mm.min) {
            violations.push({
              id: `V_DEPT_MM_MIN_${r.id}_${dept.id}`,
              type: "Dept Min Days per Resource",
              resource: r.name,
              department: dept.name,
              date: "-",
              details: `Resource ${r.name} scheduled for ${days} days in ${dept.name} (minimum required: ${mm.min} days).`,
              severity: "Medium"
            });
          }
          if (days > mm.max) {
            violations.push({
              id: `V_DEPT_MM_MAX_${r.id}_${dept.id}`,
              type: "Dept Max Days per Resource",
              resource: r.name,
              department: dept.name,
              date: "-",
              details: `Resource ${r.name} scheduled for ${days} days in ${dept.name} (maximum allowed: ${mm.max} days).`,
              severity: "Medium"
            });
          }
        }
      });
    });

    return {
      alternate_index: altIndex,
      label: altIndex === 0 ? "Schedule" : `Alt ${altIndex}`,
      is_feasible: violations.length === 0,
      violations,
      assignment: bestAssignment,
      summary: {
        resources: resSummary,
        departments: deptSummary
      }
    };
  },

  _calcPenalty(assignment, resources, departments, dates, mapping, dept_minmax) {
    let penalty = 0;

    resources.forEach(r => {
      let days = 0;
      dates.forEach(d => {
        const val = assignment[r.name][d];
        if (val && val !== '__absent__') days++;
      });
      const hrs = days * r.daily_hours;
      if (hrs < r.min_hours) penalty += (r.min_hours - hrs) * 10;
      if (hrs > r.max_hours) penalty += (hrs - r.max_hours) * 10;

      let consecutiveCount = 0;
      let lastDept = null;
      dates.forEach(d => {
        const val = assignment[r.name][d];
        if (val !== lastDept) {
          if (lastDept && lastDept !== '__absent__' && consecutiveCount < r.min_consecutive) {
            penalty += (r.min_consecutive - consecutiveCount) * 15;
          }
          lastDept = val;
          consecutiveCount = 1;
        } else {
          consecutiveCount++;
        }
      });
      if (lastDept && lastDept !== '__absent__' && consecutiveCount < r.min_consecutive) {
        penalty += (r.min_consecutive - consecutiveCount) * 15;
      }
    });

    departments.forEach(dept => {
      let hrs = 0;
      resources.forEach(r => {
        dates.forEach(d => {
          if (assignment[r.name][d] === dept.name) hrs += r.daily_hours;
        });
      });
      if (hrs < dept.min_hours) penalty += (dept.min_hours - hrs) * 5;
      if (hrs > dept.max_hours) penalty += (hrs - dept.max_hours) * 5;
    });

    resources.forEach(r => {
      departments.forEach(dept => {
        const mm = dept_minmax[r.name] ? dept_minmax[r.name][dept.name] : null;
        if (mm) {
          let days = 0;
          dates.forEach(d => {
            if (assignment[r.name][d] === dept.name) days++;
          });
          if (days < mm.min) penalty += (mm.min - days) * 8;
          if (days > mm.max) penalty += (days - mm.max) * 8;
        }
      });
    });

    return penalty;
  }
};

// ─────────────────────────────────────────────────────────────
// Tooltip Manager (JS-driven, immune to viewport overflow/clipping)
// ─────────────────────────────────────────────────────────────
const TooltipManager = {
  el: null,
  init() {
    let el = document.getElementById('global-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-tooltip';
      el.className = 'global-tooltip';
      document.body.appendChild(el);
    }
    this.el = el;

    document.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('.info-btn');
      if (btn) this.show(btn);
    });

    document.addEventListener('mouseout', (e) => {
      const btn = e.target.closest('.info-btn');
      if (btn) this.hide();
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.info-btn');
      if (btn) {
        e.stopPropagation();
        this.show(btn);
      } else {
        this.hide();
      }
    });
  },

  show(btn) {
    const text = btn.getAttribute('data-tip');
    if (!text) return;

    this.el.textContent = text;
    this.el.classList.add('show');

    const rect = btn.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    const btnCenterX = rect.left + rect.width / 2;
    
    let left = btnCenterX - this.el.offsetWidth / 2;
    let top = rect.top - this.el.offsetHeight - 8;

    const margin = 12;
    const viewportWidth = window.innerWidth;
    
    if (left < margin) {
      left = margin;
    } else if (left + this.el.offsetWidth > viewportWidth - margin) {
      left = viewportWidth - this.el.offsetWidth - margin;
    }

    if (top < margin) {
      top = rect.bottom + 8;
    }

    this.el.style.left = (left + scrollX) + 'px';
    this.el.style.top = (top + scrollY) + 'px';
  },

  hide() {
    if (this.el) this.el.classList.remove('show');
  }
};

// ─────────────────────────────────────────────────────────────
// App state
// ─────────────────────────────────────────────────────────────
const App = {
  step: 1,
  maxStep: 6,
  sessionId: null,
  results: null,
  meta: null,
  activeTab: 0,

  // ── Initialise ────────────────────────────────────────────
  init() {
    TooltipManager.init();

    // Set default dates (current month)
    const now  = new Date();
    const y    = now.getFullYear();
    const m    = now.getMonth();
    const pad  = n => String(n).padStart(2, '0');
    const firstDay = `${y}-${pad(m + 1)}-01`;
    const lastDay  = new Date(y, m + 1, 0);
    const lastISO  = `${y}-${pad(m + 1)}-${pad(lastDay.getDate())}`;
    document.getElementById('cfg-start').value = firstDay;
    document.getElementById('cfg-end').value   = lastISO;

    // Load saved theme or default to Light Theme
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this._updateThemeIcon(savedTheme);

    this.onTimeUnitChange();
    this.goToStep(1);
  },

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    this._updateThemeIcon(newTheme);
  },

  _updateThemeIcon(theme) {
    const icon = document.getElementById('theme-icon');
    if (!icon) return;
    if (theme === 'dark') {
      icon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
    } else {
      icon.innerHTML = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
    }
  },

  getTimeUnit() {
    return document.getElementById('cfg-time-unit')?.value || 'Hours';
  },

  onTimeUnitChange() {
    const unit = this.getTimeUnit();
    const resMinh = document.getElementById('th-res-minh');
    const resMaxh = document.getElementById('th-res-maxh');
    const resDaily = document.getElementById('th-res-daily');
    const deptMinh = document.getElementById('th-dept-minh');
    const deptMaxh = document.getElementById('th-dept-maxh');

    if (resMinh) resMinh.innerHTML = `Min Work ${unit} <span class="tip">(period)</span> <span class="info-btn" data-tip="The minimum cumulative work time this resource must be scheduled for across the entire planning period.">i</span>`;
    if (resMaxh) resMaxh.innerHTML = `Max Work ${unit} <span class="tip">(period)</span> <span class="info-btn" data-tip="The maximum cumulative work time this resource can be scheduled for across the entire planning period.">i</span>`;
    if (resDaily) resDaily.innerHTML = `Daily Work ${unit} <span class="info-btn" data-tip="The standard capacity allocation scheduled for this resource on a single assigned day.">i</span>`;
    if (deptMinh) deptMinh.innerHTML = `Min Total ${unit} <span class="tip">(period)</span> <span class="info-btn" data-tip="The minimum total coverage time required for this department. Indicates the total number of days/hours for which the department should be functional.">i</span>`;
    if (deptMaxh) deptMaxh.innerHTML = `Max Total ${unit} <span class="tip">(period)</span> <span class="info-btn" data-tip="The maximum total coverage time allowed for this department.">i</span>`;

    // Toggle working day hours input group
    const showHours = (unit === 'Hours' || unit === 'Minutes');
    const groupEl = document.getElementById('cfg-working-day-hours-group');
    if (groupEl) groupEl.style.display = showHours ? 'block' : 'none';

    // Toggle time conversion input group for sessions, slots, shifts
    const showConversion = (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts');
    const conversionEl = document.getElementById('cfg-time-conversion-group');
    if (conversionEl) {
      conversionEl.style.display = showConversion ? 'block' : 'none';
      const labelEl = document.getElementById('cfg-time-conversion-label');
      if (labelEl) {
        const singularMap = { 'Sessions': 'Session', 'Slots': 'Slot', 'Shifts': 'Shift' };
        const singular = singularMap[unit] || 'Session';
        labelEl.innerHTML = `Hours per ${singular} <span class="tip">(for exact time conversion)</span> <span class="info-btn" data-tip="The exact conversion factor used to map sessions, slots, or shifts to hours for absolute capacity limits.">i</span>`;
      }
    }

    // Auto-scale values if transitioning unit
    if (!this.prevUnit) this.prevUnit = 'Hours';
    if (this.prevUnit !== unit) {
      const workingDayHours = parseFloat(document.getElementById('cfg-working-day-hours')?.value) || 8;
      
      let prevToHours = 1;
      if (this.prevUnit === 'Minutes') prevToHours = 1 / 60;
      else if (this.prevUnit === 'Days') prevToHours = workingDayHours;
      else if (this.prevUnit === 'Sessions' || this.prevUnit === 'Slots' || this.prevUnit === 'Shifts') {
        const factor = parseFloat(document.getElementById('cfg-time-conversion')?.value) || 2.0;
        prevToHours = factor;
      }
      
      let hoursToNew = 1;
      if (unit === 'Minutes') hoursToNew = 60;
      else if (unit === 'Days') hoursToNew = 1 / workingDayHours;
      else if (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts') {
        const factor = parseFloat(document.getElementById('cfg-time-conversion')?.value) || 2.0;
        hoursToNew = 1 / factor;
      }
      
      const multiplier = prevToHours * hoursToNew;
      
      if (this.resources) {
        this.resources.forEach(r => {
          r.minh = Math.round(r.minh * multiplier * 10) / 10;
          if (r.maxh < 9999) r.maxh = Math.round(r.maxh * multiplier * 10) / 10;
          r.daily = Math.round(r.daily * multiplier * 10) / 10;
        });
      }
      
      if (this.departments) {
        this.departments.forEach(d => {
          d.minh = Math.round(d.minh * multiplier * 10) / 10;
          if (d.maxh < 9999) d.maxh = Math.round(d.maxh * multiplier * 10) / 10;
        });
      }
      
      this.prevUnit = unit;
    }
  },

  // ── Step navigation ───────────────────────────────────────
  goToStep(n) {
    document.querySelectorAll('.step-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.step-item').forEach(si => {
      si.classList.remove('active');
      const num = parseInt(si.id.replace('si-',''));
      si.classList.toggle('done', num < n);
    });

    const page = document.getElementById(`page-${n}`);
    if (page) page.classList.add('active');

    const si = document.getElementById(`si-${n}`);
    if (si) si.classList.add('active');

    this.step = n;
    this._buildStep(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  tryGoToStep(n) {
    if (n <= this.step) this.goToStep(n);
  },

  nextStep() {
    if (!this._validateStep(this.step)) return;
    if (this.step < this.maxStep) this.goToStep(this.step + 1);
  },

  prevStep() {
    if (this.step > 1) this.goToStep(this.step - 1);
  },

  // ── Build dynamic step content ────────────────────────────
  _buildStep(n) {
    if (n === 2) this._buildResources();
    else if (n === 3) this._buildDepts();
    else if (n === 4) this._buildAbsence();
    else if (n === 5) this._buildMapping();
    else if (n === 6) this._buildMinMax();
  },

  // ── Step validation ───────────────────────────────────────
  _validateStep(n) {
    if (n === 1) {
      const startEl = document.getElementById('cfg-start');
      const endEl   = document.getElementById('cfg-end');
      
      const start = startEl ? startEl.value.trim() : '';
      const end   = endEl ? endEl.value.trim() : '';
      
      console.log('Verifying date inputs:', { start, end });
      
      if (!start || !end) {
        this._toast('Please enter start and end dates', 'error');
        return false;
      }
      
      if (new Date(end) < new Date(start)) {
        this._toast('End date must be after start date', 'error');
        return false;
      }
    }
    if (n === 2) {
      const names = [...document.querySelectorAll('.res-name')].map(i => i.value.trim());
      if (names.some(n => !n)) { this._toast('All resource names are required', 'error'); return false; }
      if (new Set(names).size !== names.length) { this._toast('Resource names must be unique', 'error'); return false; }
    }
    if (n === 3) {
      const names = [...document.querySelectorAll('.dept-name')].map(i => i.value.trim());
      if (names.some(n => !n)) { this._toast('All department names are required', 'error'); return false; }
      if (new Set(names).size !== names.length) { this._toast('Department names must be unique', 'error'); return false; }
    }
    return true;
  },

  // ── STEP 2: Resources ─────────────────────────────────────
  _buildResources() {
    this.onTimeUnitChange();
    if (!this.resources) {
      const unit = this.getTimeUnit();
      if (unit === 'Minutes') {
        this.resources = [{ name: 'Dr. Smith', minh: 4800, maxh: 10560, daily: 480, consecutive: 1 }];
      } else if (unit === 'Days') {
        this.resources = [{ name: 'Dr. Smith', minh: 10, maxh: 22, daily: 1, consecutive: 1 }];
      } else if (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts') {
        this.resources = [{ name: 'Dr. Smith', minh: 40, maxh: 88, daily: 4, consecutive: 1 }];
      } else { // Hours
        this.resources = [{ name: 'Dr. Smith', minh: 80, maxh: 176, daily: 8, consecutive: 1 }];
      }
    } else {
      this._syncResourcesFromDOM();
    }
    this._renderResourcesTable();
  },

  _syncResourcesFromDOM() {
    const tbody = document.getElementById('resources-body');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    this.resources = [...rows].map(tr => ({
      name: tr.querySelector('.res-name')?.value.trim() || '',
      minh: parseFloat(tr.querySelector('.res-minh')?.value) || 0,
      maxh: parseFloat(tr.querySelector('.res-maxh')?.value) || 9999,
      daily: parseFloat(tr.querySelector('.res-daily')?.value) || 8,
      consecutive: parseInt(tr.querySelector('.res-consecutive')?.value) || 1,
    }));
  },

  _renderResourcesTable() {
    const tbody = document.getElementById('resources-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const unit = this.getTimeUnit();
    const isDays = unit === 'Days';
    const defaultDailyVal = (unit === 'Hours' || unit === 'Minutes') ? (parseFloat(document.getElementById('cfg-working-day-hours')?.value) || 8) : 1;

    this.resources.forEach((r, idx) => {
      const tr = document.createElement('tr');
      const dailyVal = isDays ? 1 : (r.daily || defaultDailyVal);
      const disableDaily = isDays ? 'disabled style="opacity: 0.5; pointer-events: none;"' : '';

      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td><input type="text" class="res-name" placeholder="e.g. Dr. Smith" value="${r.name}" /></td>
        <td><input type="number" class="res-minh" value="${r.minh}" min="0" /></td>
        <td><input type="number" class="res-maxh" value="${r.maxh}" min="0" /></td>
        <td><input type="number" class="res-daily" value="${dailyVal}" min="1" max="24" ${disableDaily} /></td>
        <td><input type="number" class="res-consecutive" value="${r.consecutive || 1}" min="1" max="30" /></td>
        <td>
          <button class="btn-icon" onclick="App.deleteResourceRow(${idx})" title="Delete" style="color: var(--danger); background: none; border: none; cursor: pointer; padding: 4px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </button>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  addResourceRow() {
    this._syncResourcesFromDOM();
    this.resources.push({ name: '', minh: 80, maxh: 176, daily: 8, consecutive: 1 });
    this._renderResourcesTable();
  },

  deleteResourceRow(idx) {
    this._syncResourcesFromDOM();
    if (this.resources.length <= 1) {
      this._toast('You must have at least one resource', 'error');
      return;
    }
    this.resources.splice(idx, 1);
    this._renderResourcesTable();
  },

  // ── STEP 3: Departments ───────────────────────────────────
  _buildDepts() {
    this.onTimeUnitChange();
    if (!this.departments) {
      const unit = this.getTimeUnit();
      if (unit === 'Minutes') {
        this.departments = [{ name: 'Cardiology', minh: 6000, maxh: 30000 }];
      } else if (unit === 'Days') {
        this.departments = [{ name: 'Cardiology', minh: 12, maxh: 60 }];
      } else if (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts') {
        this.departments = [{ name: 'Cardiology', minh: 50, maxh: 250 }];
      } else { // Hours
        this.departments = [{ name: 'Cardiology', minh: 100, maxh: 500 }];
      }
    } else {
      this._syncDeptsFromDOM();
    }
    this._renderDeptsTable();
  },

  _syncDeptsFromDOM() {
    const tbody = document.getElementById('depts-body');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    this.departments = [...rows].map(tr => ({
      name: tr.querySelector('.dept-name')?.value.trim() || '',
      minh: parseFloat(tr.querySelector('.dept-minh')?.value) || 0,
      maxh: parseFloat(tr.querySelector('.dept-maxh')?.value) || 9999,
    }));
  },

  _renderDeptsTable() {
    const tbody = document.getElementById('depts-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    this.departments.forEach((d, idx) => {
      const color = DEPT_COLORS[idx % DEPT_COLORS.length];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${color};margin-right:6px;vertical-align:middle"></span>${idx + 1}</td>
        <td><input type="text" class="dept-name" placeholder="e.g. Cardiology" value="${d.name}" /></td>
        <td><input type="number" class="dept-minh" value="${d.minh}" min="0" /></td>
        <td><input type="number" class="dept-maxh" value="${d.maxh}" min="0" /></td>
        <td>
          <button class="btn-icon" onclick="App.deleteDeptRow(${idx})" title="Delete" style="color: var(--danger); background: none; border: none; cursor: pointer; padding: 4px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </button>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  addDeptRow() {
    this._syncDeptsFromDOM();
    this.departments.push({ name: '', minh: 100, maxh: 500 });
    this._renderDeptsTable();
  },

  deleteDeptRow(idx) {
    this._syncDeptsFromDOM();
    if (this.departments.length <= 1) {
      this._toast('You must have at least one department', 'error');
      return;
    }
    this.departments.splice(idx, 1);
    this._renderDeptsTable();
  },

  // ── STEP 4: Absence Calendar ──────────────────────────────
  _buildAbsence() {
    const start  = new Date(document.getElementById('cfg-start').value + 'T00:00:00');
    const end    = new Date(document.getElementById('cfg-end').value   + 'T00:00:00');
    const resNames = [...document.querySelectorAll('.res-name')].map(i => i.value.trim() || `Resource ${i}`);
    const container = document.getElementById('absence-calendar');

    // Collect existing absence state
    const prevState = {};
    container.querySelectorAll('.cal-cell').forEach(cell => {
      prevState[cell.dataset.key] = cell.classList.contains('absent');
    });
    container.innerHTML = '';

    // Generate dates array
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(new Date(d));
    }

    // Group dates by month for header
    const months = {};
    dates.forEach(d => {
      const mk = d.toISOString().slice(0, 7);
      months[mk] = (months[mk] || 0) + 1;
    });

    // Build table
    const table = document.createElement('table');
    table.className = 'cal-table';
    table.style.padding = '12px 16px';

    // Month header row
    const mRow = document.createElement('tr');
    mRow.innerHTML = `<th style="min-width:160px;text-align:left">Resource</th>`;
    Object.entries(months).forEach(([mk, cnt]) => {
      const th = document.createElement('th');
      th.colSpan = cnt;
      th.className = 'month-hdr';
      th.textContent = new Date(mk + '-01').toLocaleString('default', { month: 'long', year: 'numeric' });
      mRow.appendChild(th);
    });
    table.appendChild(mRow);

    // Date header row
    const dRow = document.createElement('tr');
    dRow.innerHTML = `<th></th>`;
    dates.forEach(d => {
      const th = document.createElement('th');
      const isWE = d.getDay() === 0 || d.getDay() === 6;
      if (isWE) th.style.color = '#ef4444';
      const span = document.createElement('span');
      span.className = 'cal-date-header';
      span.textContent = `${['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()]} ${d.getDate()}`;
      th.appendChild(span);
      dRow.appendChild(th);
    });
    table.appendChild(dRow);

    // Resource rows
    resNames.forEach(rname => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.className = 'res-name';
      td0.textContent = rname;
      tr.appendChild(td0);

      dates.forEach(d => {
        const isWE   = d.getDay() === 0 || d.getDay() === 6;
        const diso   = d.toISOString().slice(0, 10);
        const key    = `${rname}|${diso}`;
        const isAbs  = prevState[key] !== undefined ? prevState[key] : isWE;

        const td = document.createElement('td');
        td.className = 'cal-cell' + (isWE ? ' weekend' : '') + (isAbs ? ' absent' : ' available');
        td.dataset.key    = key;
        td.dataset.rname  = rname;
        td.dataset.date   = diso;
        td.dataset.absent = isAbs ? '1' : '0';
        td.title = `${rname} — ${diso}`;
        td.addEventListener('mousedown', (e) => App._handleAbsenceCellMouseDown(td, isWE, e));
        td.addEventListener('mouseenter', () => App._handleAbsenceCellMouseEnter(td, isWE));
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });

    container.appendChild(table);
  },

  _lastClickedCell: null,
  _isDragging: false,
  _dragPaintState: null,
  _dragResource: null,
  _globalMouseUpBound: null,

  _handleAbsenceCellClick(td, isWE, event) {
    const rname = td.dataset.rname;
    const date = td.dataset.date;
    
    if (event && event.shiftKey && this._lastClickedCell && this._lastClickedCell.rname === rname) {
      const row = td.closest('tr');
      const cells = [...row.querySelectorAll('.cal-cell')];
      const idx1 = cells.findIndex(c => c.dataset.date === this._lastClickedCell.date);
      const idx2 = cells.findIndex(c => c.dataset.date === date);
      
      if (idx1 !== -1 && idx2 !== -1) {
        const startIdx = Math.min(idx1, idx2);
        const endIdx = Math.max(idx1, idx2);
        
        const targetState = this._lastClickedCell.toggledTo;
        for (let i = startIdx; i <= endIdx; i++) {
          const cell = cells[i];
          cell.dataset.absent = targetState ? '1' : '0';
          cell.classList.toggle('absent', targetState);
          cell.classList.toggle('available', !targetState);
        }
        
        this._lastClickedCell = { rname, date, toggledTo: targetState };
        return;
      }
    }
    
    const isAbs = td.dataset.absent === '1';
    const nowAbs = !isAbs;
    td.dataset.absent = nowAbs ? '1' : '0';
    td.classList.toggle('absent', nowAbs);
    td.classList.toggle('available', !nowAbs);
    
    this._lastClickedCell = { rname, date, toggledTo: nowAbs };
  },

  _handleAbsenceCellMouseDown(td, isWE, event) {
    if (event.button !== 0) return; // Only left click
    event.preventDefault(); 
    
    this._isDragging = true;
    const rname = td.dataset.rname;
    this._dragResource = rname;
    
    const isAbs = td.dataset.absent === '1';
    const nowAbs = !isAbs;
    this._dragPaintState = nowAbs;
    
    this._handleAbsenceCellClick(td, isWE, event);
    
    if (!this._globalMouseUpBound) {
      this._globalMouseUpBound = this._handleAbsenceGlobalMouseUp.bind(this);
      window.addEventListener('mouseup', this._globalMouseUpBound);
    }
  },

  _handleAbsenceCellMouseEnter(td, isWE) {
    if (!this._isDragging || this._dragResource !== td.dataset.rname) return;
    
    const targetState = this._dragPaintState;
    td.dataset.absent = targetState ? '1' : '0';
    td.classList.toggle('absent', targetState);
    td.classList.toggle('available', !targetState);
    
    this._lastClickedCell = { rname: td.dataset.rname, date: td.dataset.date, toggledTo: targetState };
  },

  _handleAbsenceGlobalMouseUp() {
    this._isDragging = false;
    this._dragResource = null;
    this._dragPaintState = null;
  },

  bulkAbsence(action) {
    document.querySelectorAll('.cal-cell').forEach(td => {
      const dt = new Date(td.dataset.date + 'T00:00:00');
      const isSat = dt.getDay() === 6;
      const isSun = dt.getDay() === 0;
      const isWE = isSat || isSun;

      let setAbs = td.dataset.absent === '1';
      if (action === 'weekends') {
        if (isWE) setAbs = true;
      } else if (action === 'saturdays') {
        if (isSat) setAbs = true;
      } else if (action === 'sundays') {
        if (isSun) setAbs = true;
      } else if (action === 'allow_saturdays') {
        if (isSat) setAbs = false;
      } else if (action === 'allow_sundays') {
        if (isSun) setAbs = false;
      } else if (action === 'clear') {
        setAbs = false;
      }

      td.dataset.absent = setAbs ? '1' : '0';
      td.classList.toggle('absent', setAbs);
      td.classList.toggle('available', !setAbs);
    });
  },

  // ── STEP 5: Mapping Matrix ────────────────────────────────
  mappingState: null,
  minMaxState: null,

  _syncMappingAndMinMaxStates() {
    if (document.getElementById('resources-body')?.children.length > 0) {
      this._syncResourcesFromDOM();
    }
    if (document.getElementById('depts-body')?.children.length > 0) {
      this._syncDeptsFromDOM();
    }

    if (!this.resources) {
      const unit = this.getTimeUnit();
      if (unit === 'Minutes') this.resources = [{ name: 'Dr. Smith', minh: 4800, maxh: 10560, daily: 480, consecutive: 1 }];
      else if (unit === 'Days') this.resources = [{ name: 'Dr. Smith', minh: 10, maxh: 22, daily: 1, consecutive: 1 }];
      else if (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts') this.resources = [{ name: 'Dr. Smith', minh: 40, maxh: 88, daily: 4, consecutive: 1 }];
      else this.resources = [{ name: 'Dr. Smith', minh: 80, maxh: 176, daily: 8, consecutive: 1 }];
    }
    if (!this.departments) {
      const unit = this.getTimeUnit();
      if (unit === 'Minutes') this.departments = [{ name: 'Cardiology', minh: 6000, maxh: 30000 }];
      else if (unit === 'Days') this.departments = [{ name: 'Cardiology', minh: 12, maxh: 60 }];
      else if (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts') this.departments = [{ name: 'Cardiology', minh: 50, maxh: 250 }];
      else this.departments = [{ name: 'Cardiology', minh: 100, maxh: 500 }];
    }

    const resNames = this.resources.map(r => r.name.trim()).filter(Boolean);
    const deptNames = this.departments.map(d => d.name.trim()).filter(Boolean);
    
    if (!this.mappingState) this.mappingState = {};
    if (!this.minMaxState) this.minMaxState = {};
    
    const newMapping = {};
    const newMinMax = {};
    
    resNames.forEach(rname => {
      newMapping[rname] = {};
      newMinMax[rname] = {};
      deptNames.forEach(dname => {
        const oldMap = (this.mappingState[rname] && this.mappingState[rname][dname] !== undefined)
          ? this.mappingState[rname][dname] 
          : true;
        newMapping[rname][dname] = oldMap;
        
        const oldMinMax = (this.minMaxState[rname] && this.minMaxState[rname][dname] !== undefined)
          ? this.minMaxState[rname][dname]
          : { min: '0', max: '999' };
        newMinMax[rname][dname] = oldMinMax;
      });
    });
    
    this.mappingState = newMapping;
    this.minMaxState = newMinMax;
  },

  _buildMapping() {
    this._syncMappingAndMinMaxStates();
    const resNames  = Object.keys(this.mappingState);
    const container = document.getElementById('mapping-matrix');
    container.innerHTML = '';

    if (resNames.length === 0) return;
    const deptNames = Object.keys(this.mappingState[resNames[0]] || {});

    const table = document.createElement('table');
    table.className = 'mapping-table';

    // Header
    const hRow = document.createElement('tr');
    hRow.innerHTML = `<th>Resource \\ Department</th>`;
    deptNames.forEach((d, di) => {
      const th = document.createElement('th');
      th.style.textAlign = 'center';
      th.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${DEPT_COLORS[di % DEPT_COLORS.length]};margin-right:5px;vertical-align:middle"></span>${d}`;
      hRow.appendChild(th);
    });
    table.appendChild(hRow);

    // Rows
    resNames.forEach(rname => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.textContent = rname;
      td0.style.fontWeight = '600';
      tr.appendChild(td0);

      deptNames.forEach(dname => {
        const isOn = this.mappingState[rname][dname];
        const td = document.createElement('td');
        td.innerHTML = `<div class="toggle-wrap"><div class="toggle ${isOn ? 'on' : ''}" data-res="${rname}" data-dept="${dname}" onclick="App._toggleMap(this)"></div></div>`;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });

    container.appendChild(table);
  },

  _toggleMap(el) {
    el.classList.toggle('on');
    const rname = el.dataset.res;
    const dname = el.dataset.dept;
    const isOn = el.classList.contains('on');
    if (!this.mappingState[rname]) this.mappingState[rname] = {};
    this.mappingState[rname][dname] = isOn;
  },

  // ── STEP 6: MinMax Days ───────────────────────────────────
  _buildMinMax() {
    this._syncMappingAndMinMaxStates();
    const resNames = Object.keys(this.minMaxState);
    const tbody    = document.getElementById('minmax-body');
    tbody.innerHTML = '';

    if (resNames.length === 0) return;
    const deptNames = Object.keys(this.minMaxState[resNames[0]] || {});

    resNames.forEach((rname, ri) => {
      deptNames.forEach((dname, di) => {
        const allowed = this.mappingState[rname][dname];
        if (!allowed) return;

        const p = this.minMaxState[rname][dname];
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${DEPT_COLORS[ri % DEPT_COLORS.length]};margin-right:6px;vertical-align:middle"></span>${rname}</td>
          <td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${DEPT_COLORS[di % DEPT_COLORS.length]};margin-right:6px;vertical-align:middle"></span>${dname}</td>
          <td><input type="number" class="mm-min" value="${p.min}" min="0" style="width:80px" oninput="App._updateMinMaxState(this, '${rname.replace(/'/g, "\\'")}', '${dname.replace(/'/g, "\\'")}', 'min')" /></td>
          <td><input type="number" class="mm-max" value="${p.max}" min="0" style="width:80px" oninput="App._updateMinMaxState(this, '${rname.replace(/'/g, "\\'")}', '${dname.replace(/'/g, "\\'")}', 'max')" /></td>`;
        tbody.appendChild(tr);
      });
    });
  },

  _updateMinMaxState(el, rname, dname, field) {
    if (!this.minMaxState[rname]) this.minMaxState[rname] = {};
    if (!this.minMaxState[rname][dname]) this.minMaxState[rname][dname] = { min: '0', max: '999' };
    this.minMaxState[rname][dname][field] = el.value || '0';
  },

  _collectPayload() {
    const start     = document.getElementById('cfg-start').value;
    const end       = document.getElementById('cfg-end').value;
    const maxAlt    = parseInt(document.getElementById('cfg-max-alt')?.value || 3);
    const unit      = this.getTimeUnit();
    const multiplier = (unit === 'Sessions' || unit === 'Slots' || unit === 'Shifts') ? (parseFloat(document.getElementById('cfg-time-conversion')?.value) || 1.0) : 1.0;

    const resRows   = document.querySelectorAll('#resources-body tr');
    const deptRows  = document.querySelectorAll('#depts-body tr');

    const resources = [...resRows].map((tr, i) => {
      const rawDaily = parseFloat(tr.querySelector('.res-daily')?.value) || 1.0;
      return {
        id: i + 1,
        name:       tr.querySelector('.res-name').value.trim(),
        min_hours:  parseFloat(tr.querySelector('.res-minh').value) || 0,
        max_hours:  parseFloat(tr.querySelector('.res-maxh').value) || 9999,
        daily_hours: rawDaily * multiplier,
        min_consecutive: parseInt(tr.querySelector('.res-consecutive')?.value) || 1,
      };
    });

    const departments = [...deptRows].map((tr, i) => ({
      id: i + 1,
      name:      tr.querySelector('.dept-name').value.trim(),
      min_hours: parseFloat(tr.querySelector('.dept-minh').value) || 0,
      max_hours: parseFloat(tr.querySelector('.dept-maxh').value) || 9999,
    }));

    const absence = {};
    document.querySelectorAll('.cal-cell').forEach(td => {
      const rname = td.dataset.rname;
      const date  = td.dataset.date;
      if (!absence[rname]) absence[rname] = {};
      absence[rname][date] = td.dataset.absent === '1';
    });

    // Clean up mapping and minmax states to only match current valid resources/depts
    this._syncMappingAndMinMaxStates();

    const mapping = {};
    Object.keys(this.mappingState).forEach(rname => {
      mapping[rname] = {};
      Object.keys(this.mappingState[rname]).forEach(dname => {
        mapping[rname][dname] = this.mappingState[rname][dname] ? 1 : 0;
      });
    });

    const dept_minmax = {};
    Object.keys(this.minMaxState).forEach(rname => {
      dept_minmax[rname] = {};
      Object.keys(this.minMaxState[rname]).forEach(dname => {
        const allowed = this.mappingState[rname][dname];
        dept_minmax[rname][dname] = {
          min: allowed ? parseInt(this.minMaxState[rname][dname].min || 0) : 0,
          max: allowed ? parseInt(this.minMaxState[rname][dname].max || 999) : 9999,
        };
      });
    });

    return {
      config: { start_date: start, end_date: end, max_alternates: maxAlt,
                n_resources: resources.length, n_depts: departments.length },
      resources, departments, absence, mapping, dept_minmax,
    };
  },


  // ── Generate schedule ─────────────────────────────────────
  async generate() {
    if (!this._validateStep(6)) return;

    const payload = this._collectPayload();

    // Show loading
    document.querySelectorAll('.step-page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-loading').classList.add('active');
    document.getElementById('nav-status').textContent = 'Solving…';
    document.getElementById('nav-status').className = 'nav-status solving';

    // Animate loading steps
    const loadSteps = document.querySelectorAll('.load-step');
    let lsi = 0;
    const lInterval = setInterval(() => {
      if (lsi > 0) loadSteps[lsi - 1]?.classList.replace('active', 'done');
      if (lsi < loadSteps.length) loadSteps[lsi]?.classList.add('active');
      lsi++;
    }, 400);

    // Check if we are running in a static environment (like GitHub Pages or file://)
    const isStaticEnv = window.location.hostname.includes('github.io') || window.location.protocol === 'file:';

    if (isStaticEnv) {
      console.log('[JSSolver] Static environment detected — running client-side constraint solver.');
      setTimeout(() => {
        try {
          const data = JSSolver.solve(payload);
          clearInterval(lInterval);
          this.sessionId = data.session_id;
          this.results   = data.results;
          this.meta      = data.meta;
          this._renderResults();
        } catch (err) {
          clearInterval(lInterval);
          this._showError(`Client-side Solver Error: ${err.message}`);
        }
      }, 1000);
      return;
    }

    try {
      const resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      clearInterval(lInterval);

      if (!data.success) {
        this._showError(data.error || 'Unknown server error');
        return;
      }

      this.sessionId = data.session_id;
      this.results   = data.results;
      this.meta      = data.meta;

      this._renderResults();

    } catch (err) {
      console.warn('[JSSolver] Backend unavailable — falling back to client-side constraint solver.', err);
      // Fallback solve
      setTimeout(() => {
        try {
          const data = JSSolver.solve(payload);
          clearInterval(lInterval);
          this.sessionId = data.session_id;
          this.results   = data.results;
          this.meta      = data.meta;
          this._renderResults();
        } catch (fallbackErr) {
          clearInterval(lInterval);
          this._showError(`Solver Failure: ${fallbackErr.message}`);
        }
      }, 1000);
    }
  },

  _showError(msg) {
    document.querySelectorAll('.step-page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-6').classList.add('active');
    document.getElementById('nav-status').textContent = 'Error';
    document.getElementById('nav-status').className = 'nav-status';
    this._toast(msg, 'error');
  },

  // ── Render results ────────────────────────────────────────
  _renderResults() {
    const results = this.results;
    const meta    = this.meta;

    // Update nav
    document.getElementById('nav-status').textContent = 'Done';
    document.getElementById('nav-status').className = 'nav-status done';
    document.getElementById('btn-download').style.display = 'flex';

    // Overall status
    const allFeasible = results.every(r => r.is_feasible);
    const totalViol   = results.reduce((s, r) => s + r.violations.length, 0);
    const statusEl    = document.getElementById('results-status');
    if (allFeasible) {
      statusEl.innerHTML = `<span class="badge-feasible">✓ Fully Feasible</span>
        <span style="color:var(--text-2);font-size:14px">${results.length} schedule(s) generated</span>`;
    } else {
      statusEl.innerHTML = `<span class="badge-warn">⚠ ${totalViol} Violation(s)</span>
        <span style="color:var(--text-2);font-size:14px">Best-effort schedule with ${totalViol} relaxed constraint(s)</span>`;
    }

    // Build tabs
    const tabBar = document.getElementById('result-tabs');
    const content = document.getElementById('result-content');
    tabBar.innerHTML = '';
    content.innerHTML = '';

    results.forEach((result, idx) => {
      // Tab button
      const tab = document.createElement('div');
      tab.className = 'result-tab' + (idx === 0 ? ' active' : '');
      tab.id = `tab-${idx}`;
      tab.onclick = () => this._showTab(idx);
      const badgeClass = result.is_feasible ? 'ok' : 'err';
      const badgeText  = result.is_feasible ? 'OK' : `${result.violations.length} violation(s)`;
      tab.innerHTML = `${result.label} <span class="tab-badge ${badgeClass}">${badgeText}</span>`;
      tabBar.appendChild(tab);

      // Tab content
      const panel = document.createElement('div');
      panel.className = 'result-tab-content' + (idx === 0 ? ' active' : '');
      panel.id = `panel-${idx}`;
      panel.innerHTML = this._buildTabContent(result, meta);
      content.appendChild(panel);
    });

    // Show results page
    document.querySelectorAll('.step-page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-results').classList.add('active');
    document.querySelectorAll('.step-item').forEach(si => {
      si.classList.remove('active');
      si.classList.add('done');
    });
  },

  _showTab(idx) {
    document.querySelectorAll('.result-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
    document.querySelectorAll('.result-tab-content').forEach((p, i) => p.classList.toggle('active', i === idx));
    this.activeTab = idx;
  },

  // ── Build one tab panel ───────────────────────────────────
  _buildTabContent(result, meta) {
    const depts = meta.departments;
    const resources = meta.resources;

    // ── Stats row
    const totalAssigned = Object.values(result.assignment).reduce((s, days) =>
      s + Object.values(days).filter(v => v && v !== '__absent__').length, 0);
    const totalAbsent   = Object.values(result.assignment).reduce((s, days) =>
      s + Object.values(days).filter(v => v === '__absent__').length, 0);
    const violations    = result.violations;

    let statsHtml = `<div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Status</div>
        <div class="stat-value" style="font-size:18px;color:${result.is_feasible ? 'var(--success)' : 'var(--warning)'}">
          ${result.is_feasible ? '✓ Feasible' : '⚠ Violations'}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Assignments</div>
        <div class="stat-value" style="color:var(--blue)">${totalAssigned}</div>
        <div class="stat-sub">person-days scheduled</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Absent Days</div>
        <div class="stat-value" style="color:var(--text-3)">${totalAbsent}</div>
        <div class="stat-sub">across all resources</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Violations</div>
        <div class="stat-value" style="color:${violations.length ? 'var(--danger)' : 'var(--success)'}">
          ${violations.length}
        </div>
        <div class="stat-sub">constraint violations</div>
      </div>
    </div>`;

    // ── Schedule calendar
    const calHtml = this._buildCalendar(result, meta);

    // ── Resource summary
    const resSumHtml = this._buildResourceSummary(result, meta);

    // ── Dept summary
    const deptSumHtml = this._buildDeptSummary(result, meta);

    // ── Violations
    const violHtml = violations.length ? this._buildViolations(violations) : '';

    return statsHtml + calHtml + resSumHtml + deptSumHtml + violHtml;
  },

  // ── Calendar grid ─────────────────────────────────────────
  _buildCalendar(result, meta) {
    const dates     = meta.date_labels;
    const resources = meta.resources;
    const depts     = meta.departments;
    const deptMap   = {};
    depts.forEach((d, i) => { deptMap[d.name] = i; });

    // Month grouping
    const months = {};
    dates.forEach(d => {
      const mk = d.iso.slice(0, 7);
      months[mk] = (months[mk] || 0) + 1;
    });

    let html = `<div class="section-title">Schedule Calendar</div>`;
    
    // Premium Legend Card placed above the grid
    html += `<div class="calendar-legend-card" style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; background: var(--bg-card); border: 1px solid var(--border); padding: 12px 16px; border-radius: var(--radius); align-items: center;">`;
    html += `<span style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-2); letter-spacing: 0.5px; margin-right: 6px;">Color Codes:</span>`;
    depts.forEach((d, i) => {
      const bg = DEPT_COLORS[i % DEPT_COLORS.length];
      html += `<span class="dept-legend-pill" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; background: ${bg}15; border: 1px solid ${bg}40; font-size: 11px; font-weight: 600; color: ${bg};">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${bg};"></span>
        ${d.name} (${d.name.slice(0, 3).toUpperCase()})
      </span>`;
    });
    // Absent
    html += `<span class="dept-legend-pill" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; background: rgba(148, 163, 184, 0.08); border: 1px dashed rgba(255,255,255,0.1); font-size: 11px; font-weight: 600; color: var(--text-2);">
      <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); border: 1px solid rgba(255,255,255,0.15)"></span>
      Absent (A)
    </span>`;
    // Unassigned / NA
    html += `<span class="dept-legend-pill" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; background: rgba(255,255,255,0.02); border: 1px solid var(--border); font-size: 11px; font-weight: 600; color: var(--text-3);">
      <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: transparent; border: 1px solid var(--text-3);"></span>
      Unassigned / N/A (·)
    </span>`;
    html += `</div>`;

    html += `<div class="sched-wrap"><table class="sched-table"><thead>`;

    // Month header
    html += `<tr><th class="res-cell" style="min-width:150px">Resource</th>`;
    Object.entries(months).forEach(([mk, cnt]) => {
      const label = new Date(mk + '-01').toLocaleString('default', { month: 'short', year: 'numeric' });
      html += `<th class="month-col" colspan="${cnt}">${label}</th>`;
    });
    html += '</tr>';

    // Date header
    html += `<tr><th class="res-cell"></th>`;
    dates.forEach(d => {
      const style = d.is_weekend ? 'color:#ef4444' : '';
      html += `<th style="${style}">${d.day}<br/><span style="color:var(--text-3);font-size:8px">${d.dow}</span></th>`;
    });
    html += '</tr></thead><tbody>';

    // Resource rows
    resources.forEach(res => {
      html += `<tr><td class="res-cell">${res.name}</td>`;
      dates.forEach(d => {
        const val = result.assignment[res.name]?.[d.iso];
        if (val === '__absent__') {
          const cls = d.is_weekend ? ' weekend-day' : '';
          html += `<td class="sched-cell absent-day${cls}" title="${res.name} — ${d.iso} — Absent"><span class="sched-bar absent">A</span></td>`;
        } else if (val) {
          const di  = deptMap[val] ?? 0;
          const bg  = DEPT_COLORS[di % DEPT_COLORS.length];
          const fg  = DEPT_TEXT[di % DEPT_TEXT.length];
          const abbr = val.slice(0, 3).toUpperCase();
          html += `<td class="sched-cell" title="${res.name} — ${d.iso} — ${val}"><span class="sched-bar" style="background:${bg};color:${fg};box-shadow: 0 3px 8px ${bg}35">${abbr}</span></td>`;
        } else {
          const cls = d.is_weekend ? ' weekend-day' : ' unassigned';
          html += `<td class="sched-cell${cls}" title="${res.name} — ${d.iso} — Unassigned"><span class="sched-bar unassigned">·</span></td>`;
        }
      });
      html += '</tr>';
    });

    html += `</tbody></table></div>`;
    return html;
  },

  // ── Resource summary ──────────────────────────────────────
  _buildResourceSummary(result, meta) {
    const depts = meta.departments;
    const unit  = this.getTimeUnit();
    let html = `<div class="section-title">Resource Summary</div>
    <table class="summary-table"><thead><tr>
      <th>Resource</th>
      <th>Work Days</th>
      <th>Work ${unit}</th>
      <th>Absent Days</th>`;
    depts.forEach((d, i) => {
      const bg = DEPT_COLORS[i % DEPT_COLORS.length];
      html += `<th><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${bg};margin-right:4px;vertical-align:middle"></span>${d.name}</th>`;
    });
    html += `<th>Status</th></tr></thead><tbody>`;

    result.summary.resources.forEach(r => {
      const pct = r.max_hours > 0 ? Math.min(100, (r.total_hours / r.max_hours) * 100) : 0;
      const barClass = r.hours_ok ? 'ok' : 'err';
      html += `<tr>
        <td style="font-weight:600">${r.name}</td>
        <td>${r.total_days}</td>
        <td>
          ${r.total_hours} ${unit.toLowerCase()}
          <div class="progress-bar-wrap" style="margin-top:4px">
            <div class="progress-bar ${barClass}" style="width:${pct}%"></div>
          </div>
          <div style="font-size:10px;color:var(--text-3)">min ${r.min_hours} ${unit.toLowerCase()} / max ${r.max_hours} ${unit.toLowerCase()}</div>
        </td>
        <td>${r.absent_days}</td>`;
      depts.forEach(d => {
        html += `<td style="text-align:center">${r.dept_days[d.name] ?? 0}</td>`;
      });
      html += `<td>${r.hours_ok ? '<span class="badge-ok">✓ OK</span>' : '<span class="badge-err">✗ Violation</span>'}</td></tr>`;
    });
    html += '</tbody></table>';
    return html;
  },

  // ── Department summary ────────────────────────────────────
  _buildDeptSummary(result, meta) {
    const unit  = this.getTimeUnit();
    let html = `<div class="section-title">Department Summary</div>
    <table class="summary-table"><thead><tr>
      <th>Department</th><th>Total ${unit}</th><th>Min Required</th><th>Max Allowed</th><th>Coverage</th><th>Status</th>
    </tr></thead><tbody>`;

    result.summary.departments.forEach((d, i) => {
      const bg = DEPT_COLORS[i % DEPT_COLORS.length];
      const pct = d.max_hours > 0 && d.max_hours < 9999
        ? Math.min(100, (d.total_hours / d.max_hours) * 100)
        : d.min_hours > 0 ? Math.min(100, (d.total_hours / d.min_hours) * 100) : 50;
      const barClass = d.ok ? 'ok' : 'err';
      html += `<tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${bg};margin-right:8px;vertical-align:middle"></span><strong>${d.name}</strong></td>
        <td>${d.total_hours} ${unit.toLowerCase()}</td>
        <td>${d.min_hours} ${unit.toLowerCase()}</td>
        <td>${d.max_hours >= 9999 ? '∞' : d.max_hours + ' ' + unit.toLowerCase()}</td>
        <td style="min-width:120px">
          <div class="progress-bar-wrap"><div class="progress-bar ${barClass}" style="width:${pct}%"></div></div>
          <div style="font-size:10px;color:var(--text-3);margin-top:2px">${d.total_hours} ${unit.toLowerCase()} of ${d.min_hours} ${unit.toLowerCase()} min</div>
        </td>
        <td>${d.ok ? '<span class="badge-ok">✓ OK</span>' : '<span class="badge-err">✗ Violation</span>'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    return html;
  },

  // ── Violations table ──────────────────────────────────────
  _buildViolations(violations) {
    const sevClass = { High: 'sev-high', Medium: 'sev-med', Low: 'sev-low' };
    let html = `<div class="violations-section">
    <div class="section-title" style="color:var(--danger)">Constraint Violations</div>
    <table class="viol-table"><thead><tr>
      <th>ID</th><th>Type</th><th>Resource</th><th>Department</th><th>Details</th><th>Severity</th>
    </tr></thead><tbody>`;
    violations.forEach(v => {
      html += `<tr>
        <td>${v.id}</td>
        <td>${v.type}</td>
        <td>${v.resource !== '-' ? v.resource : '—'}</td>
        <td>${v.department !== '-' ? v.department : '—'}</td>
        <td style="max-width:360px;line-height:1.4">${v.details}</td>
        <td class="${sevClass[v.severity] || ''}">${v.severity}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    return html;
  },

  // ── Excel download ────────────────────────────────────────
  downloadExcel() {
    if (!this.sessionId) { this._toast('No session — please generate first', 'error'); return; }
    window.location.href = `/api/download/${this.sessionId}`;
    this._toast('Excel download started', 'success');
  },

  // ── Toast notification ────────────────────────────────────
  _toast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast ${type} show`;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3500);
  },
};

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());
