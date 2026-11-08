import type { Category, Project } from './types';

const palette = ['blue', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red', 'grey'] as const;

export function categoryColor(
  category: Pick<Category, 'color' | 'order'>,
): chrome.tabGroups.TabGroup['color'] {
  return category.color || palette[category.order % palette.length] || 'grey';
}

export function categoryColorStyle(
  category: Pick<Category, 'color' | 'order' | 'displayColor'>,
): string {
  return category.displayColor || `var(--category-${categoryColor(category)})`;
}

export function projectColorStyle(project: Pick<Project, 'id' | 'displayColor'>): string {
  let hash = 0;
  for (const character of project.id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return project.displayColor || `var(--category-${palette[Math.abs(hash) % palette.length]})`;
}
