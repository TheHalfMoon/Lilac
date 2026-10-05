import type { AdapterResult, ImportArtifact, ImportProposal, ImportRequest } from "./types.ts";

export interface ExternalCrawlerConnector {
  readonly connectorId: string;
  capture(request: ImportRequest): Promise<AdapterResult<ImportArtifact>>;
}

export interface VisualImportOperator {
  readonly operatorId: string;
  propose(request: ImportRequest, artifact: ImportArtifact): Promise<AdapterResult<ImportProposal>>;
}

export const IMPORT_CONNECTOR_BOUNDARY = Object.freeze({
  firecrawl: "external-connector-only",
  uiTars: "optional-visual-operator-only",
});
