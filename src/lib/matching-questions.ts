export interface MatchingChoice { id: string; text: string }
export interface MatchingQuestionDefinition {
  groupId: string;
  number: string;
  prompt: string;
  choices: MatchingChoice[];
  correctChoiceId?: string;
}

export function matchingGrade(matching: MatchingQuestionDefinition, choiceId: unknown): 'A' | 'B' | null {
  if (choiceId == null || choiceId === '') return null;
  if (typeof choiceId !== 'string' || !matching.choices.some(choice => choice.id === choiceId)) throw new Error('Choose a valid matching answer.');
  if (!matching.correctChoiceId) throw new Error('This matching question has no answer key.');
  // The existing score engine uses A/B only as correct/incorrect classifications.
  // The actual selected choice is always stored separately and validated on the server.
  return choiceId === matching.correctChoiceId ? 'A' : 'B';
}

export function expandMatchingQuestion(entry: any, groupId: string) {
  if (!Array.isArray(entry.matches) || entry.matches.length < 1 || entry.matches.length > 30) throw new Error('Matching images need 1–30 numbered labels.');
  if (!Array.isArray(entry.images) || entry.images.length !== 1) throw new Error('A matching group needs exactly one numbered image.');
  if (typeof entry.question_text !== 'string' || !entry.question_text.trim()) throw new Error('Add instructions for this matching image.');
  const numbers = new Set<string>();
  const pairs = entry.matches.map((pair: any) => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).some(key => !['number','answer','explanation'].includes(key))) throw new Error('Each match needs number, answer, and optional explanation.');
    const number = String(pair.number ?? '').trim().toUpperCase();
    if (!/^[1-9]\d{0,2}[A-Za-z]?$/.test(number) || numbers.has(number)) throw new Error('Use unique numbered labels such as 1, 2, or 3A.');
    numbers.add(number);
    if (typeof pair.answer !== 'string' || !pair.answer.trim() || pair.answer.length > 300) throw new Error(`Label ${number} needs an answer of up to 300 characters.`);
    if (pair.explanation !== undefined && (typeof pair.explanation !== 'string' || pair.explanation.length > 30000)) throw new Error(`Label ${number} has an invalid explanation.`);
    return {number,answer:pair.answer.trim(),explanation:pair.explanation};
  });
  const distractors = entry.distractors ?? [];
  if (!Array.isArray(distractors) || distractors.length > 20 || distractors.some((item: any) => typeof item !== 'string' || !item.trim() || item.length > 300)) throw new Error('Use up to 20 extra answer names.');
  const unique = new Map<string,string>();
  for (const text of [...pairs.map((pair: any)=>pair.answer),...distractors.map((text:string)=>text.trim())]) unique.set(text.normalize('NFC').toLocaleLowerCase(),text);
  // Alphabetical choices cannot reveal the key by mirroring numbered-label order.
  const choices = [...unique.values()].sort((a,b)=>a.localeCompare(b)).map((text,index)=>({id:`c${index+1}`,text}));
  if (choices.length < 2) throw new Error('Add at least two different answer names, including extra choices if necessary.');
  return pairs.map((pair: any) => ({
    entry: Object.fromEntries(Object.entries({...entry,question_text:`${entry.question_text.trim()} — Label ${pair.number}`,
      options:{A:'Correct match',B:'Incorrect match',C:'Unanswered',D:'Unavailable'},correct_answer:'A',
      explanation:pair.explanation?.trim() || entry.explanation?.trim() || `Label ${pair.number} identifies ${pair.answer}.`}).filter(([key])=>!['question_type','matches','distractors'].includes(key))),
    matching: {groupId,number:pair.number,prompt:entry.question_text.trim(),choices,
      correctChoiceId:choices.find(choice=>choice.text.normalize('NFC').toLocaleLowerCase()===pair.answer.normalize('NFC').toLocaleLowerCase())!.id} as MatchingQuestionDefinition,
  }));
}

export function getMatchingJsonTemplate(image = 'numbered-bone.png') {
  return {question_type:'matching',question_text:'Match each numbered bone landmark with its name.',images:[image],
    matches:[{number:'1',answer:'Head',explanation:'The rounded head forms the joint.'},{number:'2',answer:'Neck'},{number:'3',answer:'Shaft'}],
    distractors:['Condyle'],difficulty:'Medium',tags:['Anatomy'],status:'draft'};
}
