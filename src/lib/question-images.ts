/** Only references live in PostgreSQL. Image bytes are stored on Telegram. */
export interface QuestionImage {
  id: string;
  alt: string;
  telegramFileId?: string;
  mimeType?: string;
  fileSize?: number;
  source?: string;
}

export interface ImportImageFile { name: string; id: string }
export const MAX_QUESTION_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_IMAGES = 100;
export const QUESTION_IMAGE_PREFIX = '/api/question-images/';

export function validImageFileName(name: string): boolean {
  return name.length <= 180 && !/[\\/\x00-\x1f]/.test(name) && /\.(png|jpe?g|webp)$/i.test(name);
}
