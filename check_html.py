import sys
with open('timetable_scheduler.html', encoding='utf-8') as f:
    html = f.read()

checks = [
    ('DOCTYPE', '<!DOCTYPE html>' in html),
    ('SheetJS CDN', 'sheetjs.com' in html),
    ('TimetableSolver class', 'class TimetableSolver' in html),
    ('ExcelExporter class', 'class ExcelExporter' in html),
    ('App object', 'const App' in html),
    ('All 6 step pages', all(f'id="page{i}"' in html for i in range(1,7))),
    ('Results page', 'id="pageRes"' in html),
    ('Loading page', 'id="pageLoad"' in html),
    ('Solver._run method', '_run(' in html),
    ('Local search repair', 'Local Search Repair' in html),
    ('Excel export', 'XLSX.writeFile' in html),
    ('Absence calendar', 'calWrap' in html),
    ('Mapping matrix', 'mapWrap' in html),
    ('Dept mapping', 'mapWrap' in html),
    ('MinMax table', 'mmTbody' in html),
]
all_ok = True
for name, ok in checks:
    s = 'OK' if ok else 'MISSING'
    if not ok: all_ok = False
    print(f'  [{s}] {name}')

print(f'\nFile size: {len(html)//1024} KB')
print('All checks passed!' if all_ok else 'SOME CHECKS FAILED')
sys.exit(0 if all_ok else 1)
