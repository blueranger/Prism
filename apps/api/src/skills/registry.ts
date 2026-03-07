import { BaseFileSkill } from './base-skill';

/**
 * FileSkillRegistry — central registry for all file processing skills.
 *
 * Skills self-register at import time. The FileAnalysisAgent queries
 * the registry to find the appropriate skill for a given MIME type.
 */
class FileSkillRegistry {
  private skills: BaseFileSkill[] = [];

  register(skill: BaseFileSkill): void {
    console.log(`[FileSkillRegistry] Registered skill: ${skill.name} (${skill.supportedMimeTypes.join(', ')})`);
    this.skills.push(skill);
  }

  /**
   * Find a skill that can handle the given MIME type.
   * Returns undefined if no skill matches.
   */
  findSkill(mimeType: string): BaseFileSkill | undefined {
    return this.skills.find((s) => s.canHandle(mimeType));
  }

  /**
   * List all registered skills.
   */
  list(): BaseFileSkill[] {
    return [...this.skills];
  }

  /**
   * Get all supported MIME types across all skills.
   */
  supportedMimeTypes(): string[] {
    const types = new Set<string>();
    for (const skill of this.skills) {
      for (const mt of skill.supportedMimeTypes) {
        types.add(mt);
      }
    }
    return Array.from(types);
  }
}

export const fileSkillRegistry = new FileSkillRegistry();
