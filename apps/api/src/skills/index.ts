/**
 * Import all skill modules to trigger self-registration with fileSkillRegistry.
 * This file must be imported at startup.
 */
import './pdf-skill';
import './image-skill';
import './docx-skill';
import './xlsx-skill';
import './pptx-skill';

export { fileSkillRegistry } from './registry';
export { BaseFileSkill, type FileSkillResult } from './base-skill';
