import { repairImportedSessionsInHome } from '@moonshot-ai/migration-legacy';

/**
 * Silent startup/resume repair for sessions imported by a pre-0.40.0
 * migrator. Must never throw, never re-prompt migration, and never block
 * TUI / web / print startup.
 */
export async function repairImportedSessionsAtStartup(targetHome: string): Promise<void> {
  try {
    await repairImportedSessionsInHome(targetHome);
  } catch {
    // ignore
  }
}
