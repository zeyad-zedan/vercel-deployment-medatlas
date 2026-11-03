/** Treat casing/spacing variants of a module code as one student-facing filter. */
export function groupLectureModules(modules: {id: number; code?: string; title?: string}[]) {
  const groups = new Map<string, { id: number; label: string; moduleIds: number[] }>();
  for (const module of modules) {
    const label = (module.code || module.title || `Module ${module.id}`).trim();
    const key = module.code ? label.replace(/\s+/g, '').toLocaleUpperCase() : `module:${module.id}`;
    const group = groups.get(key);
    if (group) group.moduleIds.push(module.id);
    else groups.set(key, { id: module.id, label: module.code ? label.toLocaleUpperCase() : label, moduleIds: [module.id] });
  }
  return [...groups.values()];
}
