import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidateCsvQuestions, parseCsvRows, parseSpecialTags, getSampleCsvTemplate } from './mcq-engine.ts';

test('Excel BOM, separator directives, and friendly column headings import correctly', () => {
  const cells = parseCsvRows(getSampleCsvTemplate());
  const encode = (row: string[]) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(';');
  cells[0] = cells[0].map((h) => h.replace(/_/g, ' '));
  const report = parseAndValidateCsvQuestions('\uFEFFsep=;\r\n' + cells.map(encode).join('\r\n'));
  assert.deepEqual(report.headerErrors, []);
  assert.equal(report.validCount, cells.length - 1);
});

test('rejects broken quotes and duplicate normalized headers before import', () => {
  for (const source of ['a,b\n"unclosed,b', 'a,b\n"closed"oops,b', 'question_text,Question Text\nx,y']) {
    const report = parseAndValidateCsvQuestions(source);
    assert.equal(report.validCount, 0);
    assert.ok(report.headerErrors.length > 0);
  }
});

test('quoted multiline explanations and escaped quotes remain intact', () => {
  assert.deepEqual(parseCsvRows('a,b\n"line 1\nline 2 ""quoted""",value'), [['a','b'], ['line 1\nline 2 "quoted"','value']]);
});

test('rows with extra fields are rejected instead of silently shifting columns', () => {
  const source = getSampleCsvTemplate().split('\n');
  source[1] += ',unexpected';
  const report = parseAndValidateCsvQuestions(source.join('\n'));
  assert.ok(report.rows[0].errors.some((error) => error.includes('columns')));
  assert.equal(report.rows[0].isValid, false);
});

test('tag entry supports Arabic punctuation, pipes, semicolons and case-insensitive deduplication', () => {
  assert.deepEqual(parseSpecialTags(' Important ; important| كتاب  القسم،Old Exams,, '), ['Important', 'كتاب القسم', 'Old Exams']);
  assert.deepEqual(parseSpecialTags('Old Exam, Old Exams, old_exam'), ['Old Exam']);
});
