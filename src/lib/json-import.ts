import { computeContentHash, parseAndValidateCsvQuestions, parseSpecialTags, type CsvValidationReport, type ParsedCsvQuestionRow } from './mcq-engine.ts';
import { MAX_IMPORT_IMAGES, validImageFileName, type ImportImageFile, type QuestionImage } from './question-images.ts';
import { expandMatchingQuestion, type MatchingQuestionDefinition } from './matching-questions.ts';
import {parseShortAnswerBatch,type ShortAnswerDefinition} from './short-answer-model.ts';

export interface JsonQuestionRow extends ParsedCsvQuestionRow {
  imageFiles: Array<{ file: string; alt: string }>;
  explanationImageFiles: Array<{ file: string; alt: string }>;
  images?: QuestionImage[];
  explanationImages?: QuestionImage[];
  matching?: MatchingQuestionDefinition;
  shortAnswerDefinition?:ShortAnswerDefinition;
}
export interface JsonValidationReport extends Omit<CsvValidationReport, 'rows'> {
  rows: JsonQuestionRow[];
  referencedImages: string[];
  unusedImages: string[];
}
const columns = ['subject','lecture','question_text','option_a','option_b','option_c','option_d','correct_answer','explanation','explanation_a','explanation_b','explanation_c','explanation_d','difficulty','tags','special_tags','page_number','status'];
const allowed = new Set([...columns, 'options', 'images', 'explanation_images']);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Uses the same field rules as manual/legacy imports, without coercing malformed JSON values. */
export function parseAndValidateJsonQuestions(content: string, existingHashes = new Set<string>(),
  context?: { defaultSubject?: string; defaultLecture?: string }, files: ImportImageFile[] = []): JsonValidationReport {
  const report: JsonValidationReport = {fileHash:computeContentHash(content), totalRows:0, validCount:0, duplicateCount:0, invalidCount:0, rows:[], headerErrors:[], referencedImages:[], unusedImages:[]};
  let root: any;
  try { root = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch (error) { report.headerErrors.push(`Invalid JSON: ${error instanceof Error ? error.message : 'check commas and quotes'}`); return report; }
  const entries = Array.isArray(root) ? root : root?.questions;
  if (!Array.isArray(entries) || !entries.length || entries.length > 2000) {
    report.headerErrors.push('Use a JSON array, or an object with a questions array containing 1–2,000 questions.'); return report;
  }
  if (!Array.isArray(root)) {
    if (!object(root) || Object.keys(root).some(k => !['questions','subject','lecture','version'].includes(k))) report.headerErrors.push('Top-level fields may only be questions, subject, lecture, and version.');
    for (const key of ['subject','lecture']) if (root[key] !== undefined && typeof root[key] !== 'string') report.headerErrors.push(`${key} must be text.`);
  }
  const manifest = new Map<string, string>();
  if (!Array.isArray(files) || files.length > MAX_IMPORT_IMAGES) { report.headerErrors.push(`Select at most ${MAX_IMPORT_IMAGES} image files.`); return report; }
  for (const f of files) {
    if (!object(f) || typeof f.name !== 'string' || !validImageFileName(f.name) || typeof f.id !== 'string' || !/^[a-f0-9]{64}$/.test(f.id) || manifest.has(f.name)) {
      report.headerErrors.push('Image files must have unique filenames, PNG/JPEG/WebP extensions, and valid SHA-256 identifiers.'); return report;
    }
    manifest.set(f.name, f.id);
  }
  if (report.headerErrors.length) return report;
  let expanded: Array<{entry:any;matching?:MatchingQuestionDefinition;shortAnswerDefinition?:ShortAnswerDefinition}> = [];
  for (const [index,entry] of entries.entries()) {
    if (entry?.question_type === 'matching') {
      try {
        for (const key of Object.keys(entry)) if (!allowed.has(key) && !['question_type','matches','distractors'].includes(key)) throw new Error(`Unknown field "${key}".`);
        if (['options','option_a','option_b','option_c','option_d','correct_answer'].some(key=>key in entry)) throw new Error('Matching questions use matches and distractors, not MCQ options.');
        const groupId=computeContentHash(JSON.stringify([entry.question_text,entry.matches,entry.distractors,
          entry.images?.map((image:any)=>manifest.get(typeof image==='string'?image:image.file))]));
        expanded.push(...expandMatchingQuestion(entry,groupId));
      } catch(error) {report.headerErrors.push(`Matching image ${index+1}: ${(error as Error).message}`);}
    } else if(entry?.question_type==='short_answer'){
      try{
        const extra=['subject','lecture','difficulty','special_tags','page_number'];const clean=Object.fromEntries(Object.entries(entry).filter(([key])=>!extra.includes(key)));
        const [{imageFiles,...definition}]=parseShortAnswerBatch(JSON.stringify({questions:[clean]}));
        expanded.push({shortAnswerDefinition:definition,entry:{...Object.fromEntries(extra.filter(key=>key in entry).map(key=>[key,entry[key]])),question_text:definition.question_text,options:{A:'Written response',B:'Graded against model answer',C:'No multiple-choice options',D:'Short answer'},correct_answer:'A',explanation:'Written answer graded against the saved marking guide.',tags:definition.tags,status:definition.status,images:entry.images||[]}});
      }catch(error){report.headerErrors.push(`Short answer ${index+1}: ${(error as Error).message}`);}
    } else if(entry?.question_type&&entry.question_type!=='mcq')report.headerErrors.push(`Question ${index+1}: choose mcq, matching or short_answer.`);
    else expanded.push({entry:entry?.question_type==='mcq'?Object.fromEntries(Object.entries(entry).filter(([key])=>key!=='question_type')):entry});
  }
  if (expanded.length > 2000) report.headerErrors.push('A batch may contain at most 2,000 questions, counting each matching label separately.');
  if (report.headerErrors.length) return report;
  const referenced = new Set<string>(), seen = new Set<string>();
  for (const [index, prepared] of expanded.entries()) {
    const entry=prepared.entry;
    const errors: string[] = [];
    const q = object(entry) ? entry : {};
    if (!object(entry)) errors.push('Each question must be a JSON object.');
    for (const k of Object.keys(q)) if (!allowed.has(k)) errors.push(`Unknown field "${k}". Check the JSON template.`);
    const getText = (k: string, fallback = '') => {
      const v = q[k] ?? fallback;
      if (typeof v !== 'string') { errors.push(`${k} must be text.`); return ''; }
      if (v.length > 30000) errors.push(`${k} exceeds 30,000 characters.`);
      return v;
    };
    const tags = (key: string) => {
      const v = q[key] ?? [];
      if (Array.isArray(v) && v.every(t => typeof t === 'string')) return parseSpecialTags(v.join(', ')).join(', ');
      if (typeof v === 'string') return parseSpecialTags(v).join(', ');
      errors.push(`${key} must be an array of tag names.`); return '';
    };
    const images = (key: string) => {
      const values = q[key] ?? [];
      if (!Array.isArray(values) || values.length > 4) { errors.push(`${key} must be an array of up to four image filenames or {file, alt} objects.`); return []; }
      return values.flatMap((v: any) => {
        const file = typeof v === 'string' ? v : v?.file;
        const alt = typeof v === 'string' ? '' : v?.alt ?? '';
        if (typeof file !== 'string' || !validImageFileName(file) || typeof alt !== 'string' || alt.length > 500 || (object(v) && Object.keys(v).some(k => !['file','alt'].includes(k)))) {
          errors.push(`${key}: use a local PNG/JPEG/WebP filename and optional alt text. Links and base64 are not accepted.`); return [];
        }
        referenced.add(file);
        if (!manifest.has(file)) errors.push(`Missing image file: ${file}. Select it with the image picker.`);
        return [{file,alt}];
      });
    };
    const imageFiles = images('images'), explanationImageFiles = images('explanation_images');
    let options: any = q.options;
    if (options !== undefined && !(Array.isArray(options) && options.length === 4) && !(object(options) && Object.keys(options).length === 4 && ['A','B','C','D'].every(k=>k in options))) errors.push('options must contain exactly A, B, C, D, or an array of four answers.');
    if (options !== undefined && ['option_a','option_b','option_c','option_d'].some(k=>k in q)) errors.push('Use options or option_a–option_d, not both.');
    const optionValues = ['A','B','C','D'].map((k,i) => {
      const v = options === undefined ? getText(`option_${k.toLowerCase()}`) : Array.isArray(options) ? options[i] : options?.[k];
      if (typeof v !== 'string') { errors.push(`Option ${k} must be text.`); return ''; }
      return v;
    });
    const page = q.page_number;
    if (page !== undefined && page !== null && (!Number.isInteger(page) || page <= 0)) errors.push('page_number must be a positive integer.');
    const values = [getText('subject', !Array.isArray(root) ? root.subject ?? '' : ''), getText('lecture', !Array.isArray(root) ? root.lecture ?? '' : ''), getText('question_text'), ...optionValues, getText('correct_answer'), getText('explanation'), ...['a','b','c','d'].map(k=>getText(`explanation_${k}`)), getText('difficulty','Medium'),tags('tags'),tags('special_tags'), page == null ? '' : String(page),getText('status','published')];
    const encode = (cells:string[])=>cells.map(v=>'"'+v.replace(/"/g,'""')+'"').join(',');
    const base = parseAndValidateCsvQuestions(columns.join(',')+'\n'+encode(values), new Set(), context).rows[0];
    if (!base) { report.headerErrors.push(`Question ${index+1} could not be parsed.`); continue; }
    errors.push(...base.errors);
    const imageHashes = [...imageFiles.map(f=>'q:'+manifest.get(f.file)),...explanationImageFiles.map(f=>'e:'+manifest.get(f.file))];
    const contentHash = imageHashes.length || prepared.matching ||prepared.shortAnswerDefinition ? computeContentHash(base.contentHash+'|'+imageHashes.join('|')+(prepared.matching?'|'+JSON.stringify(prepared.matching):'')+(prepared.shortAnswerDefinition?'|short-answer|'+JSON.stringify(prepared.shortAnswerDefinition):'')) : base.contentHash;
    const duplicate = seen.has(contentHash) || existingHashes.has(contentHash);
    if (duplicate) errors.push('Question already exists in this import or the question bank.');
    // Invalid entries must not prevent a later corrected entry from importing.
    if (!errors.length) seen.add(contentHash);
    const row = {...base,rowNumber:index+1,contentHash,imageFiles,explanationImageFiles,matching:prepared.matching,shortAnswerDefinition:prepared.shortAnswerDefinition,isValid:!errors.length,isDuplicate:duplicate,errors};
    report.rows.push(row);
    if (row.isValid) report.validCount++;
    else if (duplicate && errors.length === 1) report.duplicateCount++;
    else report.invalidCount++;
  }
  report.totalRows = expanded.length;
  report.referencedImages = [...referenced];
  report.unusedImages = files.map(f=>f.name).filter(n=>!referenced.has(n));
  // Include routing and image content in batch identity, while preserving JSON case.
  report.fileHash = computeContentHash(JSON.stringify([content, context, files.map(f=>[f.name,f.id])]));
  return report;
}

export function getSampleJsonTemplate(withImage = false): string {
  return JSON.stringify({subject:'Histology',lecture:'Cell structure',questions:[{
    question_text:withImage ? 'Identify the organelle marked by the arrow in the cell diagram.' : 'Which organelle modifies and sorts proteins for secretion?',
    options:{A:'Rough endoplasmic reticulum',B:'Golgi apparatus',C:'Peroxisome',D:'Smooth endoplasmic reticulum'},correct_answer:'B',
    explanation:'The Golgi apparatus modifies and sorts proteins for secretion.',difficulty:'Medium',tags:['Cell biology'],special_tags:['Important'],
    ...(withImage ? {images:[{file:'cell-diagram.png',alt:'Cell diagram with an organelle marked by an arrow'}]} : {}),status:'published'
  }]},null,2);
}
