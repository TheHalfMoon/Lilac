export const ARCHITECTURE_SCHEMA_VERSION = 1;

export const ARCHITECTURE_HARD_LIMITS = {
  maxSubsystems: 64,
  maxDependencies: 16,
  maxBoundaryLength: 1024,
} as const;

export const SUBSYSTEM_STATUSES = ["implemented", "stub", "planned"] as const;
export type SubsystemStatus = (typeof SUBSYSTEM_STATUSES)[number];

export interface SubsystemRecord {
  id: string;
  title: string;
  owner: string;
  status: SubsystemStatus;
  boundary: string;
  dependsOn: string[];
}

export interface ArchitectureMap {
  schemaVersion: number;
  subsystems: SubsystemRecord[];
}
