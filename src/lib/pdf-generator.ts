import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates a clean, valid standard PDF 1.4 binary file with multiple pages,
 * complete with titles, section headers, key points, clinical pearls, and page numbers.
 */
export function buildSimpleMultiPagePdf(params: {
  title: string;
  module: string;
  lectureNumber: number;
  pages: Array<{
    pageNumber: number;
    heading: string;
    subheading?: string;
    bulletPoints: string[];
    clinicalPearl?: string;
  }>;
}): Buffer {
  const objects: string[] = [];

  // Helper to add object and return its 1-based index
  function addObject(content: string): number {
    objects.push(content);
    return objects.length;
  }

  // 1: Catalog
  // 2: Pages container
  // 3: Font
  const catalogIdx = addObject('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesIdx = 2; // placeholder, updated later
  const fontIdx = 3;
  addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );
  const boldFontIdx = 4;
  addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  );

  const pageObjectIndices: number[] = [];

  for (const p of params.pages) {
    // Generate PDF text stream
    const lines: string[] = [];
    lines.push('BT');
    
    // Header Bar: MedAtlas MCQ & Module Name
    lines.push('/F2 10 Tf');
    lines.push('0.1 0.4 0.7 rg'); // Teal/Slate color
    lines.push('50 780 Td');
    lines.push(`(MEDATLAS MEDICAL CURRICULUM  |  ${escapePdf(params.module).toUpperCase()}) Tj`);
    lines.push('ET');

    // Lecture Title
    lines.push('BT');
    lines.push('/F2 16 Tf');
    lines.push('0.05 0.1 0.2 rg');
    lines.push('50 750 Td');
    lines.push(`(${escapePdf(params.title)}) Tj`);
    lines.push('ET');

    // Page Section Heading
    lines.push('BT');
    lines.push('/F2 13 Tf');
    lines.push('0.1 0.2 0.3 rg');
    lines.push('50 710 Td');
    lines.push(`(Page ${p.pageNumber}: ${escapePdf(p.heading)}) Tj`);
    lines.push('ET');

    if (p.subheading) {
      lines.push('BT');
      lines.push('/F1 11 Tf');
      lines.push('0.3 0.35 0.4 rg');
      lines.push('50 690 Td');
      lines.push(`(${escapePdf(p.subheading)}) Tj`);
      lines.push('ET');
    }

    // Horizontal line separator
    lines.push('0.85 0.88 0.92 RG');
    lines.push('1.5 w');
    lines.push('50 670 m 550 670 l S');

    // High Yield Points
    let yPos = 640;
    lines.push('BT');
    lines.push('/F2 11 Tf');
    lines.push('0.1 0.2 0.35 rg');
    lines.push(`50 ${yPos} Td`);
    lines.push('(High-Yield Clinical Concepts & Board Review Points:) Tj');
    lines.push('ET');
    yPos -= 25;

    for (const bullet of p.bulletPoints) {
      lines.push('BT');
      lines.push('/F1 10 Tf');
      lines.push('0.15 0.15 0.2 rg');
      lines.push(`60 ${yPos} Td`);
      lines.push(`(\\225  ${escapePdf(bullet)}) Tj`);
      lines.push('ET');
      yPos -= 22;
    }

    // Clinical Pearl box
    if (p.clinicalPearl) {
      yPos -= 15;
      lines.push('0.92 0.96 1.0 rg'); // Light blue box fill
      lines.push('0.2 0.5 0.8 RG'); // Border
      lines.push('1 w');
      lines.push(`50 ${yPos - 50} 500 65 re B`);

      lines.push('BT');
      lines.push('/F2 10 Tf');
      lines.push('0.05 0.3 0.6 rg');
      lines.push(`65 ${yPos - 12} Td`);
      lines.push('(CLINICAL PEARL & EXAM TRAP:) Tj');
      lines.push('ET');

      lines.push('BT');
      lines.push('/F1 9.5 Tf');
      lines.push('0.1 0.15 0.2 rg');
      lines.push(`65 ${yPos - 30} Td`);
      lines.push(`(${escapePdf(p.clinicalPearl)}) Tj`);
      lines.push('ET');
    }

    // Footer
    lines.push('0.85 0.88 0.92 RG');
    lines.push('1 w');
    lines.push('50 50 m 550 50 l S');

    lines.push('BT');
    lines.push('/F1 9 Tf');
    lines.push('0.4 0.45 0.5 rg');
    lines.push('50 35 Td');
    lines.push(`(MedAtlas Medical Education Platform  -  Lecture ${params.lectureNumber}) Tj`);
    lines.push('ET');

    lines.push('BT');
    lines.push('/F2 9 Tf');
    lines.push('0.2 0.3 0.4 rg');
    lines.push('510 35 Td');
    lines.push(`(Page ${p.pageNumber}) Tj`);
    lines.push('ET');

    const streamContent = lines.join('\n');
    const streamLen = Buffer.byteLength(streamContent, 'utf8');

    // Add Content Stream Object
    const streamIdx = addObject(
      `<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream`
    );

    // Add Page Object (MediaBox: 612 x 792 is standard US Letter / 8.5 x 11)
    const pageIdx = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamIdx} 0 R >>`
    );
    pageObjectIndices.push(pageIdx);
  }

  // Update object #2 (Pages container)
  const kidsStr = pageObjectIndices.map((idx) => `${idx} 0 R`).join(' ');
  objects[pagesIdx - 1] = `<< /Type /Pages /Kids [${kidsStr}] /Count ${pageObjectIndices.length} >>`;

  // Build final PDF with xref table
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIdx} 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

function escapePdf(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Keep development sample originals outside static assets.
 */
export function ensureSamplePdfsExist(): void {
  const publicDir = path.resolve(process.cwd(), 'private');
  const lecturesDir = path.join(publicDir, 'lecture-originals');

  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  if (!fs.existsSync(lecturesDir)) {
    fs.mkdirSync(lecturesDir, { recursive: true });
  }

  const sampleLectures = [
    {
      file: 'cardiology-acs.pdf',
      title: 'Ischemic Heart Disease & Acute Coronary Syndromes',
      module: 'Cardiology',
      lectureNumber: 1,
      pages: [
        {
          pageNumber: 1,
          heading: 'Coronary Atherosclerosis & Plaque Vulnerability',
          subheading: 'Pathogenesis of Thin-Cap Fibroatheroma (TCFA)',
          bulletPoints: [
            'Endothelial injury leads to LDL accumulation, oxidation, and macrophage foam-cell formation.',
            'Fibrous cap thinning is mediated by macrophage matrix metalloproteinases (MMP-1, MMP-9, MMP-13).',
            'Plaque rupture triggers immediate exposure of tissue factor and subendothelial collagen to circulating blood.',
            'Platelet adhesion occurs via glycoprotein Ib-IX to von Willebrand factor (vWF).',
          ],
          clinicalPearl:
            'Atherosclerotic plaques with core necrotic areas >25% and caps <65 microns are at highest risk of acute rupture.',
        },
        {
          pageNumber: 2,
          heading: 'STEMI vs NSTEMI Biomarkers & ECG Localization',
          subheading: 'Troponin Kinetics and Coronary Vessel Territories',
          bulletPoints: [
            'ST elevations in II, III, aVF localize acute transmural ischemia to the inferior wall (RCA in 85%).',
            'ST elevations in V1-V4 indicate anterior wall infarction via the Left Anterior Descending (LAD) artery.',
            'Cardiac troponin I and T rise within 2-4 hours, peak at 24 hours, and stay elevated for up to 10-14 days.',
            'Creatine kinase-MB (CK-MB) returns to baseline within 48-72 hours, making it ideal for detecting reinfarction.',
          ],
          clinicalPearl:
            'In inferior STEMI, always obtain right-sided ECG leads (V4R) to rule out Right Ventricular Infarction before administering nitrates.',
        },
        {
          pageNumber: 3,
          heading: 'Medical Management & Revascularization Timing',
          subheading: 'Antiplatelet, Anticoagulant, and PCI Protocols',
          bulletPoints: [
            'Door-to-balloon time goal for primary PCI is <90 minutes at PCI-capable centers, or <120 minutes if transferred.',
            'Dual antiplatelet therapy (DAPT): Aspirin plus a P2Y12 inhibitor (Ticagrelor or Prasugrel preferred over Clopidogrel).',
            'Beta-blockers reduce myocardial oxygen demand and ventricular arrhythmia risk within the first 24 hours.',
            'High-intensity statin therapy (Atorvastatin 80 mg or Rosuvastatin 40 mg) must be initiated regardless of baseline LDL.',
          ],
          clinicalPearl:
            'Contraindications to early beta-blocker therapy include signs of acute heart failure, low output state, PR interval >0.24s, or cardiogenic shock risk.',
        },
        {
          pageNumber: 4,
          heading: 'Mechanical Complications of Myocardial Infarction',
          subheading: 'Day 3 to 7 Post-Infarction Structural Failures',
          bulletPoints: [
            'Papillary muscle rupture (days 3-5): Causes acute severe mitral regurgitation, holosystolic murmur, and pulmonary edema.',
            'Interventricular septum rupture (days 3-5): Presents with harsh holosystolic murmur with thrill at left sternal border and oxygen step-up in RV.',
            'Free wall rupture (days 5-14): Leads to sudden hemopericardium, cardiac tamponade, electromechanical dissociation, and death.',
            'Ventricular pseudoaneurysm: Contained by pericardium/thrombus; requires emergent surgical repair due to high rupture risk.',
          ],
          clinicalPearl:
            'Posteromedial papillary muscle has a single blood supply (posterior descending artery from RCA), making it far more vulnerable to ischemic rupture than the dual-supplied anterolateral muscle.',
        },
      ],
    },
    {
      file: 'cardiology-arrhythmias.pdf',
      title: 'Arrhythmias & Cardiac Electrophysiology',
      module: 'Cardiology',
      lectureNumber: 2,
      pages: [
        {
          pageNumber: 1,
          heading: 'Supraventricular Tachycardias & AV Nodal Reentry',
          subheading: 'AVNRT, AVRT, and Orthodromic vs Antidromic Conduction',
          bulletPoints: [
            'AVNRT involves dual AV nodal pathways: a slow pathway with short refractory period and a fast pathway with long refractory period.',
            'Vagal maneuvers and IV Adenosine transiently block the AV node to terminate reentrant SVTs.',
            'Wolff-Parkinson-White (WPW) syndrome features an accessory pathway (Bundle of Kent) producing a short PR interval, delta wave, and wide QRS.',
          ],
          clinicalPearl:
            'In WPW with pre-excited atrial fibrillation, AV nodal blockers (adenosine, beta-blockers, verapamil, digoxin) are strictly CONTRAINDICATED as they accelerate conduction down the accessory pathway into VF.',
        },
        {
          pageNumber: 2,
          heading: 'Ventricular Tachycardia & Channelopathies',
          subheading: 'Monomorphic vs Polymorphic VT and Torsades de Pointes',
          bulletPoints: [
            'Sustained monomorphic VT in patients with prior myocardial infarction is almost always due to scar-related macroreentry.',
            'Torsades de Pointes occurs in the setting of prolonged QT interval (>500 ms) and is treated acutely with IV Magnesium Sulfate.',
            'Brugada syndrome: Autosomal dominant SCN5A mutation causing coved ST elevation in V1-V3 with risk of sudden cardiac death.',
          ],
          clinicalPearl:
            'Synchronized cardioversion is used for hemodynamically unstable VT with a pulse; defibrillation (unsynchronized) is mandatory for pulseless VT or ventricular fibrillation.',
        },
      ],
    },
    {
      file: 'pulmonology-obstructive-restrictive.pdf',
      title: 'Obstructive vs Restrictive Lung Diseases',
      module: 'Pulmonology',
      lectureNumber: 1,
      pages: [
        {
          pageNumber: 1,
          heading: 'Spirometry Diagnostics & Flow-Volume Loops',
          subheading: 'FEV1, FVC, and Diffusion Capacity (DLCO) Differentiation',
          bulletPoints: [
            'Obstructive lung defect: FEV1/FVC ratio <0.70 post-bronchodilator. Residual volume (RV) and TLC are increased.',
            'Restrictive lung defect: FEV1/FVC normal or increased (>0.70), but Total Lung Capacity (TLC) is <80% of predicted.',
            'DLCO is decreased in Emphysema due to alveolar capillary wall destruction, but NORMAL in chronic bronchitis and asthma.',
            'In restrictive disease, DLCO is decreased in intrinsic parenchymal fibrosis (IPF), but NORMAL in chest wall/neuromuscular weakness.',
          ],
          clinicalPearl:
            'A bronchodilator response is positive if FEV1 or FVC increases by >=12% AND >=200 mL following inhaled albuterol.',
        },
        {
          pageNumber: 2,
          heading: 'COPD Exacerbation Management & Oxygen Targets',
          subheading: 'Antibiotics, Systemic Corticosteroids, and Non-Invasive Ventilation',
          bulletPoints: [
            'Controlled oxygen therapy in acute COPD exacerbations targets an SpO2 of 88-92% to avoid hypercapnic respiratory drive suppression and V/Q mismatch.',
            'Non-invasive positive pressure ventilation (BiPAP) is first-line for acute hypercapnic respiratory failure (pH <7.35, PaCO2 >45 mmHg).',
            'Five-day systemic corticosteroid course (Prednisone 40 mg daily) accelerates recovery and reduces treatment failure.',
            'Antibiotics are indicated when patients have at least 2 cardinal symptoms (increased sputum volume, increased purulence, increased dyspnea).',
          ],
          clinicalPearl:
            'Macrolides (Azithromycin) or Doxycycline are preferred first-line outpatient oral agents for mild-to-moderate COPD exacerbations.',
        },
      ],
    },
    {
      file: 'neurology-stroke.pdf',
      title: 'Stroke Syndromes & Cerebrovascular Anatomy',
      module: 'Neurology',
      lectureNumber: 1,
      pages: [
        {
          pageNumber: 1,
          heading: 'Anterior vs Posterior Circulation Stroke Syndromes',
          subheading: 'MCA, ACA, and PCA Vascular Territory Manifestations',
          bulletPoints: [
            'Middle Cerebral Artery (MCA): Contralateral hemiparesis and hemisensory loss affecting face and arm > leg, plus aphasia (dominant hemisphere) or hemineglect (non-dominant hemisphere).',
            'Anterior Cerebral Artery (ACA): Contralateral hemiparesis and hemisensory loss affecting the lower extremity > upper extremity/face, often with urinary incontinence and abulia.',
            'Posterior Cerebral Artery (PCA): Contralateral homonymous hemianopia with macular sparing, alexia without agraphia (splenium of corpus callosum involvement).',
          ],
          clinicalPearl:
            'Pure motor stroke or pure sensory stroke suggests a lacunar infarct involving the posterior limb of the internal capsule or thalamus, respectively, commonly caused by lipohyalinosis.',
        },
        {
          pageNumber: 2,
          heading: 'Acute Ischemic Stroke Thrombolysis & Thrombectomy',
          subheading: 'Alteplase / Tenecteplase Time Windows and Mechanical Intervention',
          bulletPoints: [
            'IV thrombolysis (tPA / Tenecteplase) is approved within 4.5 hours of symptom onset in eligible patients without hemorrhage on non-contrast head CT.',
            'Blood pressure must be lowered to <185/110 mmHg prior to thrombolysis and maintained <180/105 mmHg for 24 hours post-infusion (using Labetalol or Nicardipine).',
            'Endovascular mechanical thrombectomy is indicated within 24 hours for large vessel occlusions (internal carotid artery or M1 segment of MCA).',
          ],
          clinicalPearl:
            'Absolute contraindications to IV thrombolysis include active internal bleeding, recent intracranial surgery or head trauma within 3 months, history of intracranial hemorrhage, and platelet count <100,000.',
        },
      ],
    },
  ];

  for (const lec of sampleLectures) {
    const targetFile = path.join(lecturesDir, lec.file);
    if (!fs.existsSync(targetFile)) {
      const buffer = buildSimpleMultiPagePdf(lec);
      fs.writeFileSync(targetFile, buffer);
    }
  }
}
