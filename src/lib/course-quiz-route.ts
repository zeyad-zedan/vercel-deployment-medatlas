export function courseQuizSlug(pathname:string):string|null {
 return pathname.match(/^\/impulse\/quiz\/([A-Za-z0-9_-]{20,64})\/?$/)?.[1]??null;
}
