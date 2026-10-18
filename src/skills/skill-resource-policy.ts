/** Only discard known rebuildable resources; unfamiliar files remain part of the package. */
export function isRebuildableSkillResource(name: string): boolean {
  return name === '__pycache__' || name.endsWith('.pyc')
}
